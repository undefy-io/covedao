import { describe, expect, it } from "vitest";
import * as core from "@crclaunch/crc20-protocol";
import { CrcQuoteError, quoteCrcBuy, quoteCrcSell } from "./crc-quote";
const txid = "a".repeat(64),
  script = "0014" + "11".repeat(20);
const config = {
  network: "signet",
  ticker: "TEST",
  vaultScriptHex: script,
  creatorScriptHex: script,
  protocolScriptHex: script,
};
const state: core.Asset = {
  config,
  deployTxid: txid,
  issuedAtoms: 0n,
  inventoryAtoms: 0n,
  burnedAtoms: 0n,
  vault: { txid, vout: 1, sats: 1000n, scriptHex: script },
};
function asset(input = state) {
  return {
    assetId: `signet:${txid}`,
    mintedAtoms: input.issuedAtoms.toString(),
    inventoryAtoms: input.inventoryAtoms.toString(),
    circulatingAtoms: (input.issuedAtoms - input.inventoryAtoms).toString(),
    availability: "active" as const,
    vaultAnchorSats: "1000",
    vault: {
      txid: input.vault.txid,
      vout: input.vault.vout,
      btcSats: core.sats(input.vault.sats).toString(),
    },
    coreState: core.encodeProtocolDto(input),
  };
}
describe("CRC shared-core quotes", () => {
  it("maps exact core mint economics without RPC", () => {
    expect(quoteCrcBuy(asset(), 100000000000n)).toMatchObject({
      operation: "mint",
      amountAtoms: "100000000000",
      grossSats: "27",
      protocolFeeSats: "5013",
      creatorFeeSats: "546",
      buyerTotalSats: "5586",
      vaultOutpoint: `${txid}:1`,
    });
  });
  it("maps the core sell settlement and explicitly excludes miner fees/carrier credits", () => {
    const minted = { ...state, issuedAtoms: 100000000000n, vault: { ...state.vault, sats: 1027n } };
    expect(quoteCrcSell(asset(minted), 100000000000n, script)).toMatchObject({
      operation: "transfer",
      grossSats: "27",
      protocolFeeSats: "1000",
      sellerPayoutSats: "1000",
      walletTopUpSats: "1973",
      sellerNetSats: "-973",
      minerFeeExcluded: true,
      walletTopUpExcludesCarrierCredits: true,
    });
  });
  it("rejects unavailable, inconsistent and inventory-crossing state through the core", () => {
    expect(() => quoteCrcBuy({ ...asset(), availability: "unavailable" }, 100000000000n)).toThrow(
      /unavailable/i,
    );
    expect(() =>
      quoteCrcBuy(asset({ ...state, vault: { ...state.vault, sats: 999n } }), 100000000000n),
    ).toThrow(/backing/i);
    expect(() =>
      quoteCrcBuy(
        asset({ ...state, issuedAtoms: 100000000000n, inventoryAtoms: 100000000000n }),
        200000000000n,
      ),
    ).toThrow(/split/i);
    expect(() => quoteCrcBuy(asset(), 1n)).toThrow(/increments/i);
  });
});

it("maps core amount refusal to a client quote error", () => {
  expect(() =>
    quoteCrcBuy(
      asset({ ...state, issuedAtoms: 100000000000n, inventoryAtoms: 100000000000n }),
      200000000000n,
    ),
  ).toThrow(CrcQuoteError);
});
