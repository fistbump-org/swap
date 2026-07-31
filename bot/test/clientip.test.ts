/**
 * Which client a request is rate-limited as.
 *
 * Every budget in this API keys off this one function, and `/v1/quote` fans
 * out to a price feed, bitcoind and fbd on each call — so getting it wrong
 * does not merely mis-attribute traffic, it removes the limit entirely.
 *
 * It was wrong. The function took the LEFTMOST X-Forwarded-For entry, which is
 * the end a client controls, so anyone could select their own token bucket by
 * varying a header. Confirmed against the live bot before the fix: twelve
 * requests with a rotating forged value returned eleven 200s; the identical
 * burst without the header returned eleven 429s.
 */

import "./test-env.js";

import assert from "node:assert/strict";
import { test } from "node:test";

import { clientIpFor } from "../src/api.js";

const PROXY = "127.0.0.1";
const REAL = "198.51.100.7";

test("the rightmost entry wins, because that is the one our proxy wrote", () => {
  // A client sending its own value gets it appended to, not honoured.
  assert.equal(clientIpFor(PROXY, `203.0.113.9, ${REAL}`), REAL);
  assert.equal(clientIpFor(PROXY, `1.1.1.1, 2.2.2.2, ${REAL}`), REAL);
});

test("a forged header cannot select a bucket", () => {
  // The actual attack: vary the forged value per request and get a fresh
  // budget each time. Every one of these must map to the same key.
  const seen = new Set(
    ["203.0.113.1", "203.0.113.2", "8.8.8.8", "", "not-an-ip"].map((forged) =>
      clientIpFor(PROXY, `${forged}, ${REAL}`),
    ),
  );
  assert.deepEqual([...seen], [REAL], "forged values must not change the bucket");
});

test("a single-entry header is taken as-is", () => {
  // What a proxy configured to REPLACE rather than append produces
  // (`header_up X-Forwarded-For {remote_host}`). Rightmost is still correct.
  assert.equal(clientIpFor(PROXY, REAL), REAL);
});

test("whitespace around entries is stripped", () => {
  assert.equal(clientIpFor(PROXY, `203.0.113.9,   ${REAL}   `), REAL);
});

test("a header from a NON-loopback peer is ignored without TRUST_PROXY", () => {
  // Direct connections must be keyed on the socket. Honouring the header here
  // would let anyone reaching the bot directly pick a bucket.
  assert.equal(clientIpFor(REAL, "203.0.113.9"), REAL);
});

test("no header falls back to the socket address", () => {
  assert.equal(clientIpFor(REAL, undefined), REAL);
  assert.equal(clientIpFor("", undefined), "unknown");
});

test("loopback is recognised in all three spellings", () => {
  // ::1 and ::ffff:127.0.0.1 are what a proxy on the same host actually
  // presents, depending on whether it dialled v4 or v6.
  for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(clientIpFor(peer, `203.0.113.9, ${REAL}`), REAL, peer);
  }
});
