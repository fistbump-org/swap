export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Strict hex decode.
 *
 * Every byte this parses came from a taker over HTTP. `parseInt` returns NaN
 * on a non-hex pair, which a Uint8Array silently stores as 0x00 — so
 * "witness_script_hex": "zz…" used to decode to a run of zero bytes and then be
 * compared against a script we built ourselves, rather than being rejected as
 * malformed. No `0x` prefix is accepted either: the protocol's hex fields never
 * carry one, and stripping it here would make two decoders disagree about the
 * same string.
 */
export function fromHex(hex: string): Uint8Array {
  if (typeof hex !== "string") throw new Error("hex must be a string");
  if (hex.length % 2 !== 0) throw new Error("odd hex length");
  if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error("hex contains non-hex characters");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
