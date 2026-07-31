// Minimal, dependency-free PSBT + bech32 decoding, written to CHECK the PSBT
// rather than to build one. Deliberately a second implementation: verifying a
// file with the same library that produced it only proves it is self-consistent.

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
function hrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}
function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0;
  const out = [], maxv = (1 << to) - 1;
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
  }
  if (pad && bits) out.push((acc << (to - bits)) & maxv);
  return out;
}
export function encodeSegwitAddress(hrp, version, program) {
  const data = [version, ...convertBits(Array.from(program), 8, 5, true)];
  const constant = version === 0 ? 1 : 0x2bc830a3;
  const pm = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ constant;
  const cks = [];
  for (let i = 0; i < 6; i++) cks.push((pm >> (5 * (5 - i))) & 31);
  return hrp + "1" + [...data, ...cks].map((d) => CHARSET[d]).join("");
}
/** A scriptPubKey we can name. Returns null for anything non-segwit. */
export function scriptToAddress(script, hrp = "bc") {
  if (script.length < 4 || script.length > 42) return null;
  const version = script[0] === 0 ? 0 : script[0] - 0x50;
  if (version < 0 || version > 16) return null;
  const len = script[1];
  if (script.length !== len + 2) return null;
  if (version === 0 && len !== 20 && len !== 32) return null;
  return encodeSegwitAddress(hrp, version, script.slice(2));
}

const rev = (b) => Array.from(b).reverse().map((x) => x.toString(16).padStart(2, "0")).join("");
const hex = (b) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

class Reader {
  constructor(bytes) { this.b = bytes; this.i = 0; }
  u8() { return this.b[this.i++]; }
  take(n) { const s = this.b.slice(this.i, this.i + n); this.i += n; return s; }
  // `|` yields a signed int32, so 0xfffffffd came back as -3. nSequence is
  // compared against 0xffffffff to decide whether CLTV is even active, so a
  // sign flip here would silently invert a safety check.
  u32() { const s = this.take(4); return ((s[0] | (s[1] << 8) | (s[2] << 16)) >>> 0) + s[3] * 0x1000000; }
  u64() { const s = this.take(8); let v = 0n; for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(s[k]); return Number(v); }
  varint() {
    const n = this.u8();
    if (n < 0xfd) return n;
    if (n === 0xfd) { const s = this.take(2); return s[0] | (s[1] << 8); }
    if (n === 0xfe) return this.u32();
    return this.u64();
  }
  get done() { return this.i >= this.b.length; }
}

function parseUnsignedTx(bytes) {
  const r = new Reader(bytes);
  const version = r.u32();
  const nIn = r.varint();
  const vin = [];
  for (let k = 0; k < nIn; k++) {
    const txid = rev(r.take(32));
    const vout = r.u32();
    const slen = r.varint();
    r.take(slen);
    vin.push({ txid, vout, sequence: r.u32() });
  }
  const nOut = r.varint();
  const vout = [];
  for (let k = 0; k < nOut; k++) {
    const value = r.u64();
    const slen = r.varint();
    vout.push({ value, script: r.take(slen) });
  }
  return { version, vin, vout, locktime: r.u32() };
}

/** Decode enough of a PSBT to describe and check it. */
export function decodePsbt(bytes) {
  const r = new Reader(bytes);
  const magic = hex(r.take(5));
  if (magic !== "70736274ff") throw new Error("not a PSBT (bad magic)");
  const readMap = () => {
    const map = [];
    for (;;) {
      if (r.done) throw new Error("truncated PSBT");
      const klen = r.varint();
      if (klen === 0) return map;
      const key = r.take(klen);
      const vlen = r.varint();
      map.push({ type: key[0], keyData: key.slice(1), value: r.take(vlen) });
    }
  };
  const global = readMap();
  const txEntry = global.find((e) => e.type === 0x00);
  if (!txEntry) throw new Error("PSBT has no unsigned transaction");
  const tx = parseUnsignedTx(txEntry.value);
  const inputs = tx.vin.map(() => (r.done ? [] : readMap()));
  return {
    tx,
    inputs: inputs.map((map) => {
      const wu = map.find((e) => e.type === 0x01);
      let witnessUtxo = null;
      if (wu) {
        const rr = new Reader(wu.value);
        const amount = rr.u64();
        const slen = rr.varint();
        witnessUtxo = { amount, script: rr.take(slen) };
      }
      const sighashEntry = map.find((e) => e.type === 0x03);
      return {
        witnessUtxo,
        witnessScript: map.find((e) => e.type === 0x05)?.value ?? null,
        redeemScript: map.find((e) => e.type === 0x04)?.value ?? null,
        sighashType: sighashEntry ? new Reader(sighashEntry.value).u32() : null,
        partialSigs: map.filter((e) => e.type === 0x02).length,
        finalWitness: map.find((e) => e.type === 0x08)?.value ?? null,
      };
    }),
  };
}
