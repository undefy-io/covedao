import { describe, expect, it } from "vitest";
import { applyCrcBlock, rollbackCrcBlock, type CrcProjection } from "./persistence.js";

const deploy = "11".repeat(32);
const assetId = `regtest:${deploy}`;
const vault = `5120${"22".repeat(32)}`;
const owner = `0014${"33".repeat(20)}`;
const coin = `${"44".repeat(32)}:1`;
const asset = { ticker: "COVE", deployTxid: deploy, deployHeight: 100,
  deployBlockHash: "aa".repeat(32), launchSaltHex: "bb".repeat(32),
  creatorScriptHex: owner, protocolScriptHex: vault,
  protocolVersion: 3 as const, burnedAtoms: "0" };
const deployed: CrcProjection = {
  assets: { [assetId]: asset },
  vaults: { [assetId]: { txid: deploy, vout: 1, scriptHex: vault, btcSats: "330",
    mintedAtoms: "0", inventoryAtoms: "0", availability: "active" } },
  balances: {}, tokenUtxos: { [assetId]: {} },
};

describe("Garden-shaped Cove projection", () => {
  it("rolls back minted token output and later burn exactly", () => {
    const minted: CrcProjection = {
      assets: deployed.assets,
      vaults: { [assetId]: { ...deployed.vaults[assetId]!, txid: "44".repeat(32),
        vout: 2, btcSats: "357", mintedAtoms: "100000000000" } },
      balances: { [assetId]: { [owner]: "100000000000" } },
      tokenUtxos: { [assetId]: { [coin]: { scriptHex: owner, atoms: "100000000000",
        createdHeight: 101, createdBlockHash: "cc".repeat(32) } } },
    };
    const buy = applyCrcBlock(deployed, minted, "regtest");
    expect(rollbackCrcBlock(buy.state, buy.undo)).toEqual(deployed);
    const burned: CrcProjection = { ...minted,
      assets: { [assetId]: { ...asset, burnedAtoms: "100000000000" } },
      balances: {}, tokenUtxos: { [assetId]: {} } };
    const spend = applyCrcBlock(minted, burned, "regtest");
    expect(rollbackCrcBlock(spend.state, spend.undo)).toEqual(minted);
  });

  it("rejects a projection without token authority", () => {
    expect(() => applyCrcBlock(deployed, { ...deployed, tokenUtxos: undefined }, "regtest")).toThrow(/token UTXO/i);
  });
});
