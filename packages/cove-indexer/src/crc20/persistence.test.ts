import { describe, expect, it } from "vitest";
import { applyCrcBlock, rollbackCrcBlock, type CrcProjection } from "./persistence.js";

const deploy = "11".repeat(32);
const assetId = `regtest:${deploy}`;
const empty: CrcProjection = { assets: {}, vaults: {}, balances: {} };
const first: CrcProjection = {
  assets: { [assetId]: { ticker: "COVE", deployTxid: deploy, deployHeight: 100, deployBlockHash: "aa".repeat(32), launchSaltHex: "ab".repeat(32), creatorScriptHex: "0014" + "22".repeat(20), protocolScriptHex: "0014" + "33".repeat(20) } },
  vaults: { [assetId]: { txid: deploy, vout: 1, scriptHex: "5120" + "44".repeat(32), btcSats: "10000", mintedAtoms: "0", inventoryAtoms: "0", availability: "active" } },
  balances: {},
};
const bought: CrcProjection = {
  assets: first.assets,
  vaults: { [assetId]: { ...first.vaults[assetId]!, txid: "55".repeat(32), btcSats: "11000", mintedAtoms: "100000000000" } },
  balances: { [assetId]: { ["0014" + "66".repeat(20)]: "100000000000" } },
};

describe("CRC canonical projection", () => {
  it("records only changed rows and restores deploy on rollback", () => {
    const applied = applyCrcBlock(empty, first, "regtest");
    expect(applied.undo.assets[assetId]).toBeNull();
    expect(rollbackCrcBlock(applied.state, applied.undo)).toEqual(empty);
  });

  it("restores vault and balances across same-height branch competition", () => {
    const applied = applyCrcBlock(first, bought, "regtest");
    expect(applied.undo.assets).toEqual({});
    expect(rollbackCrcBlock(applied.state, applied.undo)).toEqual(first);
    expect(applyCrcBlock(first, first, "regtest").state).toEqual(first);
  });

  it("rejects out-of-network asset keys and negative balances", () => {
    const wrong = structuredClone(first);
    wrong.assets[`signet:${deploy}`] = wrong.assets[assetId]!;
    expect(() => applyCrcBlock(empty, wrong, "regtest")).toThrow();
    const bad = structuredClone(bought);
    bad.balances[assetId]!["0014" + "66".repeat(20)] = "-1";
    expect(() => applyCrcBlock(first, bad, "regtest")).toThrow();
  });
});
