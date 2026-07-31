// Lowercase-hex encoding. Accepts uppercase on decode, emits lowercase on
// encode (matching fbd's wire format).

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Decode lowercase or uppercase hex. Strict: anything that is not an
 * even-length run of `[0-9a-fA-F]` throws.
 *
 * The strictness is the point. This used to be a bare `parseInt(pair, 16)`
 * loop, and `parseInt` is a text-scanner, not a decoder: it skips leading
 * whitespace, honours a `+`/`-` sign, and stops at the first character it
 * doesn't like. So `" f"`, `"-1"`, and `"0x"` all decoded to *some* byte here
 * while fbd's decoder — and every other strict decoder on either chain —
 * rejects them. That gap lets a counterparty hand over a script hex or pubkey
 * that this library and the chain disagree about the meaning of.
 */
export function fromHex(hex: string): Uint8Array {
  // Reachable from plain-JS callers (the app layer is untyped), and from blob
  // fields, so the type annotation alone isn't a guarantee.
  if (typeof hex !== "string") throw new Error("hex must be a string");
  if (hex.length % 2 !== 0) throw new Error("hex must have even length");
  if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error("hex contains non-hex characters");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
