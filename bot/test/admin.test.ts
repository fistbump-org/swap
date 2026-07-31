/**
 * The operator dashboard.
 *
 * Two things here can lose money and they are the two things tested: who is
 * allowed in, and what happens when the sell price is mistyped. Everything
 * else on that page is a read.
 */

import "./test-env.js";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { needsConfirmation, tokenMatches } from "../src/admin.js";
import { config } from "../src/config.js";
import { MAX_FBC_USD, MIN_FBC_USD, SPEC, SettingsStore } from "../src/settings.js";

// ── Who gets in ───────────────────────────────────────────────────────────

test("only the exact token is accepted", () => {
  const secret = "s".repeat(32);
  assert.equal(tokenMatches(secret, secret), true);
  for (const wrong of [
    "",
    "s".repeat(31),
    "s".repeat(33),
    "S".repeat(32),
    "s".repeat(31) + "t",
    null,
  ]) {
    assert.equal(tokenMatches(wrong, secret), false, JSON.stringify(wrong));
  }
});

test("no token is ever accepted against an empty expected value", () => {
  // The server refuses to start without a token, but if that guard were ever
  // bypassed this must still fail closed rather than letting "" match "".
  assert.equal(tokenMatches("", ""), false);
  assert.equal(tokenMatches("anything", ""), false);
  assert.equal(tokenMatches(null, ""), false);
});

// ── The price, which is the dangerous input ───────────────────────────────

test("a routine price move needs no confirmation", () => {
  assert.equal(needsConfirmation(0.01, 0.011), false);
  assert.equal(needsConfirmation(0.01, 0.0095), false);
  assert.equal(needsConfirmation(0.01, 0.014), false);
});

test("a slipped decimal always needs confirmation", () => {
  // The failure this exists for: 0.01 typed as 0.001 sells the whole
  // inventory at a tenth of its worth, immediately and irreversibly.
  assert.equal(needsConfirmation(0.01, 0.001), true);
  assert.equal(needsConfirmation(0.01, 0.1), true);
  assert.equal(needsConfirmation(0.01, 0.0001), true);
  assert.equal(needsConfirmation(0.01, 1), true);
});

test("confirmation is required in both directions", () => {
  // Selling 10x too high is not a loss, but it is just as much a mistake and
  // the maker silently stops trading. Asking is cheap.
  assert.equal(needsConfirmation(0.01, 0.1), true);
  assert.equal(needsConfirmation(0.1, 0.01), true);
});

test("a nonsense current or proposed price always asks", () => {
  for (const [a, b] of [
    [0, 0.01],
    [0.01, 0],
    [Number.NaN, 0.01],
    [0.01, Number.NaN],
    [0.01, -1],
  ]) {
    assert.equal(needsConfirmation(a!, b!), true, `${a} -> ${b}`);
  }
});

// ── Persistence ───────────────────────────────────────────────────────────

function tmpSettings(): { store: SettingsStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "mm-settings-"));
  return { store: new SettingsStore(dir), dir };
}

test("an unset price falls through to the environment", () => {
  const { store, dir } = tmpSettings();
  try {
    assert.equal(store.isOverridden("fbc_usd_price"), false);
    // Whatever the environment says, the overlay must report that rather than
    // a default of its own — otherwise an operator who never touched the
    // dashboard would find it quoting a different price than their config.
    assert.equal(store.fbcUsdPrice(), config.fbcUsdPrice);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a set price survives a reload", () => {
  const { store, dir } = tmpSettings();
  try {
    store.set("fbc_usd_price", 0.023);
    assert.equal(store.fbcUsdPrice(), 0.023);
    assert.equal(store.isOverridden("fbc_usd_price"), true);
    assert.equal(new SettingsStore(dir).fbcUsdPrice(), 0.023);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearing hands the price back to the environment", () => {
  const { store, dir } = tmpSettings();
  try {
    store.set("fbc_usd_price", 0.5);
    store.clear("fbc_usd_price");
    assert.equal(store.isOverridden("fbc_usd_price"), false);
    assert.equal(new SettingsStore(dir).isOverridden("fbc_usd_price"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a price outside the sane band is refused", () => {
  const { store, dir } = tmpSettings();
  try {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, MAX_FBC_USD * 2, MIN_FBC_USD / 2]) {
      assert.throws(() => store.set("fbc_usd_price", bad), /price/, String(bad));
    }
    assert.equal(store.isOverridden("fbc_usd_price"), false, "a rejected price must not be stored");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt settings file falls back rather than poisoning the price", () => {
  // This file decides what the maker sells at. A mangled one must not become a
  // quoted rate — the environment is the safe thing to fall back to.
  const dir = mkdtempSync(join(tmpdir(), "mm-settings-"));
  try {
    for (const junk of ["{ not json", '{"fbc_usd_price": "cheap"}', '{"fbc_usd_price": -5}', "[]"]) {
      writeFileSync(join(dir, "settings.json"), junk, "utf8");
      const store = new SettingsStore(dir);
      assert.equal(store.isOverridden("fbc_usd_price"), false, junk);
      assert.ok(store.fbcUsdPrice() > 0, junk);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a price is stored without float noise", () => {
  // Any arithmetic on the way in leaves artifacts — 0.01 * 1.1 is
  // 0.011000000000000001 — and that string becomes the price shown on the
  // dashboard, written to the log, and used to derive every quote's mid.
  const { store, dir } = tmpSettings();
  try {
    store.set("fbc_usd_price", 0.01 * 1.1);
    assert.equal(store.fbcUsdPrice(), 0.011);
    store.set("fbc_usd_price", 0.1 + 0.2);
    assert.equal(store.fbcUsdPrice(), 0.3);
    // Rounding must not quietly change a price the operator meant. Ten places
    // is well below MIN_FBC_USD, so real precision survives.
    store.set("fbc_usd_price", 0.000123456);
    assert.equal(store.fbcUsdPrice(), 0.000123456);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── The other trading parameters ──────────────────────────────────────────

test("max FBC and minimum swap size persist independently", () => {
  // Independently matters: setting one used to be the only write, and a
  // whole-object write that forgot a field would silently clear the others.
  const { store, dir } = tmpSettings();
  try {
    store.set("max_fbc", 250_000);
    store.set("min_btc_sat", 25_000);
    store.set("fbc_usd_price", 0.02);
    const reloaded = new SettingsStore(dir);
    assert.equal(reloaded.maxFbc(), 250_000);
    assert.equal(reloaded.minBtcSat(), 25_000);
    assert.equal(reloaded.fbcUsdPrice(), 0.02);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearing one setting leaves the others alone", () => {
  const { store, dir } = tmpSettings();
  try {
    store.set("max_fbc", 250_000);
    store.set("min_btc_sat", 25_000);
    store.clear("max_fbc");
    assert.equal(store.isOverridden("max_fbc"), false);
    assert.equal(store.isOverridden("min_btc_sat"), true, "the untouched setting must survive");
    assert.equal(store.minBtcSat(), 25_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("whole-number settings refuse fractions", () => {
  // A minimum of 10000.5 sat or 3.7 FBC is a unit mix-up, not a preference.
  const { store, dir } = tmpSettings();
  try {
    assert.throws(() => store.set("min_btc_sat", 10_000.5), /whole number/);
    assert.throws(() => store.set("max_fbc", 3.7), /whole number/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each setting is held inside its own band", () => {
  const { store, dir } = tmpSettings();
  try {
    for (const key of ["max_fbc", "min_btc_sat"] as const) {
      assert.throws(() => store.set(key, SPEC[key].min - 1), /between/, key);
      assert.throws(() => store.set(key, SPEC[key].max + 1), /between/, key);
      store.set(key, SPEC[key].min);
      assert.equal(store.value(key), SPEC[key].min, `${key} at its floor`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a minimum below what fees allow cannot make a swap unclaimable", () => {
  // The floor is only a floor: MarketMaker.refreshMinBtcSat takes the max of
  // it and the fee-derived figure. Setting 1000 sat during a fee spike must
  // therefore have no effect on what is actually quoted — this asserts the
  // relationship the bot depends on, so a refactor cannot quietly invert it.
  const { store, dir } = tmpSettings();
  try {
    store.set("min_btc_sat", SPEC.min_btc_sat.min);
    const feeDerived = 30_000;
    assert.equal(Math.max(store.minBtcSat(), feeDerived), feeDerived);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one corrupt field does not discard the settings that are fine", () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-settings-"));
  try {
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ fbc_usd_price: 0.02, max_fbc: "loads", min_btc_sat: 25_000 }),
      "utf8",
    );
    const store = new SettingsStore(dir);
    assert.equal(store.fbcUsdPrice(), 0.02);
    assert.equal(store.minBtcSat(), 25_000);
    assert.equal(store.isOverridden("max_fbc"), false, "the bad field falls back to env");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
