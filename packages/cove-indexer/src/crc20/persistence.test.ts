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
const tokenOutpoint = `${"77".repeat(32)}:1`;
const v2Owned: CrcProjection = {
  assets: { [assetId]: { ...first.assets[assetId]!, protocolVersion: 2, burnedAtoms: "0" } },
  vaults: { [assetId]: { ...first.vaults[assetId]!, txid: "77".repeat(32), vout: 2, mintedAtoms: "100000000000" } },
  balances: { [assetId]: { ["0014" + "66".repeat(20)]: "100000000000" } },
  tokenUtxos: { [assetId]: { [tokenOutpoint]: {
    scriptHex: "0014" + "66".repeat(20), atoms: "100000000000",
    createdHeight: 101, createdBlockHash: "bb".repeat(32),
  } } },
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

  it("undoes v2 coin creation, spend, burn and same-height replacement exactly", () => {
    const deployedV2: CrcProjection = {
      assets: { [assetId]: { ...first.assets[assetId]!, protocolVersion: 2, burnedAtoms: "0" } },
      vaults: first.vaults, balances: {}, tokenUtxos: { [assetId]: {} },
    };
    const buy = applyCrcBlock(deployedV2, v2Owned, "regtest");
    expect(buy.undo.tokenUtxos?.[assetId]?.[tokenOutpoint]).toBeNull();
    expect(rollbackCrcBlock(buy.state, buy.undo)).toEqual(deployedV2);
    const burned = structuredClone(v2Owned);
    burned.assets[assetId]!.burnedAtoms = "100000000000";
    burned.tokenUtxos![assetId] = {};
    burned.balances = {};
    const spend = applyCrcBlock(v2Owned, burned, "regtest");
    expect(spend.undo.tokenUtxos?.[assetId]?.[tokenOutpoint]).toEqual(v2Owned.tokenUtxos![assetId]![tokenOutpoint]);
    expect(rollbackCrcBlock(spend.state, spend.undo)).toEqual(v2Owned);
    expect(applyCrcBlock(v2Owned, v2Owned, "regtest").state).toEqual(v2Owned);
  });

  it("rejects duplicate v2 authority across assets and balances not derived from coins", () => {
    const duplicate = structuredClone(v2Owned);
    const other = `regtest:${"99".repeat(32)}`;
    duplicate.assets[other] = { ...duplicate.assets[assetId]!, deployTxid: "99".repeat(32) };
    duplicate.vaults[other] = { ...duplicate.vaults[assetId]! };
    duplicate.tokenUtxos![other] = { [tokenOutpoint]: { ...duplicate.tokenUtxos![assetId]![tokenOutpoint]! } };
    duplicate.balances[other] = { ...duplicate.balances[assetId]! };
    expect(() => applyCrcBlock(v2Owned, duplicate, "regtest")).toThrow(/duplicate|outpoint/i);
    const forged = structuredClone(v2Owned);
    forged.balances[assetId]!["0014" + "66".repeat(20)] = "200000000000";
    expect(() => applyCrcBlock(v2Owned, forged, "regtest")).toThrow(/balance/i);
  });

  it("burns broken vault inventory while preserving user coins and rollback", () => {
    const vaultPoint = `${v2Owned.vaults[assetId]!.txid}:2`;
    const active = structuredClone(v2Owned);
    active.vaults[assetId]!.inventoryAtoms = "40000000000";
    active.balances[assetId]!["0014" + "66".repeat(20)] = "60000000000";
    active.balances[assetId]![active.vaults[assetId]!.scriptHex] = "40000000000";
    active.tokenUtxos![assetId]![tokenOutpoint]!.atoms = "60000000000";
    active.tokenUtxos![assetId]![vaultPoint] = {
      scriptHex: active.vaults[assetId]!.scriptHex,
      atoms: "40000000000",
      createdHeight: 101,
      createdBlockHash: "bb".repeat(32),
    };
    const broken = structuredClone(active);
    broken.vaults[assetId]!.availability = "unavailable";
    broken.assets[assetId]!.burnedAtoms = "40000000000";
    delete broken.tokenUtxos![assetId]![vaultPoint];
    delete broken.balances[assetId]![active.vaults[assetId]!.scriptHex];

    const applied = applyCrcBlock(active, broken, "regtest");
    expect(applied.state.tokenUtxos![assetId]![tokenOutpoint]!.atoms).toBe("60000000000");
    expect(rollbackCrcBlock(applied.state, applied.undo)).toEqual(active);
  });
});
