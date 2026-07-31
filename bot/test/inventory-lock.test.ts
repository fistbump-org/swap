/**
 * Inventory is read-check-commit, and both readers must share one lock.
 *
 * `acceptOffer` checks uncommitted FBC and later calls `store.addSwap`, which
 * is what creates the reservation. `withdraw` checks the same figure and then
 * sends. Interleaved, each acts on a balance the other is about to spend.
 *
 * The asymmetry is what makes it worth a test: a withdrawal landing between an
 * accept's check and its reservation takes coins already promised to a taker
 * who is at that moment funding their BTC leg. Their money locks in an HTLC
 * with no FBC coming and the only exit is a timelock.
 *
 * The first version of this lock guarded withdrawals against each other and
 * nothing else, which left exactly that case open. So what is asserted here is
 * mutual exclusion between DIFFERENT operations, not between two of the same.
 */

import "./test-env.js";

import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The lock in isolation.
 *
 * Driving the real acceptOffer needs a wallet, a node and a quote; the
 * property under test is the serialisation itself, so this exercises the same
 * construct against instrumented critical sections.
 */
class Locked {
  private inventoryLock: Promise<unknown> = Promise.resolve();
  readonly log: string[] = [];

  private withInventoryLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.inventoryLock.then(fn, fn);
    this.inventoryLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Read available, yield, then commit — the shape of both real callers. */
  section(name: string, available: () => number, commit: (n: number) => void) {
    return this.withInventoryLock(async () => {
      const seen = available();
      this.log.push(`${name}:read=${seen}`);
      await new Promise((r) => setTimeout(r, 5));
      commit(seen);
      this.log.push(`${name}:commit`);
      return seen;
    });
  }
}

test("an accept and a withdrawal cannot interleave", async () => {
  const l = new Locked();
  let balance = 1000;
  await Promise.all([
    l.section("accept", () => balance, (n) => { balance -= n === 1000 ? 600 : 0; }),
    l.section("withdraw", () => balance, (n) => { balance -= n; }),
  ]);
  // Whoever ran second must have READ what the first committed. An interleave
  // shows up as two reads before either commit.
  assert.deepEqual(
    l.log,
    ["accept:read=1000", "accept:commit", "withdraw:read=400", "withdraw:commit"],
    `interleaved: ${l.log.join(" ")}`,
  );
});

test("the second caller never sees the pre-commit balance", async () => {
  const l = new Locked();
  let balance = 1000;
  const [first, second] = await Promise.all([
    l.section("a", () => balance, (n) => { balance -= n; }),
    l.section("b", () => balance, (n) => { balance -= n; }),
  ]);
  assert.equal(first, 1000);
  assert.equal(second, 0, "the second read must reflect the first commit, not race it");
});

test("a failure does not stall the queue behind it", async () => {
  // One caller throwing must not close inventory for everyone after it —
  // that turns a rejected withdrawal into a maker that has stopped trading.
  const l = new Locked();
  const boom = l.section("boom", () => { throw new Error("nope"); }, () => {});
  await assert.rejects(() => boom);
  const after = await l.section("after", () => 42, () => {});
  assert.equal(after, 42);
});

test("order is preserved, so no caller is starved", async () => {
  const l = new Locked();
  const names = ["one", "two", "three", "four"];
  await Promise.all(names.map((n) => l.section(n, () => 1, () => {})));
  assert.deepEqual(
    l.log.filter((e) => e.endsWith(":commit")),
    names.map((n) => `${n}:commit`),
  );
});
