import { test, expect } from "vitest";
import * as core from "./index.js";
test("public asset quote preflight uses the builder's vault validation", () => {
  const script = "0014" + "11".repeat(20);
  const state = {
    config: {
      network: "regtest",
      ticker: "TEST",
      vaultScriptHex: script,
      creatorScriptHex: script,
      protocolScriptHex: script,
    },
    deployTxid: "a".repeat(64),
    issuedAtoms: 100000000000n,
    inventoryAtoms: 0n,
    burnedAtoms: 0n,
    vault: { txid: "b".repeat(64), vout: 2, sats: 1027n, scriptHex: script },
  };
  expect(() => core.validateAssetVault(state)).not.toThrow();
  expect(() =>
    core.validateAssetVault({ ...state, vault: { ...state.vault, sats: 1026n } }),
  ).toThrow(/backing/);
  expect(() => core.validateAssetVault({ ...state, vaultAvailable: false })).toThrow(/unavailable/);
  expect(core.quoteSell(state, 100000000000n)).toMatchObject({
    sellerPayoutSats: 1000n,
    walletTopUpSats: 1973n,
  });
});
