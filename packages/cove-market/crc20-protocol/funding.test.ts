import { authorizeOffer } from "./test-support/signing.js";
import { expect, test } from "vitest";
import * as p from "./index.ts";
import type { Input } from "./types.js";
import { aliceKey, aliceScript, bobScript, protocolScript } from "./test-support/core.ts";

const config = {
  network: "regtest",
  ticker: "TEST",
  vaultScriptHex: aliceScript,
  creatorScriptHex: aliceScript,
  protocolScriptHex: protocolScript,
};
const deployTxid = "a".repeat(64);
const token = {
  txid: "b".repeat(64),
  vout: 1,
  sats: 1000n,
  scriptHex: aliceScript,
  atoms: 100000000000n,
  deployTxid,
};
const ordinary = { txid: "c".repeat(64), vout: 0, sats: 100000n, scriptHex: aliceScript };
const state = {
  config,
  deployTxid,
  issuedAtoms: 200000000000n,
  inventoryAtoms: 0n,
  burnedAtoms: 0n,
  vault: { txid: "d".repeat(64), vout: 2, sats: 1054n, scriptHex: aliceScript },
};

test.each(["deploy", "mint", "inventoryBuy", "sell", "transfer", "listing", "purchase", "cancel"])(
  "%s rejects annotated token funding while preserving ordinary funding",
  async (kind) => {
    const offer = await authorizeOffer(
      {
        network: "regtest",
        deployTxid,
        ticker: "TEST",
        listedInput: token,
        sellerScriptHex: aliceScript,
        priceSats: 12347n,
        expiryHeight: 100,
      },
      aliceKey.privateKey!,
    );
    const build = (funding: Input[]) => {
      const transfer = {
        network: "regtest",
        deployTxid,
        ticker: "TEST",
        input: token,
        amountAtoms: 50000000000n,
        funding,
        recipientScriptHex: bobScript,
        sellerScriptHex: aliceScript,
        changeScriptHex: aliceScript,
        priceSats: 12347n,
      };
      const trade = {
        state,
        funding,
        amountAtoms: 50000000000n,
        recipientScriptHex: aliceScript,
        inputs: [token],
      };
      const builders = {
        deploy: () => p.buildDeploy({ config, funding, changeScriptHex: aliceScript }),
        mint: () => p.buildMint(trade),
        inventoryBuy: () =>
          p.buildInventoryBuy({
            ...trade,
            state: {
              ...state,
              inventoryAtoms: 100000000000n,
              vault: { ...state.vault, sats: 1027n },
            },
          }),
        sell: () => p.buildSell(trade),
        transfer: () => p.buildTransfer(transfer),
        listing: () => p.buildListing(transfer),
        purchase: () =>
          p.buildPurchase({
            offer,
            currentHeight: 1,
            buyerFunding: funding,
            buyerScriptHex: bobScript,
            protocolScriptHex: protocolScript,
          }),
        cancel: () => p.buildCancel({ offer, funding }),
      };
      return builders[kind as keyof typeof builders]();
    };
    expect(() => build([ordinary])).not.toThrow();
    for (const metadata of [
      { atoms: 1n },
      { atoms: 0n },
      { deployTxid },
      { atoms: token.atoms, deployTxid },
    ]) {
      const funding = [{ ...ordinary, txid: "e".repeat(64), sats: 1000n, ...metadata }, ordinary];
      const saved = structuredClone(funding);
      expect(() => build(funding)).toThrow(/token.*funding/i);
      expect(funding).toEqual(saved);
    }
  },
);
