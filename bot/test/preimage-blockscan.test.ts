/**
 * The preimage block scan — the path that finds a taker's claim AFTER it has
 * confirmed and left the mempool.
 *
 * `findFbcPreimage` has three routes, tried in order:
 *
 *   1. gettxbyaddress — needs fbd's address index, which is off by default and
 *      is off on the production node, so this simply throws and is skipped.
 *   2. the mempool — works only while the claim is unconfirmed.
 *   3. a block scan from the funding height.
 *
 * In normal operation route 2 answers, because the bot polls every few seconds
 * and an FBC block takes two minutes. That masked a bug in route 3 completely:
 * its call passed `hashlockHex` where `spenderTxid` was expected and vice
 * versa, so every candidate preimage was hashed and compared against a
 * transaction id and could never match.
 *
 * Route 3 is the only route left if the bot is down or slow across the moment
 * the claim confirms — a restart at the wrong second is enough. Failing it
 * means the maker never learns the preimage, never claims the BTC, and the
 * taker refunds at T1 while keeping the FBC. The whole leg.
 *
 * So this exercises route 3 with routes 1 and 2 forced to fail, which is the
 * one arrangement the existing tests never produced.
 */

import "./test-env.js";

import assert from "node:assert/strict";
import { test } from "node:test";

import { sha256 } from "@noble/hashes/sha256";

import { findFbcPreimage } from "../src/chain.js";
import { fromHex, toHex } from "../src/hex.js";

// A distinct outpoint per test. `scanCursor` in chain.ts is module-global and
// keyed on `txid:vout`, so tests sharing one funding txid also share a resume
// position — the first scan advances it past the claim block and every later
// test starts after the thing it is looking for. That is correct behaviour for
// the bot (it exists so a tick only walks new blocks) and simply means these
// tests have to use different outpoints.
let n = 0;
const nextFunding = () => (10 + n++).toString(16).repeat(32).slice(0, 64);
const CLAIM_TXID = "bb".repeat(32);
const FUND_HEIGHT = 100;
const HTLC_ADDRESS = "fb1qhtlc";

const PREIMAGE = "11".repeat(32);
const HASHLOCK = toHex(sha256(fromHex(PREIMAGE)));

/** A claim witness: [sig, preimage, 0x01, redeemScript]. */
const CLAIM_WITNESS = ["30".repeat(71), PREIMAGE, "01", "63a820" + HASHLOCK + "88ac67"];

/**
 * An fbd stand-in with the address index OFF, an empty mempool, and the claim
 * buried in a block — production's actual shape.
 */
function nodeWithConfirmedClaim(
  fundingTxid: string,
  opts: { witness?: string[]; atHeight?: number } = {},
) {
  const claimHeight = opts.atHeight ?? FUND_HEIGHT + 2;
  const calls = { byAddress: 0, mempool: 0, blocks: 0 };
  return {
    calls,
    client: {
      async getTxByAddress() {
        calls.byAddress++;
        // What the real node does without --index-address.
        throw new Error("gettxbyaddress: address index disabled");
      },
      async getRawMempool() {
        calls.mempool++;
        return [];
      },
      async getTransaction(txid: string) {
        if (txid === fundingTxid) return { height: FUND_HEIGHT };
        throw new Error(`unexpected getTransaction ${txid}`);
      },
      async getBlockCount() {
        return claimHeight + 1;
      },
      async getBlock(height: number) {
        calls.blocks++;
        if (height !== claimHeight) return { tx: [] };
        return {
          tx: [
            {
              hash: CLAIM_TXID,
              vin: [
                {
                  txid: fundingTxid,
                  vout: 0,
                  witness: opts.witness ?? CLAIM_WITNESS,
                },
              ],
            },
          ],
        };
      },
    },
  };
}

test("the block scan finds a preimage the mempool has already lost", async (t) => {
  // The regression test. Before the fix this returned null, because the call
  // compared each witness element's hash against CLAIM_TXID instead of the
  // hashlock — and null here means losing the FBC leg.
  const fundingTxid = nextFunding();
  const node = nodeWithConfirmedClaim(fundingTxid);
  const { setFbdClientForTests } = await import("../src/chain.js");
  setFbdClientForTests(node.client as never);
  t.after(() => setFbdClientForTests(null));

  const hit = await findFbcPreimage(fundingTxid, 0, HTLC_ADDRESS, HASHLOCK);

  assert.ok(hit, "no preimage found — the maker cannot claim the BTC leg");
  assert.equal(hit.preimageHex, PREIMAGE);
  assert.equal(hit.spendingTxid, CLAIM_TXID);
  assert.ok(node.calls.blocks > 0, "the block scan should have run");
});

test("a witness that does not satisfy the hashlock is not accepted", async (t) => {
  // The other direction: the scan must not return just any 32-byte element.
  // Reading a value off the chain and calling it the preimage is how a swap
  // gets marked claimable against a secret that unlocks nothing.
  const wrong = "22".repeat(32);
  const fundingTxid = nextFunding();
  const node = nodeWithConfirmedClaim(fundingTxid, {
    witness: ["30".repeat(71), wrong, "01", "63a820" + HASHLOCK + "88ac67"],
  });
  const { setFbdClientForTests } = await import("../src/chain.js");
  setFbdClientForTests(node.client as never);
  t.after(() => setFbdClientForTests(null));

  assert.equal(await findFbcPreimage(fundingTxid, 0, HTLC_ADDRESS, HASHLOCK), null);
});

test("a preimage of any length is found, not just 32 bytes", async (t) => {
  // The 31-byte attack, on the block-scan route this time. The HTLC script
  // carries no OP_SIZE check, so a claim can use a secret of any length and
  // the detector has to match by hash rather than by size.
  const short = "33".repeat(31);
  const lock = toHex(sha256(fromHex(short)));
  const fundingTxid = nextFunding();
  const node = nodeWithConfirmedClaim(fundingTxid, {
    witness: ["30".repeat(71), short, "01", "63a820" + lock + "88ac67"],
  });
  const { setFbdClientForTests } = await import("../src/chain.js");
  setFbdClientForTests(node.client as never);
  t.after(() => setFbdClientForTests(null));

  const hit = await findFbcPreimage(fundingTxid, 0, HTLC_ADDRESS, lock);
  assert.equal(hit?.preimageHex, short);
});
