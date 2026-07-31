// Shared between the HTTP layer and the persisted swap view, both of which
// hand strings to unauthenticated callers.

/**
 * Errors a caller is allowed to see.
 *
 * Validation failures are useful to an honest counterparty and reveal nothing
 * they did not already send us. Everything else — RPC failures, node
 * addresses, wallet balances — collapses to a generic string, with the detail
 * left in the log.
 */
const SAFE_ERROR_PATTERNS = [
  /^invalid offer/i,
  /^network mismatch/i,
  /^offer_id /i,
  /^bad (hashlock|alice_)/i,
  /^unknown( or already-used)? (quote|swap)/i,
  /^quote expired/i,
  /^offer amounts do not match quote/i,
  /^unsafe timelocks/i,
  /^refund heights? /i,
  /^(btc|fbc)_(reference|refund)_height/i,
  /^insufficient/i,
  /^cannot fund in state/i,
  /^expected funded_btc/i,
  /^funding_(txid|vout) /i,
  /^swap is already bound/i,
  /^funding outpoint already used/i,
  /^witness script /i,
  /^amount mismatch/i,
  /^address mismatch/i,
  /^outpoint .* is not in the UTXO set/i,
  /^request body (too large|timed out)/i,
  /^amount must be positive/i,
  // Units diagnostics. These echo only what the caller sent us, and saying
  // which unit was expected is the entire point of the check.
  /^amount_btc is whole BTC/i,
  /^amount_sat must be/i,
  /^below minimum/i,
  /^exceeds max/i,
  // Side diagnostics. The old /^only buy_fbc supported/ string no longer
  // exists — these replace it rather than joining it.
  /^side is required/i,
  /^unsupported side/i,
  /^quote_id and offer required/i,
  /^liquidity check unavailable/i,
  /^too many unfunded swaps/i,
  // A stalled refund is our problem, not the caller's, but it names only a
  // txid that is already public and tells a counterparty something true about
  // where the swap stands.
  /^FBC refund [0-9a-f]{64} unconfirmed/i,
];

export function publicError(message: string): string {
  if (SAFE_ERROR_PATTERNS.some((re) => re.test(message))) return message;
  return "request could not be processed";
}
