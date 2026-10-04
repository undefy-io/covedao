import { expect, test, vi } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as core from "@crclaunch/crc20-protocol";
import { createPlanPsbt } from "@crclaunch/crc20-adapters";
import { ECPairFactory } from "ecpair";
import * as ecc from "tiny-secp256k1";
import { readFileSync } from "node:fs";
import { reviewCrcAmountListing, prepareCrcAmountListing } from "./crc-market-listing";
const key = ECPairFactory(ecc).fromPrivateKey(Buffer.alloc(32, 2));
const pay = bitcoin.payments.p2wpkh({ pubkey: key.publicKey, network: bitcoin.networks.regtest });
const script = pay.output!.toString("hex"),
  deployTxid = "aa".repeat(32),
  assetId = `regtest:${deployTxid}`;
const input = {
  txid: "bb".repeat(32),
  vout: 0,
  atoms: 400n * core.atomsPerToken,
  sats: 1000n,
  scriptHex: script,
  deployTxid,
};
const funding = { txid: "cc".repeat(32), vout: 0, sats: 10000n, scriptHex: script };
const config = core.decodeProtocolDto<{ state: core.Asset }>(
  JSON.parse(
    readFileSync(
      new URL(
        "../../../../artifacts/crc-core-integration/wallet-capabilities/xverse-core-mint-request.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
).state.config;
config.network = "regtest";
const state = {
  config,
  deployTxid,
  issuedAtoms: input.atoms,
  inventoryAtoms: 0n,
  burnedAtoms: 0n,
  vault: {
    txid: "dd".repeat(32),
    vout: 0,
    sats: 1000n + core.backingSats(input.atoms),
    scriptHex: config.vaultScriptHex,
  },
};
function fixture() {
  let confirmed = false,
    height = 100,
    truncated = false,
    spent = false,
    tamper = false,
    proofHook = () => {};
  const prepared = {
    txid: "ee".repeat(32),
    vout: 1,
    atoms: 300n * core.atomsPerToken,
    sats: 1000n,
    scriptHex: script,
    deployTxid,
  };
  const signer = vi.fn(async (base64: string, operation: string) => {
    const psbt = bitcoin.Psbt.fromBase64(base64);
    if (operation === "P2P_LIST") psbt.signInput(0, key, [131]);
    else psbt.signAllInputs(key);
    return psbt.toBase64();
  });
  const proof = vi.fn(async () => {
    proofHook();
    throw new Error("Escrow must never ask for a message signature");
  });
  const wallet = {
    network: "regtest",
    address: pay.address!,
    ordinalsAddress: pay.address!,
    publicKey: key.publicKey.toString("hex"),
    ordinalsPublicKey: key.publicKey.toString("hex"),
    script,
    ordinalsScript: script,
    signPsbt: signer,
    signBip322: proof,
  };
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    let data: unknown;
    if (url.includes("/wallet/utxos"))
      data = {
        utxos: [
          ...(!spent
            ? [
                { txid: input.txid, vout: 0, valueSats: "1000", confirmations: 1 },
                {
                  txid: prepared.txid,
                  vout: 1,
                  valueSats: "1000",
                  confirmations: confirmed ? 1 : 0,
                },
              ]
            : []),
          { txid: funding.txid, vout: 0, valueSats: "10000", confirmations: 1 },
        ],
      };
    else if (url.includes("/utxos?"))
      data = {
        utxos: (confirmed ? [prepared] : [input]).map((c) => ({
          txid: c.txid,
          vout: c.vout,
          atoms: c.atoms.toString(),
          btcSats: c.sats.toString(),
          scriptHex: c.scriptHex,
        })),
        truncated: false,
      };
    else if (url.includes("/tokens/"))
      data = {
        token: {
          assetId,
          network: "regtest",
          deployTxid,
          ticker: config.ticker,
          coreState: core.encodeProtocolDto(state),
        },
        indexedTip: { height: String(height), blockHash: "ff".repeat(32) },
      };
    else if (url.includes("/listings?"))
      data = { active: true, listings: [], unavailableOutpoints: [], truncated };
    else if (url.endsWith("/fees")) data = { tiers: [{ key: "standard", satPerVb: "2" }] };
    else if (url.endsWith("/funding-check"))
      data = { tokenFreeOutpoints: [{ txid: funding.txid, vout: 0 }] };
    else if (url.endsWith("/listing-build")) {
      expect(body.feeRateSatPerVb).toBe(2);
      expect(body.minerFeeSats).toBeUndefined();
      expect(body.recipientScriptHex).toBe(script);
      expect(body.tokenFunding).toEqual([{ txid: input.txid, vout: 0 }]);
      const terms = core.decodeProtocolDto<core.EscrowTerms>(body.escrowTerms);
      const plan = core.buildEscrowListing({
        config,
        terms,
        inputs: [input],
        funding: [funding],
        changeScriptHex: script,
        minerFeeSats: 1000n,
      });
      if (tamper)
        plan.outputs.find((o) => o.role === "btcChange")!.scriptHex = config.protocolScriptHex;
      data = {
        sessionId: "test-session",
        psbtBase64: createPlanPsbt(plan, "regtest").toBase64(),
        intent: {
          operation: "listing",
          assetId,
          amountAtoms: body.amountAtoms,
          priceSats: "5000",
          escrowTerms: body.escrowTerms,
          minerFeeSats: 1000,
          feeRateSatPerVb: 2,
          corePlan: core.encodeProtocolDto(plan),
          coreConfig: core.encodeProtocolDto(config),
        },
      };
    } else if (url.endsWith("/listing-submit")) data = { txid: prepared.txid };
    else if (url.endsWith("/listings")) {
      const offer = core.decodeProtocolDto<core.Offer>(body.offer);
      core.verifyOffer(offer);
      data = { listingId: core.offerId(offer) };
    } else throw new Error(`Unexpected ${url}`);
    return new Response(JSON.stringify({ ok: true, data }));
  });
  return {
    wallet,
    request,
    signer,
    proof,
    confirm: () => {
      confirmed = true;
      height = 102;
    },
    truncate: () => {
      truncated = true;
    },
    spend: () => {
      spent = true;
    },
    tamper: () => {
      tamper = true;
    },
    onProof: (fn: () => void) => {
      proofHook = fn;
    },
  };
}
const args = {
  assetId,
  amountAtoms: 300n * core.atomsPerToken,
  priceSats: 5000n,
  expiryBlocks: 12,
};
test.each([250n, 300n, 400n])(
  "listing%s from400 needs exactly one wallet approval and no separate publication",
  async (amount) => {
    const f = fixture();
    const review = await reviewCrcAmountListing(
      { ...args, amountAtoms: amount * core.atomsPerToken },
      f.wallet,
      f.request,
    );
    expect(review.built).toBeDefined();
    expect("offer" in review).toBe(false);
    expect(review.changeAtoms).toBe(input.atoms - amount * core.atomsPerToken);
    expect(f.signer).not.toHaveBeenCalled();
    const prepared = await prepareCrcAmountListing(review, f.wallet, f.request);
    expect(prepared.coin.atoms).toBe(review.amountAtoms.toString());
    expect(prepared.coin.vout).toBe(1);
    expect(f.signer).toHaveBeenCalledOnce();
    expect(f.proof).not.toHaveBeenCalled();
    expect(f.request.mock.calls.filter(([url]) => url.endsWith("/listing-submit"))).toHaveLength(1);
    expect(f.request.mock.calls.some(([url]) => url.endsWith("/listings"))).toBe(false);
  },
);
test("incomplete availability, spent input and altered output stop before wallet signing", async () => {
  const incomplete = fixture();
  incomplete.truncate();
  await expect(reviewCrcAmountListing(args, incomplete.wallet, incomplete.request)).rejects.toThrow(
    /incomplete/,
  );
  const spent = fixture();
  spent.spend();
  await expect(reviewCrcAmountListing(args, spent.wallet, spent.request)).rejects.toThrow(
    /confirmed/,
  );
  const changed = fixture();
  changed.tamper();
  const review = await reviewCrcAmountListing(args, changed.wallet, changed.request);
  await expect(prepareCrcAmountListing(review, changed.wallet, changed.request)).rejects.toThrow(
    /reconstructed/,
  );
  expect(changed.signer).not.toHaveBeenCalled();
});
test("identity change after listing signature prevents server submission", async () => {
  const f = fixture();
  let current = true;
  const guard = () => {
    if (!current) throw new Error("Wallet changed");
  };
  const review = await reviewCrcAmountListing(args, f.wallet, f.request, guard);
  const original = f.wallet.signPsbt;
  f.wallet.signPsbt = vi.fn(async (psbt, operation) => {
    const signed = await original(psbt, operation);
    current = false;
    return signed;
  });
  await expect(prepareCrcAmountListing(review, f.wallet, f.request, guard)).rejects.toThrow(
    "Wallet changed",
  );
  expect(
    f.request.mock.calls.some(
      ([url]) => url.endsWith("/listing-submit") || url.endsWith("/listings"),
    ),
  ).toBe(false);
});
test("fee estimation failures block exact and custom escrow listing before signing", async () => {
  const f = fixture();
  const request = async (url: string, init?: RequestInit) =>
    url.endsWith("/fees")
      ? new Response(
          JSON.stringify({ ok: false, error: { message: "Fee estimate unavailable" } }),
          { status: 503 },
        )
      : f.request(url, init);
  for (const amountAtoms of [args.amountAtoms, input.atoms])
    await expect(
      reviewCrcAmountListing({ ...args, amountAtoms }, f.wallet, request),
    ).rejects.toThrow("Fee estimate unavailable");
  expect(f.signer).not.toHaveBeenCalled();
});
