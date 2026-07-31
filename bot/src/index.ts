import { startAnnouncing } from "./announce.js";
import { startApi } from "./api.js";
import { config } from "./config.js";
import { MarketMaker } from "./mm.js";

async function main() {
  console.log("[mm-bot] starting (FBC liquidity → buy FBC with BTC)");
  if (!config.bitcoinRpcUrl) {
    throw new Error(
      "BTC_RPC_URL is required — chain data comes from your Bitcoin Core node, not explorers",
    );
  }
  if (!config.fbdRpcUrl) {
    throw new Error("FBD_RPC_URL is required — FBC chain data comes from your fbd node");
  }
  console.log(
    `[mm-bot] bitcoin: Core RPC ${config.bitcoinRpcUrl.replace(/\/\/.*@/, "//***@")}` +
      (config.bitcoinRpcWallet ? ` wallet=${config.bitcoinRpcWallet}` : ""),
  );
  console.log(
    `[mm-bot] fbc: fbd RPC ${config.fbdRpcUrl.replace(/\/\/.*@/, "//***@")} wallet=${config.fbdWallet}`,
  );
  if (config.fbcUsdPrice > 0) {
    console.log(
      `[mm-bot] price peg FBC=$${config.fbcUsdPrice} USD (BTC feed=${config.btcUsdSource}) spread=${config.spreadBps}bps`,
    );
  } else {
    console.log(
      `[mm-bot] mid=${config.midFbcPerBtc} FBC/BTC (static) spread=${config.spreadBps}bps`,
    );
  }

  // Catch a mainnet wallet pointed at a testnet node (or vice versa) before
  // any key material or inventory is touched.
  const { bitcoindAssertNetwork } = await import("./bitcoind.js");
  await bitcoindAssertNetwork(config.btcNetwork);

  const mm = new MarketMaker();
  await mm.start();
  // warm price cache
  try {
    const { getMidFbcPerBtc } = await import("./price.js");
    const px = await getMidFbcPerBtc();
    console.log(
      `[mm-bot] live mid ≈ ${Math.round(px.midFbcPerBtc)} FBC/BTC (BTC=$${px.btcUsd.toFixed(2)} via ${px.source})`,
    );
  } catch (err) {
    console.warn("[mm-bot] price feed warm-up failed:", err instanceof Error ? err.message : err);
  }
  startApi(mm);
  // Separate listener, separate bind, its own token. Started after the public
  // API so a misconfigured dashboard cannot stop the maker from serving quotes
  // — except when the token is missing entirely, which throws on purpose.
  const { startAdminServer } = await import("./admin.js");
  startAdminServer(mm);
  startAnnouncing();
}

main().catch((err) => {
  console.error("[mm-bot] fatal", err);
  process.exit(1);
});
