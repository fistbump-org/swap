// Offer / accept / funded blob encoding.
//
// Blobs are copy-pasted between counterparties as single-line envelopes:
//
//   fistbump-swap:v1:<base64url(utf8(canonical_json))>
//
// Canonical JSON here means: no whitespace, string keys in insertion order
// (v1 is deliberately schema-locked so order doesn't need enforcing).
import { base64urlnopad } from "@scure/base";
import { fbcHTLCAddress } from "./address.js";
import { fromHex, toHex } from "./hex.js";
import { isCompressedPubkey } from "./pubkey.js";
import { buildHTLCScript, parseHTLCScript } from "./script.js";
const ENVELOPE_PREFIX = "fistbump-swap:v1:";
// Protocol block targets (SPEC §4.2). BTC and FBC heights aren't directly
// comparable — they advance on independent chains at different rates — so the
// timelock safety check must be done in wall-clock seconds relative to each
// chain's reference tip.
const BTC_BLOCK_SECONDS = 600;
const FBC_BLOCK_SECONDS = 120;
/**
 * Minimum wall-clock buffer between the two refund deadlines (SPEC §4.2).
 *
 * The invariant is `T1 - T2 >= MIN_DELTA_SECONDS`, where T1 is Alice's BTC
 * refund and T2 is Bob's FBC refund. Alice funds first and is the only party
 * who knows `s`, so her refund must be the LAST thing that becomes possible.
 *
 * Getting this backwards — requiring T2 > T1, as every v1 implementation did
 * until 2026-07-28 — opens the window [T1, T2) in which Alice can refund her
 * BTC and still claim the FBC, taking both legs. See SPEC §9.1.
 */
export const MIN_DELTA_SECONDS = 12 * 3600;
/** Reference heights must be this close to the accepter's observed tip (SPEC §4.3). */
const MAX_REF_STALENESS_BTC = 10;
const MAX_REF_STALENESS_FBC = 20;
/**
 * Neither refund branch may be live, or nearly live, at accept time.
 *
 * The FBC figure is sized for the party who has to CLAIM that leg, not the one
 * who funds it. Alice must wait out the FBC confirmation target (12 blocks,
 * ~24 min) before it is safe to claim at all, then get her claim mined with the
 * §6.1 margin of 6 blocks to spare. A T2 only 18 blocks out — the previous
 * value — is therefore already gone by the time she is allowed to act, and
 * revealing the preimage after Bob's refund is live hands him both legs.
 *
 * 60 FBC blocks is ~2 hours: the conf wait, the claim, and room for the chain
 * to run slow, with the Δ floor still governing the gap to T1.
 */
const MIN_BLOCKS_TO_REFUND_BTC = 12;
const MIN_BLOCKS_TO_REFUND_FBC = 60;
/** Nobody needs a swap whose refund is further out than this. */
const MAX_REFUND_SECONDS = 7 * 24 * 3600;
/**
 * Latest FBC height at which it is still safe to reveal the preimage.
 *
 * Past this, Bob's refund branch is close enough that a claim may lose the race
 * — and a losing claim still publishes `s` while Bob's BTC leg is live, so he
 * takes both. Callers MUST check this immediately before signing a claim, not
 * only when the offer was accepted.
 */
export function fbcClaimDeadline(offer) {
    return offer.fbc_refund_height - CLAIM_SAFETY_BLOCKS_FBC;
}
/** SPEC §6.1: broadcast the claim at least this far before T2. */
export const CLAIM_SAFETY_BLOCKS_FBC = 6;
function isHeight(v) {
    return Number.isInteger(v) && v >= 1 && v < 500_000_000;
}
/**
 * Validate an offer's four height fields.
 *
 * Two independent layers, both required:
 *
 *  1. Relative — the wall-clock Δ between the two refund deadlines, measured
 *     against each chain's own reference height.
 *  2. Absolute — every height compared against a tip this side observed for
 *     itself.
 *
 * Layer 1 alone is circular and cannot be trusted: the counterparty supplies
 * both the refund height and the reference height it is measured against, so
 * they can hold Δ at a healthy-looking 24h while placing T1 in the past. Pass
 * `observed` whenever tips are available — which is always, for the party
 * about to lock funds.
 */
export function checkTimelocks(offer, observed) {
    const fields = {
        btc_reference_height: offer.btc_reference_height,
        btc_refund_height: offer.btc_refund_height,
        fbc_reference_height: offer.fbc_reference_height,
        fbc_refund_height: offer.fbc_refund_height,
    };
    for (const [name, value] of Object.entries(fields)) {
        if (!isHeight(value)) {
            return { ok: false, reason: `${name} is not a valid block height: ${String(value)}` };
        }
    }
    // ---- Layer 1: relative (wall-clock Δ) --------------------------------
    const btcSecondsToT1 = (offer.btc_refund_height - offer.btc_reference_height) * BTC_BLOCK_SECONDS;
    const fbcSecondsToT2 = (offer.fbc_refund_height - offer.fbc_reference_height) * FBC_BLOCK_SECONDS;
    if (btcSecondsToT1 <= 0 || fbcSecondsToT2 <= 0) {
        return { ok: false, reason: "refund heights must be above their reference heights" };
    }
    const deltaSeconds = btcSecondsToT1 - fbcSecondsToT2;
    if (deltaSeconds < MIN_DELTA_SECONDS) {
        const h = (s) => (s / 3600).toFixed(1);
        return {
            ok: false,
            reason: `unsafe timelocks: the BTC refund (T1, ${h(btcSecondsToT1)}h) must fall at least ` +
                `${h(MIN_DELTA_SECONDS)}h after the FBC refund (T2, ${h(fbcSecondsToT2)}h); ` +
                `Δ = ${h(deltaSeconds)}h. Alice funds first and holds the preimage, so her refund ` +
                `must be last — otherwise she can refund her BTC and still claim the FBC (SPEC §4.2).`,
        };
    }
    if (btcSecondsToT1 > MAX_REFUND_SECONDS || fbcSecondsToT2 > MAX_REFUND_SECONDS) {
        return {
            ok: false,
            reason: `refund height too far out: max ${MAX_REFUND_SECONDS / 86400} days (SPEC §4.3)`,
        };
    }
    // ---- Layer 2: absolute (against tips we observed ourselves) ----------
    // A tip we could not read is "not observed", not "invalid". Callers pass
    // null when an explorer is briefly down, and hard-rejecting there would make
    // every offer unacceptable during an outage rather than falling back to the
    // relative check. Only a present-but-nonsensical value is an error.
    if (observed?.btcTip !== undefined && observed.btcTip !== null) {
        if (!Number.isInteger(observed.btcTip)) {
            return { ok: false, reason: "observed BTC tip is not an integer" };
        }
        const drift = offer.btc_reference_height - observed.btcTip;
        if (Math.abs(drift) > MAX_REF_STALENESS_BTC) {
            return {
                ok: false,
                reason: `btc_reference_height ${offer.btc_reference_height} is ${Math.abs(drift)} blocks ` +
                    `${drift < 0 ? "behind" : "ahead of"} the observed tip ${observed.btcTip} ` +
                    `(max ${MAX_REF_STALENESS_BTC}, SPEC §4.3)`,
            };
        }
        if (offer.btc_refund_height < observed.btcTip + MIN_BLOCKS_TO_REFUND_BTC) {
            return {
                ok: false,
                reason: `btc_refund_height ${offer.btc_refund_height} is already live or nearly live ` +
                    `against the observed tip ${observed.btcTip}`,
            };
        }
    }
    if (observed?.fbcTip !== undefined && observed.fbcTip !== null) {
        if (!Number.isInteger(observed.fbcTip)) {
            return { ok: false, reason: "observed FBC tip is not an integer" };
        }
        const drift = offer.fbc_reference_height - observed.fbcTip;
        if (Math.abs(drift) > MAX_REF_STALENESS_FBC) {
            return {
                ok: false,
                reason: `fbc_reference_height ${offer.fbc_reference_height} is ${Math.abs(drift)} blocks ` +
                    `${drift < 0 ? "behind" : "ahead of"} the observed tip ${observed.fbcTip} ` +
                    `(max ${MAX_REF_STALENESS_FBC}, SPEC §4.3)`,
            };
        }
        if (offer.fbc_refund_height < observed.fbcTip + MIN_BLOCKS_TO_REFUND_FBC) {
            return {
                ok: false,
                reason: `fbc_refund_height ${offer.fbc_refund_height} is already live or nearly live ` +
                    `against the observed tip ${observed.fbcTip}`,
            };
        }
    }
    return { ok: true };
}
export function encodeBlob(blob) {
    const json = JSON.stringify(blob);
    const bytes = new TextEncoder().encode(json);
    return ENVELOPE_PREFIX + base64urlnopad.encode(bytes);
}
export function decodeBlob(envelope) {
    const trimmed = envelope.trim();
    if (!trimmed.startsWith(ENVELOPE_PREFIX)) {
        throw new Error("not a fistbump-swap blob (missing prefix)");
    }
    const payload = trimmed.slice(ENVELOPE_PREFIX.length);
    const bytes = base64urlnopad.decode(payload);
    const json = new TextDecoder().decode(bytes);
    let parsed;
    try {
        parsed = JSON.parse(json);
    }
    catch {
        throw new Error("blob payload is not valid JSON");
    }
    return validateBlob(parsed);
}
// ---- Blob field validation ---------------------------------------------
//
// Everything below runs on bytes an attacker chose. `validateBlob` used to
// check `version` and `kind` and then cast straight to the typed interface, so
// a blob could name a kind and carry nothing else: `undefined` pubkeys, a
// negative `amount_fbc`, a 4000-character `hashlock`. TypeScript's guarantees
// stop at the network edge, and the downstream helpers all assume they hold —
// `htlcsFromOfferAccept` feeds these fields straight into `fromHex` and the
// script builder. Validate once, here, so that assumption is true.
//
// Unknown extra keys are deliberately tolerated: MM_API.md lets makers attach
// their own fields, and rejecting them would break forward compatibility.
const BTC_NETWORKS = ["main", "testnet", "regtest"];
const FBC_NETWORKS = ["main", "testnet", "regtest", "simnet"];
function fail(kind, field, why) {
    throw new Error(`${kind} blob: ${field} ${why}`);
}
/** A hex string of exactly `bytes` bytes. Case-insensitive, matching `fromHex`. */
function hexField(obj, kind, field, bytes) {
    const v = obj[field];
    if (typeof v !== "string")
        fail(kind, field, "must be a string");
    if (!new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(v)) {
        fail(kind, field, `must be exactly ${bytes * 2} hex characters`);
    }
}
function pubkeyField(obj, kind, field) {
    hexField(obj, kind, field, 33);
    if (!isCompressedPubkey(fromHex(obj[field]))) {
        fail(kind, field, "is not a valid compressed secp256k1 pubkey (02/03 prefix, on curve)");
    }
}
function nonNegIntField(obj, kind, field) {
    const v = obj[field];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
        fail(kind, field, "must be a non-negative safe integer");
    }
}
function heightField(obj, kind, field) {
    if (!isHeight(obj[field]))
        fail(kind, field, "is not a valid block height");
}
/**
 * The witness script hex. Only shape is checked here — `verifyFundedBtc` /
 * `verifyFundedFbc` rebuild the script from offer+accept and compare bytes,
 * which is the check that actually matters.
 */
function scriptHexField(obj, kind, field) {
    const v = obj[field];
    if (typeof v !== "string" || v.length === 0 || v.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(v)) {
        fail(kind, field, "must be a non-empty even-length hex string");
    }
}
function validateOffer(obj) {
    const net = obj.network;
    if (!net || typeof net !== "object")
        fail("offer", "network", "must be an object");
    const { btc, fbc } = net;
    if (typeof btc !== "string" || !BTC_NETWORKS.includes(btc)) {
        fail("offer", "network.btc", `must be one of ${BTC_NETWORKS.join(", ")}`);
    }
    if (typeof fbc !== "string" || !FBC_NETWORKS.includes(fbc)) {
        fail("offer", "network.fbc", `must be one of ${FBC_NETWORKS.join(", ")}`);
    }
    hexField(obj, "offer", "hashlock", 32);
    pubkeyField(obj, "offer", "alice_btc_pubkey");
    pubkeyField(obj, "offer", "alice_fbc_pubkey");
    nonNegIntField(obj, "offer", "amount_btc");
    nonNegIntField(obj, "offer", "amount_fbc");
    // Only shape is enforced here; the safety of the *ordering* is `checkTimelocks`.
    heightField(obj, "offer", "btc_refund_height");
    heightField(obj, "offer", "fbc_refund_height");
    heightField(obj, "offer", "btc_reference_height");
    heightField(obj, "offer", "fbc_reference_height");
    if (typeof obj.expires_at !== "string" || Number.isNaN(Date.parse(obj.expires_at))) {
        fail("offer", "expires_at", "must be an RFC 3339 timestamp");
    }
    hexField(obj, "offer", "offer_id", 16);
    return obj;
}
function validateAccept(obj) {
    hexField(obj, "accept", "offer_id", 16);
    pubkeyField(obj, "accept", "bob_btc_pubkey");
    pubkeyField(obj, "accept", "bob_fbc_pubkey");
    return obj;
}
function validateFunded(obj, kind) {
    hexField(obj, kind, "offer_id", 16);
    hexField(obj, kind, "funding_txid", 32);
    nonNegIntField(obj, kind, "funding_vout");
    nonNegIntField(obj, kind, "funding_amount");
    scriptHexField(obj, kind, "witness_script_hex");
}
function validateBlob(x) {
    if (!x || typeof x !== "object" || Array.isArray(x))
        throw new Error("blob is not an object");
    const obj = x;
    if (obj.version !== 1)
        throw new Error(`unsupported blob version: ${obj.version}`);
    switch (obj.kind) {
        case "offer":
            return validateOffer(obj);
        case "accept":
            return validateAccept(obj);
        case "funded_btc":
            validateFunded(obj, "funded_btc");
            return obj;
        case "funded_fbc":
            validateFunded(obj, "funded_fbc");
            // Optional (MM_API.md). `verifyFundedFbc` compares it against the address
            // the script actually commits to, so only the type needs checking here.
            if (obj.htlc_address !== undefined && typeof obj.htlc_address !== "string") {
                fail("funded_fbc", "htlc_address", "must be a string when present");
            }
            return obj;
        default:
            throw new Error(`unknown blob kind: ${obj.kind}`);
    }
}
/**
 * Given an OFFER and an ACCEPT, reconstruct the HTLC parameters for both
 * legs of the swap. Returns `{ btc, fbc }` where each side's script commits
 * to the right pubkeys for that chain's claim/refund roles.
 *
 * Convention (§2, §3): Alice has BTC, wants FBC. Therefore:
 *   - BTC leg: Bob claims with preimage, Alice refunds after T1.
 *   - FBC leg: Alice claims with preimage, Bob refunds after T2.
 *
 * Pass `observed` tips whenever you have them. Without them only the relative
 * Δ check runs, which an adversarial counterparty can satisfy while placing a
 * refund height in the past — see `checkTimelocks`.
 */
export function htlcsFromOfferAccept(offer, accept, observed) {
    const timelocks = checkTimelocks(offer, observed);
    if (!timelocks.ok)
        throw new Error(timelocks.reason);
    return htlcParamsForRecovery(offer, accept);
}
/**
 * Rebuild both legs' HTLC parameters WITHOUT applying timelock policy.
 *
 * Policy governs whether it is safe to *enter* a swap. Recovery is different:
 * coins already sit in an HTLC, and the only way to move them is to reconstruct
 * the exact script that locked them. Refusing to do that because the offer no
 * longer satisfies current policy would strand real funds — which is precisely
 * what happened to every in-flight swap when the Δ ordering was corrected, as
 * those offers can never satisfy the new rule.
 *
 * Structural validation (matching offer ids, well-formed on-curve pubkeys) is
 * still enforced, because a script built from malformed keys is unspendable
 * anyway. Use this only to refund or to display an existing swap — never to
 * decide whether to fund one.
 */
export function htlcParamsForRecovery(offer, accept) {
    if (offer.offer_id !== accept.offer_id) {
        throw new Error("accept.offer_id does not match offer.offer_id");
    }
    // All four keys are counterparty-influenced, and a 33-byte length check is
    // not a validity check: an off-curve `02…` key builds a perfectly well-formed
    // address whose branch no signature can ever satisfy, so whoever funds it has
    // burned that leg. `decodeBlob` covers the paste-a-blob path, but the Auto UI
    // takes the maker's ACCEPT as plain HTTP JSON and arrives here directly — the
    // one path where the counterparty is an anonymous remote server.
    for (const [field, hex] of [
        ["alice_btc_pubkey", offer.alice_btc_pubkey],
        ["alice_fbc_pubkey", offer.alice_fbc_pubkey],
        ["bob_btc_pubkey", accept.bob_btc_pubkey],
        ["bob_fbc_pubkey", accept.bob_fbc_pubkey],
    ]) {
        let key;
        try {
            key = fromHex(hex);
        }
        catch {
            throw new Error(`${field} is not valid hex`);
        }
        if (!isCompressedPubkey(key)) {
            throw new Error(`${field} is not a point on secp256k1`);
        }
    }
    const hashlock = fromHex(offer.hashlock);
    return {
        btc: {
            hashlock,
            claimPubkey: fromHex(accept.bob_btc_pubkey),
            refundPubkey: fromHex(offer.alice_btc_pubkey),
            locktime: offer.btc_refund_height,
        },
        fbc: {
            hashlock,
            claimPubkey: fromHex(offer.alice_fbc_pubkey),
            refundPubkey: fromHex(accept.bob_fbc_pubkey),
            locktime: offer.fbc_refund_height,
        },
    };
}
/**
 * Independently verify a FUNDED_BTC blob: reconstruct the expected script
 * from offer+accept and compare byte-for-byte.
 */
export function verifyFundedBtc(offer, accept, funded, observed) {
    if (funded.offer_id !== offer.offer_id) {
        return { ok: false, reason: "offer_id mismatch" };
    }
    if (funded.funding_amount !== offer.amount_btc) {
        return { ok: false, reason: "funded amount_btc does not match offer" };
    }
    if (!isTxid(funded.funding_txid)) {
        return { ok: false, reason: "funding_txid is not a 32-byte hex hash" };
    }
    if (!Number.isInteger(funded.funding_vout) || funded.funding_vout < 0) {
        return { ok: false, reason: "funding_vout is not a non-negative integer" };
    }
    let btc;
    try {
        ({ btc } = htlcsFromOfferAccept(offer, accept, observed));
    }
    catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    const expected = buildHTLCScript(btc);
    const actual = fromHex(funded.witness_script_hex);
    if (!bytesEqual(expected.scriptBytes, actual)) {
        return { ok: false, reason: "witness script does not match reconstructed HTLC" };
    }
    const parsed = parseHTLCScript(actual);
    if (!parsed) {
        return { ok: false, reason: "witness script is not a canonical HTLC" };
    }
    return { ok: true };
}
/**
 * Mirror of `verifyFundedBtc` for the FBC leg.
 *
 * NOTE: this proves the blob is internally consistent with the offer. It says
 * nothing about the chain. The caller MUST separately confirm that
 * `funding_txid:funding_vout` exists on FBC, pays `htlc_address` for
 * `funding_amount`, and has enough confirmations — never trust a counterparty's
 * self-reported confirmation count.
 */
export function verifyFundedFbc(offer, accept, funded, observed) {
    if (funded.offer_id !== offer.offer_id) {
        return { ok: false, reason: "offer_id mismatch" };
    }
    if (funded.funding_amount !== offer.amount_fbc) {
        return { ok: false, reason: "funded amount_fbc does not match offer" };
    }
    if (!isTxid(funded.funding_txid)) {
        return { ok: false, reason: "funding_txid is not a 32-byte hex hash" };
    }
    if (!Number.isInteger(funded.funding_vout) || funded.funding_vout < 0) {
        return { ok: false, reason: "funding_vout is not a non-negative integer" };
    }
    let fbc;
    try {
        ({ fbc } = htlcsFromOfferAccept(offer, accept, observed));
    }
    catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    const expected = buildHTLCScript(fbc);
    const actual = fromHex(funded.witness_script_hex);
    if (!bytesEqual(expected.scriptBytes, actual)) {
        return { ok: false, reason: "witness script does not match reconstructed HTLC" };
    }
    // The address the counterparty claims to have funded must be the address
    // this script actually commits to — otherwise they can hand us a valid
    // script alongside an unrelated outpoint.
    if (funded.htlc_address) {
        const network = (offer.network?.fbc ?? "main");
        let derived;
        try {
            derived = fbcHTLCAddress(expected, network);
        }
        catch {
            return { ok: false, reason: `unknown FBC network "${offer.network?.fbc}"` };
        }
        if (funded.htlc_address !== derived) {
            return {
                ok: false,
                reason: `htlc_address ${funded.htlc_address} does not match the script's address ${derived}`,
            };
        }
    }
    return { ok: true };
}
function isTxid(v) {
    return typeof v === "string" && /^[0-9a-f]{64}$/i.test(v);
}
function bytesEqual(a, b) {
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++)
        if (a[i] !== b[i])
            return false;
    return true;
}
/** Generate a 16-byte random offer_id, formatted as 32 lowercase hex chars. */
export function generateOfferId() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return toHex(bytes);
}
//# sourceMappingURL=offer.js.map