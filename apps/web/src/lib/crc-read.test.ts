import * as core from "@crclaunch/crc20-protocol";
import { describe, expect, it } from "vitest";
import {
  formatCrcAssetId,
  parseCrcAssetId,
  parseCrcPageCursor,
  parseCrcWalletCursor,
  projectCrcAsset,
} from "./crc-read";

const txid = "a".repeat(64);

describe("Cove CRC read contract", () => {
  it("uses network and deployment transaction as the asset identity", () => {
    expect(formatCrcAssetId("signet", txid)).toBe(`signet:${txid}`);
    expect(parseCrcAssetId(`signet:${txid}`, "signet")).toEqual({
      network: "signet",
      deployTxid: txid,
    });
    expect(parseCrcAssetId(`mainnet:${txid}`, "signet")).toBeNull();
    expect(parseCrcAssetId(`signet:${txid.toUpperCase()}`, "signet")).toBeNull();
    expect(parseCrcAssetId("LEAF", "signet")).toBeNull();
    expect(parseCrcAssetId(txid, "signet")).toBeNull();
  });

  it("maps core state to the existing asset DTO with canonical decimal amounts", () => {
    const asset = {
      config: {
        network: "signet",
        ticker: "COVE",
        vaultScriptHex: "0014" + "3".repeat(40),
        creatorScriptHex: "0014" + "1".repeat(40),
        protocolScriptHex: "0014" + "2".repeat(40),
      },
      deployTxid: txid,
      issuedAtoms: 200000000000n,
      inventoryAtoms: 100000000000n,
      burnedAtoms: 50000000000n,
      vault: { txid: "c".repeat(64), vout: 2, sats: 1000n, scriptHex: "0014" + "3".repeat(40) },
    };
    const row = {
      valueJson: core.encodeProtocolDto(asset),
      deployHeight: "100",
      deployBlockHash: "b".repeat(64),
      displayName: null,
      description: null,
      websiteUrl: null,
      xUrl: null,
      imageUrl: null,
    };
    const first = projectCrcAsset(row, "signet");
    const second = projectCrcAsset(
      { ...row, valueJson: core.encodeProtocolDto({ ...asset, deployTxid: "d".repeat(64) }) },
      "signet",
    );
    expect(first.assetId).not.toBe(second.assetId);
    expect(first.ticker).toBe(second.ticker);
    expect(first.circulatingAtoms).toBe("100000000000");
    expect(first.burnedAtoms).toBe("50000000000");
    expect(first.vault.btcSats).toBe("1000");
    expect(() => JSON.stringify(first)).not.toThrow();
    expect(() => projectCrcAsset(row, "regtest")).toThrow(/network/i);
    expect(() => projectCrcAsset({ ...row, valueJson: {} }, "signet")).toThrow();
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
