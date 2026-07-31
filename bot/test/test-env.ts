/**
 * Configuration the test suite pins for itself.
 *
 * `config.ts` snapshots process.env at import time and fills the gaps from
 * bot/.env — which is untracked operator configuration. That made these tests
 * assert against whatever the machine happened to be configured for, and on the
 * author's own box bot/.env carries the INVERTED timelock ordering, so importing
 * anything that reaches config.ts throws before a single test runs. The npm
 * script papered over it with inline env vars, which only moved the dependency.
 *
 * Import this module FIRST in every test file: ES modules are evaluated in
 * import order, so it must be listed above anything that reaches config.ts.
 * Values are set unconditionally so an inherited environment cannot win.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PINNED = {
  BTC_REFUND_HOURS: "48",
  FBC_REFUND_HOURS: "24",
  MIN_DELTA_HOURS: "12",
  BTC_NETWORK: "main",
  FBD_NETWORK: "main",
  BTC_CONF_TARGET: "6",
  FBC_CONF_TARGET: "12",
  BTC_CLAIM_BURIAL_CONFS: "6",
  FBC_REFUND_BURIAL_CONFS: "12",
  BTC_CLAIM_GIVE_UP_BLOCKS: "12",
  MAX_REF_STALENESS_BTC: "10",
  MAX_REF_STALENESS_FBC: "20",
  MIN_BTC_SAT: "10000",
  MAX_FBC: "100000",
  SPREAD_BPS: "50",
  ACCEPT_RESERVE_MS: "1800000",
  // Nothing under test writes here, but config.dataDir must not point at the
  // operator's live ./data if something ever does.
  DATA_DIR: mkdtempSync(join(tmpdir(), "mm-test-data-")),
} as const;

for (const [k, v] of Object.entries(PINNED)) process.env[k] = v;

export const ACCEPT_RESERVE_MS = Number(PINNED.ACCEPT_RESERVE_MS);
