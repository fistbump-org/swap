/** Generate a fresh 32-byte preimage from the platform CSPRNG. */
export declare function generatePreimage(): Uint8Array;
/** Compute the hashlock `h = SHA-256(preimage)`. */
export declare function hashlockOf(preimage: Uint8Array): Uint8Array;
//# sourceMappingURL=preimage.d.ts.map