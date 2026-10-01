import { describe, expect, it } from "vitest";
import { formatCrcAssetId, parseCrcAssetId, parseCrcPageCursor, parseCrcWalletCursor, projectCrcAsset } from "./crc-read";

const txid = "a".repeat(64);

describe("Cove CRC read contract", () => {
  it("uses network and deployment transaction as the asset identity", () => {
    expect(formatCrcAssetId("signet", txid)).toBe(`signet:${txid}`);
    expect(parseCrcAssetId(`signet:${txid}`, "signet")).toEqual({ network: "signet", deployTxid: txid });
    expect(parseCrcAssetId(`mainnet:${txid}`, "signet")).toBeNull();
    expect(parseCrcAssetId(`signet:${txid.toUpperCase()}`, "signet")).toBeNull();
    expect(parseCrcAssetId("LEAF", "signet")).toBeNull();
    expect(parseCrcAssetId(txid, "signet")).toBeNull();
  });

  it("keeps equal tickers from different deployments distinct and emits decimal strings", () => {
    const base = {
      network: "signet",
      ticker: "COVE",
      deployHeight: 100n,
      deployBlockHash: "b".repeat(64),
      creatorScriptHex: "0014" + "1".repeat(40),
      protocolScriptHex: "0014" + "2".repeat(40),
      txid: "c".repeat(64),
      vout: 2,
      scriptHex: "0014" + "3".repeat(40),
      btcSats: 1_000n,
      mintedAtoms: 200_000_000_000n,
      inventoryAtoms: 100_000_000_000n,
      protocolVersion: 3,
      burnedAtoms: 50_000_000_000n,
      availability: "active",
    };
    const first = projectCrcAsset({ ...base, deployTxid: txid });
    const second = projectCrcAsset({ ...base, deployTxid: "d".repeat(64) });
    expect(first.assetId).not.toBe(second.assetId);
    expect(first.ticker).toBe(second.ticker);
    expect(first.circulatingAtoms).toBe("100000000000");
    expect(first.protocolVersion).toBe(3);
    expect(first.burnedAtoms).toBe("50000000000");
    expect(first.vault.btcSats).toBe("1000");
    expect(() => JSON.stringify(first)).not.toThrow();
    expect(projectCrcAsset({ ...base, deployTxid: txid, protocolVersion: 3 }).protocolVersion).toBe(3);
  });

  it("rejects inconsistent database projections before displaying a market", () => {
    expect(() => projectCrcAsset({
      network: "signet", deployTxid: txid, ticker: "BAD", deployHeight: 1n,
      deployBlockHash: "b".repeat(64), creatorScriptHex: "00", protocolScriptHex: "00",
      txid: txid, vout: 1, scriptHex: "00", btcSats: 0n,
      mintedAtoms: 0n, inventoryAtoms: 1n, protocolVersion: 1,
      burnedAtoms: null, availability: "active",
    })).toThrow(/inconsistent/i);
  });

  it("accepts only exact keyset cursors for bounded catalog paging", () => {
    expect(parseCrcPageCursor(`12:${txid}`)).toEqual({ height: 12n, deployTxid: txid });
    expect(parseCrcPageCursor(`012:${txid}`)).toBeNull();
    expect(parseCrcPageCursor(`-1:${txid}`)).toBeNull();
    expect(parseCrcPageCursor(`12:${txid.toUpperCase()}`)).toBeNull();
    expect(parseCrcPageCursor("garbage")).toBeNull();
  });

  it("accepts only exact wallet balance cursors", () => {
    expect(parseCrcWalletCursor(`100:${txid}`)).toEqual({ atoms: 100n, deployTxid: txid });
    expect(parseCrcWalletCursor(`000:${txid}`)).toBeNull();
    expect(parseCrcWalletCursor("100:LEAF")).toBeNull();
  });
});
