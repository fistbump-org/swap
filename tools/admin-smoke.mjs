/**
 * End-to-end checks for the maker dashboard, over real HTTP.
 *
 * The unit tests cover the rules in isolation; this covers the transport,
 * where the mistakes are different in kind — a route that forgot its auth
 * check, a guard that runs after the money moves, a response echoing the
 * request instead of the state. Every one of those looks fine in a unit test.
 *
 * Runs against a stub MarketMaker, so no node, wallet or swap is touched.
 *
 *   MM_ADMIN_PORT=18790 MM_ADMIN_TOKEN=$(openssl rand -hex 16) \
 *     npx tsx tools/admin-smoke.mjs
 *
 * (plus the timelock/network env config.ts insists on — see test/test-env.ts)
 */
import { startAdminServer } from "../bot/src/admin.js";

const PORT = Number(process.env.MM_ADMIN_PORT);

const mm = {
  async operatorSnapshot() {
    return {
      wallets: {
        btc: { spendable_sat: 123456, deposit_address: "bc1qtest", wallet: "mm" },
        fbc: { balance_fbc: 9876.5, deposit_address: "fb1qtest", wallet: "mm" },
      },
      inventory: { available_fbc: 9000, max_fbc_per_swap: 1000000, min_btc_sat: 10000 },
      swaps: { active: 0, settling: 1, settled_all_time: 3 },
    };
  },
  listTrades: () => [{
    swap_id: "s_x", side: "buy_fbc", maker_action: "sold FBC", settled_at: 1785300000000,
    amount_btc_sat: 10000, amount_fbc_bumps: 615147384,
    btc: {}, fbc: {},
  }],
  listSettling: () => [],
  btcFeeReserveSats: () => 20000,
  // Mirrors the real lock: one at a time per chain, second caller refused.
  _busy: { btc: false, fbc: false },
  async withdraw({ chain, address, amount, max }) {
    if (this._busy[chain]) throw new Error(`a ${chain.toUpperCase()} withdrawal is already in progress`);
    this._busy[chain] = true;
    try {
      return await this._send({ chain, address, amount, max });
    } finally {
      this._busy[chain] = false;
    }
  },
  async _send({ chain, address, amount, max }) {
    // fbd charges its fee on top, so the reachable maximum is below the
    // unreserved figure. Mirrors FBC_WITHDRAW_FEE_BUMPS.
    if (chain === "fbc") {
      const FEE = 10000;
      const spendable = 9000e6 - FEE;
      const want = max ? spendable : amount;
      if (want > spendable) throw new Error("only ... FBC may be withdrawn");
      await new Promise((r) => setTimeout(r, 150));
      return { txid: "fbctxid", amount: want, chain };
    }
    // A send that takes a moment, so a second request genuinely overlaps.
    await new Promise((r) => setTimeout(r, 150));
    if (chain === "btc") {
      const free = 123456 - 20000;
      const send = max ? free : amount;
      if (send > free) throw new Error(`only ${free} of 123456 sat may be withdrawn`);
      return { txid: "btctxid", amount: send, chain };
    }
    const free = 9000e6;
    const send = max ? free : amount;
    if (send > free) throw new Error("only 9000 FBC is unreserved");
    return { txid: "fbctxid", amount: send, chain };
  },
};

const base = `http://127.0.0.1:${PORT}`;
const TOKEN = process.env.MM_ADMIN_TOKEN;
const auth = (t = TOKEN) => ({ Authorization: `Bearer ${t}` });

startAdminServer(mm);
await new Promise((r) => setTimeout(r, 400));

let failures = 0;
const check = (name, cond, extra = "") => {
  if (cond) console.log(`ok   ${name}`);
  else { console.log(`FAIL ${name} ${extra}`); failures++; }
};

// Auth
check("no token -> 401", (await fetch(`${base}/api/state`)).status === 401);
check("wrong token -> 401",
  (await fetch(`${base}/api/state`, { headers: auth("x".repeat(32)) })).status === 401);
check("price POST without a token -> 401",
  (await fetch(`${base}/api/price`, { method: "POST", body: "{}" })).status === 401);
check("unknown path unauthenticated -> 401, not 404",
  (await fetch(`${base}/api/secrets`)).status === 401);

// The page must load unauthenticated (it has to ask for the token) but carry
// no data.
const page = await fetch(`${base}/`);
const html = await page.text();
check("page loads without a token", page.status === 200);
check("page contains no balances", !html.includes("123456") && !html.includes("bc1qtest"));

// Reads
const state = await fetch(`${base}/api/state`, { headers: auth() });
const body = await state.json();
check("authenticated state -> 200", state.status === 200);
check("balances present", body.wallets.btc.spendable_sat === 123456);
check("price present", typeof body.price.fbc_usd === "number");

// Price guard
const small = await fetch(`${base}/api/price`, {
  method: "POST", headers: { ...auth(), "Content-Type": "application/json" },
  body: JSON.stringify({ fbc_usd: body.price.fbc_usd * 1.1 }),
});
check("a small change is accepted", small.status === 200, `got ${small.status}`);
// The response must report what is actually in force, not the raw input:
// setFbcUsdPrice rounds, and echoing the request showed the operator
// $0.011000000000000001 while the bot quoted $0.011.
const smallBody = await small.json();
check("the response reports the stored price, not the input",
  smallBody.fbc_usd === 0.011, JSON.stringify(smallBody));

const cur = (await (await fetch(`${base}/api/state`, { headers: auth() })).json()).price.fbc_usd;
const big = await fetch(`${base}/api/price`, {
  method: "POST", headers: { ...auth(), "Content-Type": "application/json" },
  body: JSON.stringify({ fbc_usd: cur / 100 }),
});
check("a 100x drop is refused without confirm", big.status === 409, `got ${big.status}`);
const afterRefusal = (await (await fetch(`${base}/api/state`, { headers: auth() })).json()).price.fbc_usd;
check("the refused price was NOT applied", afterRefusal === cur, `${afterRefusal} vs ${cur}`);

const confirmed = await fetch(`${base}/api/price`, {
  method: "POST", headers: { ...auth(), "Content-Type": "application/json" },
  body: JSON.stringify({ fbc_usd: cur / 100, confirm: true }),
});
check("a confirmed big change is accepted", confirmed.status === 200);

const cleared = await fetch(`${base}/api/price`, {
  method: "POST", headers: { ...auth(), "Content-Type": "application/json" },
  body: JSON.stringify({ clear: true }),
});
check("clearing restores the env default", cleared.status === 200
  && (await cleared.json()).overridden === false);

// Bad input
const bad = await fetch(`${base}/api/price`, {
  method: "POST", headers: { ...auth(), "Content-Type": "application/json" },
  body: JSON.stringify({ fbc_usd: "free", confirm: true }),
});
check("a non-numeric price -> 400", bad.status === 400, `got ${bad.status}`);

// ── Withdrawals ────────────────────────────────────────────────────────────
const post = (body) => fetch(`${base}/api/withdraw`, {
  method: "POST", headers: { ...auth(), "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

check("withdraw without a token -> 401",
  (await fetch(`${base}/api/withdraw`, { method: "POST", body: "{}" })).status === 401);

const unconfirmed = await post({ chain: "btc", address: "bc1qdest", amount: 1000 });
check("withdraw without confirm -> 409", unconfirmed.status === 409, `got ${unconfirmed.status}`);

const noChain = await post({ address: "bc1qdest", amount: 1000, confirm: true });
check("a missing chain -> 400", noChain.status === 400);

const noAddr = await post({ chain: "btc", amount: 1000, confirm: true });
check("a missing address -> 400", noAddr.status === 400);

for (const amt of [0, -5, "lots", null]) {
  const r = await post({ chain: "btc", address: "bc1qdest", amount: amt, confirm: true });
  check(`amount ${JSON.stringify(amt)} -> 400`, r.status === 400, `got ${r.status}`);
}

const ok = await post({ chain: "btc", address: "bc1qdest", amount: 1000, confirm: true });
check("a confirmed withdrawal within reserve succeeds", ok.status === 200,
  `got ${ok.status}`);

const overBtc = await post({ chain: "btc", address: "bc1qdest", amount: 123456, confirm: true });
const overBody = await overBtc.json();
check("withdrawing into the BTC fee reserve is refused",
  overBtc.status === 400 && /may be withdrawn/.test(overBody.error || ""), overBody.error);

const overFbc = await post({ chain: "fbc", address: "fb1qdest", amount: 999999e6, confirm: true });
check("withdrawing reserved FBC is refused", overFbc.status === 400);

const maxBtc = await post({ chain: "btc", address: "bc1qdest", max: true, confirm: true });
const maxBody = await maxBtc.json();
check("max withdraws balance minus reserve",
  maxBtc.status === 200 && maxBody.amount === 123456 - 20000, JSON.stringify(maxBody));

// ── The other trading parameters ───────────────────────────────────────────
const setting = (body) => fetch(`${base}/api/settings`, {
  method: "POST", headers: { ...auth(), "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const st2 = await (await fetch(`${base}/api/state`, { headers: auth() })).json();
const swaps = await (await fetch(`${base}/api/swaps`, { headers: auth() })).json();
// Side is taker-relative, so a maker's own dashboard showing it labels every
// row with the counterparty's action. The API must send the maker's wording.
check("settled rows carry the maker's own action",
  swaps.settled?.[0]?.maker_action === "sold FBC",
  JSON.stringify(swaps.settled?.[0]));

check("state lists every adjustable setting",
  st2.settings && st2.settings.max_fbc && st2.settings.min_btc_sat && st2.settings.fbc_usd_price,
  JSON.stringify(Object.keys(st2.settings || {})));

check("settings write needs a token",
  (await fetch(`${base}/api/settings`, { method: "POST", body: "{}" })).status === 401);

const maxOk = await setting({ key: "max_fbc", value: 250000 });
const maxFbcBody = await maxOk.json();
check("max_fbc can be set", maxOk.status === 200 && maxFbcBody.value === 250000);
// The compatibility field is for the price endpoint only. Echoing it on every
// write made a max_fbc response read as "now selling FBC at $250,000 each".
check("a non-price write carries no fbc_usd field",
  !("fbc_usd" in maxFbcBody), JSON.stringify(maxFbcBody));

const minOk = await setting({ key: "min_btc_sat", value: 25000 });
check("min_btc_sat can be set", minOk.status === 200 && (await minOk.json()).value === 25000);

// Changing a limit must not need the price confirmation — that gate exists for
// the one value that sells inventory, and applying it everywhere would train
// the operator to click through it.
check("a limit change needs no confirm flag", maxOk.status === 200 && minOk.status === 200);

const frac = await setting({ key: "min_btc_sat", value: 10000.5 });
check("a fractional satoshi minimum -> 400", frac.status === 400, `got ${frac.status}`);

const tooSmall = await setting({ key: "min_btc_sat", value: 1 });
check("a minimum below the band -> 400", tooSmall.status === 400);

const unknown = await setting({ key: "wen_moon", value: 1 });
check("an unknown setting key -> 400", unknown.status === 400, `got ${unknown.status}`);

const stillThere = await (await fetch(`${base}/api/state`, { headers: auth() })).json();
check("rejected writes left the good values in place",
  stillThere.settings.min_btc_sat.value === 25000 && stillThere.settings.max_fbc.value === 250000,
  JSON.stringify({ min: stillThere.settings.min_btc_sat.value, max: stillThere.settings.max_fbc.value }));

const clearedMax = await setting({ key: "max_fbc", clear: true });
check("a limit can be handed back to the env",
  clearedMax.status === 200 && (await clearedMax.json()).overridden === false);

const afterClear = await (await fetch(`${base}/api/state`, { headers: auth() })).json();
check("clearing one setting leaves the other set",
  afterClear.settings.min_btc_sat.overridden === true
  && afterClear.settings.max_fbc.overridden === false);

// ── Concurrency ────────────────────────────────────────────────────────────
// The race the lock exists for: both requests read the same pre-send balance,
// both pass the reserve check, and together spend more than either was
// allowed. The second must be refused outright rather than queued behind an
// unknown wait — an earlier timeout-based queue released the lock while the
// first send was still in flight, which reinstated the very race it fixed.
const twin = () => post({ chain: "btc", address: "bc1qdest", amount: 1000, confirm: true });
const [r1, r2] = await Promise.all([twin(), twin()]);
const codes = [r1.status, r2.status].sort();
check("exactly one concurrent withdrawal succeeds",
  codes[0] === 200 && codes[1] === 400, JSON.stringify(codes));
const refused = r1.status === 200 ? await r2.json() : await r1.json();
check("the refusal says why", /already in progress/i.test(refused.error || ""), refused.error);

// And the lock is released afterwards, or the asset is closed until restart.
const after = await twin();
check("a later withdrawal still works", after.status === 200, `got ${after.status}`);

// fbd's sendtoaddress charges its fee ON TOP of the amount, unlike the BTC
// path which can subtract it. Sweeping the full unreserved figure therefore
// spends reserved inventory — or simply fails for want of headroom.
const fbcMax = await post({ chain: "fbc", address: "fb1qdest", max: true, confirm: true });
const fbcBody = await fbcMax.json();
check("an FBC sweep leaves room for the fee",
  fbcMax.status === 200 && fbcBody.amount < 9000e6,
  JSON.stringify(fbcBody));

const fbcOver = await post({ chain: "fbc", address: "fb1qdest", amount: 9000e6, confirm: true });
check("withdrawing the whole unreserved figure is refused", fbcOver.status === 400,
  `got ${fbcOver.status}`);

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
