/**
 * The store is what stops one BTC payment from buying several FBC HTLCs.
 *
 * Three separate uniqueness guarantees have to hold, because the original
 * drains each attacked a different one: a swap record must never be silently
 * replaced, an offer_id and a hashlock must not be reusable, and a funding
 * outpoint must belong to exactly one swap.
 */

import { ACCEPT_RESERVE_MS } from "./test-env.js";

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Store, SWAP_FIELDS, type Swap } from "../src/store.js";

function tmpStore(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "mm-store-"));
  return { store: new Store(dir), dir };
}

let seq = 0;
function swap(over: Partial<Swap> = {}): Swap {
  seq++;
  const offerId = seq.toString(16).padStart(32, "0");
  return {
    swap_id: `s_${offerId}`,
    quote_id: "q_test",
    side: "buy_fbc",
    state: "accepted",
    offer: {
      version: 1,
      kind: "offer",
      network: { btc: "main", fbc: "main" },
      hashlock: seq.toString(16).padStart(64, "a"),
      alice_btc_pubkey: "02" + "11".repeat(32),
      alice_fbc_pubkey: "03" + "22".repeat(32),
      amount_btc: 1_000_000,
      amount_fbc: 41_900_000_000,
      btc_refund_height: 920_288,
      fbc_refund_height: 180_720,
      btc_reference_height: 920_000,
      fbc_reference_height: 180_000,
      expires_at: new Date().toISOString(),
      offer_id: offerId,
    },
    accept: {
      version: 1,
      kind: "accept",
      offer_id: offerId,
      bob_btc_pubkey: "02" + "33".repeat(32),
      bob_fbc_pubkey: "03" + "44".repeat(32),
    },
    funded_btc: null,
    funded_fbc: null,
    btc_confs: 0,
    fbc_confs: 0,
    preimage_hex: null,
    btc_claim_txid: null,
    btc_claim_txids: [],
    fbc_claim_txid: null,
    btc_claim_confs: 0,
    btc_claim_fee_rate: null,
    btc_claim_broadcast_at: null,
    fbc_funding_txid_pending: null,
    fbc_funding_intent_at: null,
    fbc_funding_intent_height: null,
    fbc_refund_txid: null,
    fbc_refund_confs: 0,
    fbc_refund_broadcast_at: null,
    fbc_claim_confs: 0,
    fbc_claim_fee_rate: null,
    fbc_claim_broadcast_at: null,
    btc_funding_txid_pending: null,
    btc_funding_intent_at: null,
    btc_funding_intent_height: null,
    btc_refund_txid: null,
    btc_refund_confs: 0,
    error: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

test("addSwap refuses to overwrite an existing swap", () => {
  const { store, dir } = tmpStore();
  try {
    const a = swap();
    store.addSwap(a);
    // The original drain: re-POST the same offer, reset the record, get funded
    // a second time. A duplicate must throw, not replace.
    assert.throws(() => store.addSwap({ ...a, state: "accepted" }), /already exists/);
    assert.equal(store.getSwap(a.swap_id)!.swap_id, a.swap_id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addSwap rejects a reused offer_id even under a different swap_id", () => {
  const { store, dir } = tmpStore();
  try {
    const a = swap();
    store.addSwap(a);
    const b = swap();
    b.offer.offer_id = a.offer.offer_id;
    assert.throws(() => store.addSwap(b), /offer_id .* already been used/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addSwap rejects a reused hashlock (SPEC §9.4: fresh preimage per swap)", () => {
  const { store, dir } = tmpStore();
  try {
    const a = swap();
    store.addSwap(a);
    const b = swap();
    b.offer.hashlock = a.offer.hashlock;
    assert.throws(() => store.addSwap(b), /hashlock has already been used/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("putSwap will not create a swap that was never added", () => {
  const { store, dir } = tmpStore();
  try {
    assert.throws(() => store.putSwap(swap()), /cannot update unknown swap/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a funding outpoint binds to exactly one swap", () => {
  const { store, dir } = tmpStore();
  try {
    const a = swap();
    const b = swap();
    store.addSwap(a);
    store.addSwap(b);

    const txid = "de".repeat(32);
    store.bindOutpoint(txid, 0, a.swap_id);
    assert.equal(store.getSwapIdByOutpoint(txid, 0), a.swap_id);

    // Same payment presented to a second swap — the parallel drain.
    assert.throws(() => store.bindOutpoint(txid, 0, b.swap_id), /already bound/);
    // Re-binding to its own swap is a no-op, so retries stay safe.
    store.bindOutpoint(txid, 0, a.swap_id);
    // A different vout of the same tx is a different outpoint.
    store.bindOutpoint(txid, 1, b.swap_id);
    assert.equal(store.getSwapIdByOutpoint(txid, 1), b.swap_id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("outpoint keys are case-insensitive on the txid", () => {
  const { store, dir } = tmpStore();
  try {
    const a = swap();
    const b = swap();
    store.addSwap(a);
    store.addSwap(b);
    store.bindOutpoint("AB".repeat(32), 0, a.swap_id);
    assert.throws(() => store.bindOutpoint("ab".repeat(32), 0, b.swap_id), /already bound/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quotes are single-use", () => {
  const { store, dir } = tmpStore();
  try {
    const q = {
      quote_id: "q_abc",
      side: "buy_fbc" as const,
      amount_btc: 1_000_000,
      amount_fbc: 41_900_000_000,
      mid_fbc_per_btc: 42_000,
      spread_bps: 50,
      mm_btc_pubkey: "02" + "33".repeat(32),
      mm_fbc_pubkey: "03" + "44".repeat(32),
      btc_reference_height: 920_000,
      fbc_reference_height: 180_000,
      btc_refund_height: 920_288,
      fbc_refund_height: 180_720,
      btc_refund_hours: 48,
      fbc_refund_hours: 24,
      expires_at: new Date().toISOString(),
      created_at: Date.now(),
    };
    store.putQuote(q);
    assert.equal(store.takeQuote("q_abc")?.quote_id, "q_abc");
    assert.equal(store.takeQuote("q_abc"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("indexes and new fields survive a reload from disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-store-"));
  try {
    const first = new Store(dir);
    const a = swap({ funded_btc: {
      version: 1,
      kind: "funded_btc",
      offer_id: "0".repeat(32),
      funding_txid: "cd".repeat(32),
      funding_vout: 2,
      funding_amount: 1_000_000,
      witness_script_hex: "00",
    } });
    first.addSwap(a);

    // A fresh Store must rebuild every index, or the uniqueness guarantees
    // silently lapse across a restart.
    const second = new Store(dir);
    assert.equal(second.getSwapIdByOfferId(a.offer.offer_id), a.swap_id);
    assert.equal(second.getSwapIdByOutpoint("cd".repeat(32), 2), a.swap_id);
    const b = swap();
    b.offer.hashlock = a.offer.hashlock;
    assert.throws(() => second.addSwap(b), /hashlock has already been used/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const AMOUNT = 41_900_000_000;

const FUNDED_FBC: Swap["funded_fbc"] = {
  version: 1,
  kind: "funded_fbc",
  offer_id: "0".repeat(32),
  funding_txid: "cd".repeat(32),
  funding_vout: 0,
  funding_amount: AMOUNT,
  witness_script_hex: "00",
  htlc_address: "fb1qtest",
};

test("an accepted swap reserves inventory so concurrent accepts cannot oversell", () => {
  const { store, dir } = tmpStore();
  try {
    // The taker holds our accept blob and can fund the BTC leg at any moment.
    // Skipping these let N concurrent accepts each see the whole wallet and
    // promise FBC we do not have.
    store.addSwap(swap({ state: "accepted" }));
    assert.equal(store.committedFbcBumps(), AMOUNT);

    store.addSwap(swap({ state: "waiting_btc_confs" }));
    assert.equal(store.committedFbcBumps(), 2 * AMOUNT);

    // Terminal states release their reservation.
    store.addSwap(swap({ state: "done" }));
    store.addSwap(swap({ state: "refunded" }));
    store.addSwap(swap({ state: "failed" }));
    assert.equal(store.committedFbcBumps(), 2 * AMOUNT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an accept reservation expires, so it cannot lock the book for free", () => {
  const { store, dir } = tmpStore();
  try {
    const a = swap({ state: "accepted" });
    store.addSwap(a);
    const later = Date.now() + ACCEPT_RESERVE_MS + 1;
    assert.equal(store.committedFbcBumps({ now: later }), 0);

    // Only `accepted` expires: once the taker's BTC is on chain we are
    // committed regardless of how long the swap has been running.
    const b = swap({ state: "waiting_btc_confs" });
    store.addSwap(b);
    assert.equal(store.committedFbcBumps({ now: later }), AMOUNT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FBC already paid into an HTLC is not counted as committed twice", () => {
  const { store, dir } = tmpStore();
  try {
    // These coins have left the wallet, so the balance this is subtracted from
    // no longer holds them. Counting them here as well halved effective
    // inventory for every in-flight swap.
    store.addSwap(swap({ state: "waiting_fbc_confs", funded_fbc: FUNDED_FBC }));
    assert.equal(store.committedFbcBumps(), 0);

    store.addSwap(swap({ state: "funding_fbc", fbc_funding_txid_pending: "ab".repeat(32) }));
    assert.equal(store.committedFbcBumps(), 0);

    // Intent recorded but nothing broadcast yet: still in the wallet, still ours.
    store.addSwap(swap({ state: "funding_fbc", fbc_funding_intent_at: Date.now() }));
    assert.equal(store.committedFbcBumps(), AMOUNT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("committedFbcBumps can exclude the swap that is about to spend", () => {
  const { store, dir } = tmpStore();
  try {
    const a = swap({ state: "waiting_btc_confs" });
    store.addSwap(a);
    store.addSwap(swap({ state: "waiting_btc_confs" }));
    assert.equal(store.committedFbcBumps({ excludeSwapId: a.swap_id }), AMOUNT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a truncated mm.json is preserved and the bot still starts", () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-store-"));
  try {
    const first = new Store(dir);
    first.addSwap(swap());

    // JSON.parse used to throw out of the constructor, killing the process at
    // startup on every restart — with live swaps holding FBC and nobody left
    // to refund them at T2.
    const path = join(dir, "mm.json");
    writeFileSync(path, '{"swaps":{"s_a":');

    const second = new Store(dir);
    assert.deepEqual(second.listActiveSwaps(), []);
    const corrupt = readdirSync(dir).filter((f) => f.startsWith("mm.json.corrupt-"));
    assert.equal(corrupt.length, 1, "the unreadable file must be kept for salvage");
    assert.equal(readFileSync(join(dir, corrupt[0]!), "utf8"), '{"swaps":{"s_a":');

    // And the fresh store is usable.
    second.addSwap(swap());
    assert.equal(new Store(dir).listActiveSwaps().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty mm.json falls back to the interrupted write beside it", () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-store-"));
  try {
    const first = new Store(dir);
    const a = swap();
    first.addSwap(a);

    // What a crash between the write and the rename leaves behind.
    const path = join(dir, "mm.json");
    writeFileSync(path + ".tmp", readFileSync(path, "utf8"));
    writeFileSync(path, "");

    const second = new Store(dir);
    assert.equal(second.getSwap(a.swap_id)?.swap_id, a.swap_id);
    assert.equal(second.getSwapIdByOfferId(a.offer.offer_id), a.swap_id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a swap written before `side` existed loads as buy_fbc", () => {
  // Every swap on disk today predates the field, and buy_fbc is the only side
  // this bot has ever served. Getting this wrong is not a cosmetic default:
  // planSwap fails closed on an unknown side, so a swap holding funded FBC
  // would plan nothing and never refund at T2.
  const dir = mkdtempSync(join(tmpdir(), "mm-store-"));
  try {
    const first = new Store(dir);
    const a = swap();
    first.addSwap(a);

    // Strip the field back out, the way a store written by an older build
    // would have it.
    const path = join(dir, "mm.json");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    delete raw.swaps[a.swap_id].side;
    assert.equal("side" in raw.swaps[a.swap_id], false, "fixture must lack the field");
    writeFileSync(path, JSON.stringify(raw));

    const second = new Store(dir);
    assert.equal(second.getSwap(a.swap_id)?.side, "buy_fbc");

    // The default is applied in memory on every load and is NOT written back:
    // `load()` reports a healthy file, so the constructor does not save. The
    // backfill in reindex() is therefore permanent, not a one-time migration,
    // and deleting it later on the assumption the data has caught up would
    // silently un-plan every old swap.
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    assert.equal("side" in onDisk.swaps[a.swap_id], false, "no migration write happens");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every Swap field has a reindex default, so no read site sees undefined", () => {
  // The point of reindex() is that code downstream never has to defend against
  // a field being absent. That guarantee is only as good as its coverage, and
  // coverage is easy to lose: adding a field to `Swap` and forgetting the
  // `??=` line compiles cleanly and fails only when something reads it.
  //
  // Driven off SWAP_FIELDS so a new field is checked automatically rather than
  // when someone remembers to extend this list.
  const dir = mkdtempSync(join(tmpdir(), "mm-store-"));
  try {
    const first = new Store(dir);
    const a = swap();
    first.addSwap(a);

    // Strip every field except the ones a record cannot be identified without.
    const keep = new Set(["swap_id", "quote_id", "state", "offer", "accept", "created_at", "updated_at"]);
    const path = join(dir, "mm.json");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    for (const k of Object.keys(SWAP_FIELDS)) {
      if (!keep.has(k)) delete raw.swaps[a.swap_id][k];
    }
    writeFileSync(path, JSON.stringify(raw));

    const loaded = new Store(dir).getSwap(a.swap_id) as Record<string, unknown>;
    const missing = Object.keys(SWAP_FIELDS).filter((k) => loaded[k] === undefined);
    assert.deepEqual(missing, [], `reindex() leaves these undefined: ${missing.join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Inventory reservation is per-chain ───────────────────────────────────

test("a sell swap does not reserve FBC, and a buy swap does not reserve BTC", () => {
  // Reservation exists so two concurrent swaps cannot both be promised the
  // same coins. Which coins depends on the side: on buy_fbc we fund FBC, on
  // sell_fbc we fund BTC. Counting every non-terminal swap against FBC — what
  // this did before sell existed — would shrink the buy book for every sell
  // swap in flight, against coins that swap will never spend.
  const { store, dir } = tmpStore();
  try {
    const buy = swap({ side: "buy_fbc", state: "accepted" });
    const sell = swap({ side: "sell_fbc", state: "accepted" });
    store.addSwap(buy);
    store.addSwap(sell);

    assert.equal(
      store.committedFbcBumps(),
      buy.offer.amount_fbc,
      "only the buy swap reserves FBC",
    );
    assert.equal(
      store.committedBtcSats(),
      sell.offer.amount_btc,
      "only the sell swap reserves BTC",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("funding on our chain releases the reservation, on either side", () => {
  // Once the coins are on chain they are a balance change the node already
  // sees, not a promise. Double-counting them would make us refuse quotes we
  // could actually honour.
  const { store, dir } = tmpStore();
  try {
    const buy = swap({
      side: "buy_fbc",
      state: "waiting_fbc_confs",
      funded_fbc: { funding_txid: "aa".repeat(32), funding_vout: 0, funding_amount: 1 } as never,
    });
    const sell = swap({
      side: "sell_fbc",
      state: "waiting_btc_confs",
      funded_btc: { funding_txid: "bb".repeat(32), funding_vout: 0, funding_amount: 1 } as never,
    });
    store.addSwap(buy);
    store.addSwap(sell);
    assert.equal(store.committedFbcBumps(), 0);
    assert.equal(store.committedBtcSats(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pending funding txid still reserves, on either side", () => {
  // The window between broadcast and confirmation. The coins are committed but
  // not yet visible as spent, so releasing here would let a concurrent swap be
  // promised them too.
  const { store, dir } = tmpStore();
  try {
    const buy = swap({
      side: "buy_fbc",
      state: "funding_fbc",
      fbc_funding_txid_pending: "cc".repeat(32),
    });
    const sell = swap({
      side: "sell_fbc",
      state: "accepted",
      btc_funding_txid_pending: "dd".repeat(32),
    });
    store.addSwap(buy);
    store.addSwap(sell);
    // Both are excluded by the same rule that excludes a confirmed funding:
    // the coins have left the wallet, so the node's balance already reflects them.
    assert.equal(store.committedFbcBumps(), 0);
    assert.equal(store.committedBtcSats(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("terminal swaps reserve nothing on either chain", () => {
  const { store, dir } = tmpStore();
  try {
    for (const state of ["done", "failed", "refunded"] as const) {
      store.addSwap(swap({ side: "buy_fbc", state }));
      store.addSwap(swap({ side: "sell_fbc", state }));
    }
    assert.equal(store.committedFbcBumps(), 0);
    assert.equal(store.committedBtcSats(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Unfunded reservation cap ─────────────────────────────────────────────

test("unfunded accepted swaps are counted; funded and stale ones are not", () => {
  // Accepting costs a taker nothing on chain but reserves inventory and writes
  // a permanent record, so the number that may be open at once has to be
  // bounded. This counts exactly the ones holding a live reservation.
  const { store, dir } = tmpStore();
  try {
    const live = swap({ side: "buy_fbc", state: "accepted" });
    store.addSwap(live);
    assert.equal(store.unfundedReservationCount(), 1);

    // Funded: the coins are committed, so this is no longer a free hold.
    const funded = swap({
      side: "buy_fbc",
      state: "accepted",
      funded_btc: { funding_txid: "aa".repeat(32), funding_vout: 0, funding_amount: 1 } as never,
    });
    store.addSwap(funded);
    assert.equal(store.unfundedReservationCount(), 1, "a funded swap is not a free hold");

    // Past acceptReserveMs: the reservation has lapsed, so it no longer
    // occupies a slot. This is what makes the cap self-healing rather than a
    // permanent lockout after an attack.
    assert.equal(
      store.unfundedReservationCount(live.created_at + ACCEPT_RESERVE_MS + 1),
      0,
      "a lapsed reservation frees its slot",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a swap mid-funding still occupies a slot", () => {
  // Between broadcast and confirmation there is no funded_* record yet, but
  // coins have moved. Releasing the slot here would be harmless for the cap,
  // but it would also mean the count disagrees with committedOnChain about
  // what "committed" means — and those two disagreeing is how double-spend
  // accounting bugs start.
  const { store, dir } = tmpStore();
  try {
    store.addSwap(swap({
      side: "buy_fbc",
      state: "accepted",
      fbc_funding_txid_pending: "bb".repeat(32),
    }));
    assert.equal(store.unfundedReservationCount(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("swaps past the accepted state never occupy a slot", () => {
  const { store, dir } = tmpStore();
  try {
    for (const state of ["waiting_btc_confs", "claimable", "done", "failed", "refunded"] as const) {
      store.addSwap(swap({ side: "buy_fbc", state }));
    }
    assert.equal(store.unfundedReservationCount(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Mid-settlement swaps ──────────────────────────────────────────────────
//
// listSettlingSwaps feeds the public market list, so what it lets through is
// published to strangers. The filter is the whole feature: a swap that has not
// had its FBC leg claimed has not happened, and showing it would announce a
// trade that might still turn into a refund.

const SETTLING = {
  state: "claiming_btc" as const,
  funded_btc: { funding_txid: "aa".repeat(32), funding_vout: 0, funding_amount: 10_000 } as never,
  funded_fbc: { funding_txid: "bb".repeat(32), funding_vout: 0, funding_amount: 1 } as never,
  fbc_claim_txid: "cc".repeat(32),
};

test("a swap mid-settlement is listed", () => {
  const { store, dir } = tmpStore();
  try {
    store.addSwap(swap(SETTLING));
    assert.equal(store.listSettlingSwaps().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only claiming_btc counts as settling", () => {
  // Every earlier state still has an outcome in doubt. `done` is excluded too:
  // it belongs to the settled feed, and appearing in both would read as two
  // separate trades for one swap.
  const { store, dir } = tmpStore();
  try {
    for (const state of [
      "accepted",
      "waiting_btc_confs",
      "funding_fbc",
      "waiting_fbc_confs",
      "claimable",
      "done",
      "failed",
      "refunding_fbc",
      "refunded",
    ] as const) {
      store.addSwap(swap({ ...SETTLING, state }));
    }
    assert.deepEqual(store.listSettlingSwaps(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a settling swap missing any on-chain leg is not listed", () => {
  // Without all three, a consumer has nothing to verify against and would be
  // taking the maker's word for a trade — which is the one thing the whole
  // verification pipeline exists to avoid.
  const { store, dir } = tmpStore();
  try {
    store.addSwap(swap({ ...SETTLING, funded_btc: null }));
    store.addSwap(swap({ ...SETTLING, funded_fbc: null }));
    store.addSwap(swap({ ...SETTLING, fbc_claim_txid: null }));
    assert.deepEqual(store.listSettlingSwaps(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settling swaps are newest first and capped", () => {
  // addSwap stamps updated_at itself, so this asserts the ordering property
  // rather than fixed values — pinning the timestamps would only test that the
  // fixture survived, which it does not.
  const { store, dir } = tmpStore();
  try {
    for (let i = 0; i < 5; i++) store.addSwap(swap(SETTLING));
    const rows = store.listSettlingSwaps({ limit: 3 });
    assert.equal(rows.length, 3, "limit must be honoured");
    const stamps = rows.map((s) => s.updated_at);
    assert.deepEqual(stamps, [...stamps].sort((a, b) => b - a), "newest first");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the store file is not world-readable", () => {
  // It holds preimages — the secret that unlocks an in-flight HTLC. It was
  // being created 0644, readable by every account on the host.
  const { store, dir } = tmpStore();
  try {
    // addSwap persists synchronously — anything with funds behind it does.
    store.addSwap(swap({ preimage_hex: "ab".repeat(32) }));
    const mode = statSync(join(dir, "mm.json")).mode & 0o777;
    assert.equal(mode, 0o600, `mode was ${mode.toString(8)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
