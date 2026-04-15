// Preimage / hashlock helpers.
//
// Alice generates the preimage via CSPRNG and shares only the hashlock.
// The preimage itself MUST stay private until Alice broadcasts her claim;
// once on-chain the preimage becomes public and Bob uses it to claim BTC.
import { sha256 } from "@noble/hashes/sha256";
/** Generate a fresh 32-byte preimage from the platform CSPRNG. */
export function generatePreimage() {
    const s = new Uint8Array(32);
    crypto.getRandomValues(s);
    return s;
}
/** Compute the hashlock `h = SHA-256(preimage)`. */
export function hashlockOf(preimage) {
    if (preimage.length !== 32)
        throw new Error("preimage must be 32 bytes");
    return sha256(preimage);
}
//# sourceMappingURL=preimage.js.map