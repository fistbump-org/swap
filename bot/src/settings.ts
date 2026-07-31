/**
 * Operator settings that can change without a restart.
 *
 * Everything in `config` comes from the environment and is fixed for the life
 * of the process — right for things an operator sets once (which node, which
 * wallet, what the timelock margins are). The trading parameters are not those.
 * They are the numbers a maker most wants to move, and making them edit a
 * systemd unit and restart the bot to move one is the reason none of them ever
 * get moved.
 *
 * So this is a small persisted overlay: absent means "use the environment",
 * present means "the operator set this deliberately". Absent is not the same
 * as equal-to-the-default, which is why the file stores nulls — a maker who has
 * never touched a value and one who set it to the same number as the env are
 * different states, and only the second should survive an env change.
 *
 * Written atomically, because a torn settings file on a power cut would take
 * the bot down at the next start, and the whole point is that this is safe to
 * touch while running.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { config } from "./config.js";

/**
 * What may be set, and the band each value has to land in.
 *
 * The bands are deliberately wide. They exist to catch a slipped decimal or a
 * unit mix-up — the mistakes that are silent and expensive — not to have an
 * opinion about how anyone should run their book.
 */
export const SPEC = {
  /**
   * USD per 1 FBC. The single most dangerous input on the dashboard: it
   * decides how much FBC a satoshi buys, so a fat-fingered 0.0001 sells the
   * whole inventory for a hundredth of its worth, immediately and
   * irreversibly.
   */
  fbc_usd_price: { min: 0.000_001, max: 1_000, integer: false, from: () => config.fbcUsdPrice },
  /** Largest FBC any one swap may take, in whole FBC. */
  max_fbc: { min: 1, max: 1_000_000_000, integer: true, from: () => config.maxFbc },
  /**
   * Smallest swap in satoshis — a FLOOR, not the number actually enforced.
   * The fee market raises it (see MarketMaker.refreshMinBtcSat), because an
   * HTLC too small to pay for its own claim is worse than no swap. Setting
   * this below what fees allow simply has no effect; it cannot make the bot
   * quote something unclaimable.
   */
  min_btc_sat: { min: 1_000, max: 100_000_000, integer: true, from: () => config.minBtcSat },
} as const;

export type SettingKey = keyof typeof SPEC;

export type Settings = {
  [K in SettingKey]: number | null;
} & { updated_at: number | null };

// Kept for the callers that predate the generalised store.
export const MIN_FBC_USD = SPEC.fbc_usd_price.min;
export const MAX_FBC_USD = SPEC.fbc_usd_price.max;

const KEYS = Object.keys(SPEC) as SettingKey[];

function empty(): Settings {
  const s = { updated_at: null } as Settings;
  for (const k of KEYS) s[k] = null;
  return s;
}

export class SettingsStore {
  private path: string;
  private cache: Settings;

  constructor(dataDir = config.dataDir) {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, "settings.json");
    this.cache = this.load();
  }

  private load(): Settings {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return empty();
    }
    let parsed: Partial<Settings>;
    try {
      parsed = JSON.parse(raw) as Partial<Settings>;
    } catch {
      return empty();
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty();
    const out = empty();
    for (const k of KEYS) {
      const v = parsed[k];
      // A value outside its band, or of the wrong type, falls back to the
      // environment rather than propagating. These numbers set what the bot
      // quotes; a mangled file must not become a live trading parameter.
      if (typeof v === "number" && this.valid(k, v)) out[k] = v;
    }
    out.updated_at = typeof parsed.updated_at === "number" ? parsed.updated_at : null;
    return out;
  }

  private valid(key: SettingKey, value: number): boolean {
    const spec = SPEC[key];
    if (!Number.isFinite(value)) return false;
    if (spec.integer && !Number.isInteger(value)) return false;
    return value >= spec.min && value <= spec.max;
  }

  get(): Settings {
    return { ...this.cache };
  }

  /** The value in force: the override if set, else the environment. */
  value(key: SettingKey): number {
    return this.cache[key] ?? SPEC[key].from();
  }

  /** True when the value in force came from the operator rather than the env. */
  isOverridden(key: SettingKey): boolean {
    return this.cache[key] !== null;
  }

  set(key: SettingKey, value: number): void {
    const spec = SPEC[key];
    if (!Number.isFinite(value)) throw new Error(`${key} must be a number`);
    if (spec.integer && !Number.isInteger(value)) {
      throw new Error(`${key} must be a whole number, got ${value}`);
    }
    if (value < spec.min || value > spec.max) {
      throw new Error(`${key} must be between ${spec.min} and ${spec.max}, got ${value}`);
    }
    // Round before storing. A value that arrived through any arithmetic carries
    // float noise — 0.01 × 1.1 is 0.011000000000000001 — and that string then
    // becomes the number on the dashboard, in the logs, and in the mid every
    // quote is derived from. Ten places is far below any `min` here, so this
    // cannot round a legitimate value into a different one.
    const clean = spec.integer ? Math.round(value) : Number(value.toFixed(10));
    this.write({ ...this.cache, [key]: clean, updated_at: Date.now() });
  }

  /** Hand one value back to the environment. */
  clear(key: SettingKey): void {
    this.write({ ...this.cache, [key]: null, updated_at: Date.now() });
  }

  // ── Named accessors, for the hot paths ──────────────────────────────────
  //
  // The pricing and quoting code reads these on every request; a string key
  // there would be one typo away from silently falling back to the env.

  fbcUsdPrice(): number {
    return this.value("fbc_usd_price");
  }
  maxFbc(): number {
    return this.value("max_fbc");
  }
  minBtcSat(): number {
    return this.value("min_btc_sat");
  }

  private write(next: Settings): void {
    // Write-then-rename: a crash mid-write leaves either the old file or the
    // new one, never half of either.
    const tmp = `${this.path}.tmp`;
    // 0600 for consistency with the swap store. Nothing secret lives here
    // today, but these are the numbers the bot trades on and a file anyone can
    // read is a file someone will eventually try to write.
    writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.path);
    this.cache = next;
  }
}

/**
 * The process-wide instance.
 *
 * A singleton because the quote path needs the current values on every request
 * and threading a store through it would mean changing every caller for values
 * that are genuinely global. Tests construct their own against a temp dir.
 */
export const settings = new SettingsStore();
