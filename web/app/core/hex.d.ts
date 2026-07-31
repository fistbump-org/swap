export declare function toHex(bytes: Uint8Array): string;
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
export declare function fromHex(hex: string): Uint8Array;
//# sourceMappingURL=hex.d.ts.map