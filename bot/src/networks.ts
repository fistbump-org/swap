/**
 * Bitcoin network parameters, in one place.
 *
 * Regtest is not TEST_NETWORK: its bech32 HRP is `bcrt`, not `tb`. Every
 * consumer that mapped it to TEST_NETWORK derived `tb1…` addresses on regtest
 * and then rejected the `bcrt1…` ones htlc.ts builds, so the claim path could
 * not be rehearsed anywhere except mainnet. The mapping lives here so a new
 * consumer cannot get it wrong independently.
 */

import * as btc from "@scure/btc-signer";

export const REGTEST: typeof btc.NETWORK = {
  bech32: "bcrt",
  pubKeyHash: 0x6f,
  scriptHash: 0xc4,
  wif: 0xef,
};

export const NETWORKS = {
  main: btc.NETWORK,
  testnet: btc.TEST_NETWORK,
  regtest: REGTEST,
} as const;

export type BtcNetworkName = keyof typeof NETWORKS;

export function networkParams(name: BtcNetworkName): typeof btc.NETWORK {
  const net = NETWORKS[name];
  if (!net) throw new Error(`unknown bitcoin network ${name}`);
  return net;
}
