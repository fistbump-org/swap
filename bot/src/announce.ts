import { config } from "./config.js";
import { SERVED_SIDES } from "./roles.js";

/**
 * Heartbeat to the public maker registry so the Auto UI can discover this bot.
 * Registry verifies GET {PUBLIC_URL}/health before listing.
 */
export function startAnnouncing() {
  if (!config.announce) {
    console.log("[announce] disabled (ANNOUNCE=0)");
    return;
  }
  if (!config.publicUrl) {
    console.warn(
      "[announce] PUBLIC_URL not set — this bot will not appear in the UI directory",
    );
    return;
  }
  if (!config.registryUrl) {
    console.warn("[announce] REGISTRY_URL empty — skip");
    return;
  }
  if (!config.announceToken) {
    console.warn(
      "[announce] ANNOUNCE_TOKEN not set — this bot will not appear in the UI directory. " +
        "Generate one (openssl rand -hex 16); the registry uses it to prove you control PUBLIC_URL.",
    );
    return;
  }

  const body = {
    url: config.publicUrl.replace(/\/+$/, ""),
    name: config.makerName || config.publicUrl.replace(/^https?:\/\//, ""),
    side: SERVED_SIDES,
    protocol: "fistbump-swap-mm/v1",
    note: "",
  };

  let inFlight = false;
  let consecutiveFailures = 0;

  const tick = async () => {
    // The registry can be slow or unreachable; without this an interval
    // shorter than the timeout would pile up overlapping requests.
    if (inFlight) return;
    inFlight = true;
    try {
      const res = await fetch(`${config.registryUrl}/v1/makers/announce`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Proves we control PUBLIC_URL: the registry hashes this and compares
          // against the announce_id we publish at /health. Also non-simple, so
          // a web page cannot drive a browser into announcing on our behalf.
          "X-Fistbump-Announce-Token": config.announceToken,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(ANNOUNCE_TIMEOUT_MS),
      });
      const text = await res.text();
      let json: { error?: string; ttl_sec?: number } = {};
      try {
        json = JSON.parse(text);
      } catch {
        /* ignore */
      }
      if (!res.ok) {
        consecutiveFailures++;
        // Registry-controlled text: keep it on one line and bounded.
        const detail = String(json.error || text).replace(/\s+/g, " ").slice(0, 120);
        console.warn(`[announce] failed ${res.status}: ${detail}`);
        return;
      }
      if (consecutiveFailures) {
        console.log(`[announce] recovered after ${consecutiveFailures} failures`);
      }
      consecutiveFailures = 0;
      console.log(
        `[announce] ok → ${config.registryUrl} as ${body.name} (ttl ${json.ttl_sec ?? "?"}s)`,
      );
    } catch (err) {
      consecutiveFailures++;
      console.warn("[announce] error", err instanceof Error ? err.message : err);
    } finally {
      inFlight = false;
      schedule();
    }
  };

  const base = Math.max(10, config.announceIntervalSec) * 1000;
  let timer: NodeJS.Timeout | null = null;

  /** Back off on repeated failure so an outage isn't hammered. */
  const schedule = () => {
    if (timer) clearTimeout(timer);
    const backoff = Math.min(2 ** Math.min(consecutiveFailures, 5), 32);
    timer = setTimeout(tick, base * backoff);
    timer.unref();
  };

  tick();
}

const ANNOUNCE_TIMEOUT_MS = 8_000;
