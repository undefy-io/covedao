import { expect, test, vi } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as core from "@crclaunch/crc20-protocol";
import { createPlanPsbt } from "@crclaunch/crc20-adapters";
import { ECPairFactory } from "ecpair";
import * as ecc from "tiny-secp256k1";
import { authorizeOffer } from "../../../../packages/cove-market/crc20-protocol/test-support/signing.js";
import { buyCrcMarketListing } from "./crc-market-client";
const buyer = ECPairFactory(ecc).fromPrivateKey(Buffer.alloc(32, 1));
const seller = ECPairFactory(ecc).fromPrivateKey(Buffer.alloc(32, 2));
const payment = bitcoin.payments.p2wpkh({
  pubkey: buyer.publicKey,
  network: bitcoin.networks.regtest,
});
const sellerScript = bitcoin.payments.p2wpkh({ pubkey: seller.publicKey }).output!.toString("hex");
const buyerScript = payment.output!.toString("hex");
const config = {
  network: "regtest",
  ticker: "TEST",
  vaultScriptHex: `0014${"11".repeat(20)}`,
  creatorScriptHex: sellerScript,
  protocolScriptHex: `0014${"22".repeat(20)}`,
};
const deployTxid = "aa".repeat(32);
const listedInput = {
  txid: "bb".repeat(32),
  vout: 0,
  sats: 1000n,
  atoms: core.capAtoms - 1n,
  scriptHex: sellerScript,
  deployTxid,
};
const funding = { txid: "cc".repeat(32), vout: 0, sats: 20000n, scriptHex: buyerScript };
const state: core.Asset = {
  config,
  deployTxid,
  issuedAtoms: core.capAtoms,
  inventoryAtoms: 0n,
  burnedAtoms: 0n,
  vault: {
    txid: "dd".repeat(32),
    vout: 0,
    sats: core.carrierSats + core.backingSats(core.capAtoms),
    scriptHex: config.vaultScriptHex,
  },
};
async function fixture(tamper = false) {
  const offer = await authorizeOffer(
    {
      network: "regtest",
      deployTxid,
      ticker: "TEST",
      listedInput,
      sellerScriptHex: sellerScript,
      priceSats: 5000n,
      expiryHeight: 200,
    },
    seller.privateKey!,
  );
  const row = {
    id: core.offerId(offer),
    network: "regtest",
    deployTxid,
    ticker: "TEST",
    sellerScriptHex: sellerScript,
    sellerPayoutScriptHex: sellerScript,
    sellerAnchorTxid: listedInput.txid,
    sellerAnchorVout: 0,
    sellerAnchorSats: 1000,
    amountAtoms: listedInput.atoms.toString(),
    priceSats: 5000,
    protocolFeeSats: Number(core.marketFee(5000n)),
    expiresAtHeight: "200",
    status: "OPEN",
    coreOffer: core.encodeProtocolDto(offer),
  };
  const signer = vi.fn(async (base64: string) => {
    const psbt = bitcoin.Psbt.fromBase64(base64);
    psbt.signInput(1, buyer);
    return psbt.toBase64();
  });
  const wallet = {
    network: "regtest",
    script: buyerScript,
    publicKey: buyer.publicKey.toString("hex"),
    ordinalsScript: buyerScript,
    address: payment.address!,
    ordinalsAddress: payment.address!,
    signPsbt: signer,
  };
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    let data: unknown;
    if (url.includes("/wallet/utxos"))
      data = { utxos: [{ txid: funding.txid, vout: 0, valueSats: "20000", confirmations: 1 }] };
    else if (url.endsWith("/funding-check"))
      data = { tokenFreeOutpoints: [{ txid: funding.txid, vout: 0 }] };
    else if (url.endsWith("/reserve")) {
      expect(body.offerId).toBe(core.offerId(offer));
      expect(body.paymentFunding).toEqual([{ txid: funding.txid, vout: 0 }]);
      expect(body.sellerFunding).toBeUndefined();
      const plan = core.buildPurchase({
        offer,
        currentHeight: 100,
        buyerFunding: [funding],
        buyerScriptHex: buyerScript,
        protocolScriptHex: config.protocolScriptHex,
        minerFeeSats: 400n,
      });
      const changed = tamper
        ? {
            ...plan,
            outputs: plan.outputs.map((o, i) => (i === 0 ? { ...o, sats: o.sats + 1n } : o)),
          }
        : plan;
      data = {
        sessionId: "owned-session",
        fillId: "owned-session",
        psbtBase64: createPlanPsbt(changed, "regtest").toBase64(),
        intent: {
          operation: "purchase",
          offerId: row.id,
          assetId: `regtest:${deployTxid}`,
          amountAtoms: listedInput.atoms.toString(),
          minerFeeSats: 400,
          corePlan: core.encodeProtocolDto(changed),
          coreConfig: core.encodeProtocolDto(config),
        },
      };
    } else if (url.endsWith("/buyer-sign")) {
      expect(body.sessionId).toBe("owned-session");
      const psbt = bitcoin.Psbt.fromBase64(body.signedPsbtBase64);
      expect(
        core
          .decodeWitness(psbt.data.inputs[0]!.finalScriptWitness!.toString("hex"))
          .map((w) => Buffer.from(w).toString("hex")),
      ).toEqual(offer.sellerWitnessHex);
      data = { fillId: "owned-session", txid: "ee".repeat(32) };
    } else if (url.includes("/utxos?"))
      data = {
        utxos: [
          { ...listedInput, sats: undefined, atoms: listedInput.atoms.toString(), btcSats: "1000" },
        ],
        truncated: false,
      };
    else if (url.includes("/tokens/"))
      data = {
        token: { coreState: core.encodeProtocolDto(state) },
        indexedTip: { height: "100", blockHash: "ff".repeat(32) },
      };
    else throw new Error(`Unexpected URL ${url}`);
    return new Response(JSON.stringify({ ok: true, data }));
  });
  return { row, wallet, signer, request };
}
test("buys using signed core terms, exact atoms and one buyer prompt with no fresh seller signature", async () => {
  const f = await fixture();
  await expect(buyCrcMarketListing(f.row, f.wallet, 400, f.request)).resolves.toEqual({
    fillId: "owned-session",
    txid: "ee".repeat(32),
  });
  expect(f.signer).toHaveBeenCalledOnce();
  expect(f.request.mock.calls.some(([url]) => /seller-sign|broadcast/.test(url))).toBe(false);
});
test("rejects forged offer, misleading fee display, changed payout and wrong network before prompting", async () => {
  const f = await fixture();
  await expect(
    buyCrcMarketListing({ ...f.row, protocolFeeSats: 999 }, f.wallet, 400, f.request),
  ).rejects.toThrow();
  await expect(
    buyCrcMarketListing(
      { ...f.row, coreOffer: { ...f.row.coreOffer, priceSats: "5001" } },
      f.wallet,
      400,
      f.request,
    ),
  ).rejects.toThrow();
  await expect(
    buyCrcMarketListing(f.row, { ...f.wallet, network: "signet" }, 400, f.request),
  ).rejects.toThrow();
  expect(f.signer).not.toHaveBeenCalled();
  const bad = await fixture(true);
  await expect(buyCrcMarketListing(bad.row, bad.wallet, 400, bad.request)).rejects.toThrow();
  expect(bad.signer).not.toHaveBeenCalled();
  expect(bad.request.mock.calls.some(([url]) => url.endsWith("/buyer-sign"))).toBe(false);
});

test("cancellation spends the listed carrier with wallet ALL signatures through the core session", async () => {
  const { cancelCrcMarketListing } = await import("./crc-market-client");
  const f = await fixture();
  const offer = core.decodeProtocolDto<core.Offer>(f.row.coreOffer);
  const address = bitcoin.address.fromOutputScript(
    Buffer.from(sellerScript, "hex"),
    bitcoin.networks.regtest,
  );
  const signer = vi.fn(async (base64: string) => {
    const p = bitcoin.Psbt.fromBase64(base64);
    p.signAllInputs(seller);
    return p.toBase64();
  });
  const wallet = {
    ...f.wallet,
    script: sellerScript,
    ordinalsScript: sellerScript,
    address,
    ordinalsAddress: address,
    publicKey: seller.publicKey.toString("hex"),
    signPsbt: signer,
  };
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.endsWith("/cancel-build")) {
      expect(body.offerId).toBe(f.row.id);
      expect(body.sellerAuthorizationB64).toBeUndefined();
      const plan = core.buildCancel({
        offer,
        funding: [{ ...funding, scriptHex: sellerScript }],
        changeScriptHex: sellerScript,
        minerFeeSats: 1000n,
      });
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            sessionId: "cancel-session",
            psbtBase64: createPlanPsbt(plan, "regtest").toBase64(),
            intent: {
              operation: "cancel",
              offerId: f.row.id,
              assetId: `regtest:${deployTxid}`,
              amountAtoms: listedInput.atoms.toString(),
              minerFeeSats: 1000,
              coreConfig: core.encodeProtocolDto(config),
              corePlan: core.encodeProtocolDto(plan),
            },
          },
        }),
      );
    }
    if (url.endsWith("/cancel")) {
      expect(body.sessionId).toBe("cancel-session");
      const p = bitcoin.Psbt.fromBase64(body.signedPsbtBase64);
      expect(
        core.decodeWitness(p.data.inputs[0]!.finalScriptWitness!.toString("hex"))[0]!.at(-1),
      ).toBe(1);
      return new Response(JSON.stringify({ ok: true, data: { txid: "aa".repeat(32) } }));
    }
    return f.request(url, init);
  });
  await expect(cancelCrcMarketListing(f.row, wallet, 1000, request)).resolves.toHaveProperty(
    "txid",
  );
  expect(signer).toHaveBeenCalledOnce();
});

test("ownership uses escrow token and payment identities, legacy token owner, and the wallet network", async () => {
  const { isCrcMarketListingOwner } = await import("./crc-market-client");
  const f = await fixture();
  const terms: core.EscrowTerms = {
    version: 1,
    network: "regtest",
    deployTxid,
    ticker: "TEST",
    amountAtoms: 29000000000n,
    priceSats: 10n,
    sellerTokenScriptHex: buyerScript,
    sellerPayoutScriptHex: sellerScript,
    sellerAuthorityScriptHex: sellerScript,
    protocolScriptHex: config.protocolScriptHex,
    feePolicy: "market-v1",
    expiryHeight: 200,
    guardianPublicKeyHex: seller.publicKey.subarray(1).toString("hex"),
    nonceHex: "01".repeat(32),
  };
  const offer = core.escrowOffer(terms, {
    txid: listedInput.txid,
    vout: 1,
    sats: 1000n,
    scriptHex: core.escrowCustody(terms).scriptHex,
  });
  const row = { ...f.row, coreOffer: core.encodeProtocolDto(offer), sellerScriptHex: sellerScript };
  const owner = { network: "regtest", script: sellerScript, ordinalsScript: buyerScript };
  expect(isCrcMarketListingOwner(row, owner)).toBe(true);
  expect(isCrcMarketListingOwner(row, f.wallet)).toBe(false);
  expect(isCrcMarketListingOwner(row, { ...owner, network: "signet" })).toBe(false);
  expect(isCrcMarketListingOwner(row, { ...owner, ordinalsScript: sellerScript })).toBe(false);
  expect(isCrcMarketListingOwner(f.row, { ...f.wallet, ordinalsScript: sellerScript })).toBe(true);
  expect(isCrcMarketListingOwner(f.row, f.wallet)).toBe(false);
});

test("own listing cannot trigger funding requests or a wallet purchase prompt", async () => {
  const f = await fixture();
  const sellerAddress = bitcoin.address.fromOutputScript(
    Buffer.from(sellerScript, "hex"),
    bitcoin.networks.regtest,
  );
  const owner = {
    ...f.wallet,
    script: sellerScript,
    ordinalsScript: sellerScript,
    address: sellerAddress,
    ordinalsAddress: sellerAddress,
    publicKey: seller.publicKey.toString("hex"),
  };
  await expect(buyCrcMarketListing(f.row, owner, 400, f.request)).rejects.toThrow(
    "This is your listing",
  );
  expect(f.request).not.toHaveBeenCalled();
  expect(f.signer).not.toHaveBeenCalled();
});
