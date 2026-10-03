import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import * as core from "@crclaunch/crc20-protocol";
import * as adapter from "./index.js";
bitcoin.initEccLib(ecc);
const atoms = (tokens: number) => BigInt(tokens) * core.atomsPerToken;
for (const [issued, inventory, requested, reused, minted, operation, markerOperation] of [
  [400, 400, 100, 100, 0, "inventory-buy", "transfer"],
  [400, 400, 400, 400, 0, "inventory-buy", "transfer"],
  [400, 400, 500, 400, 100, "mint-buy", "mint"],
  [400, 400, 1000, 400, 600, "mint-buy", "mint"],
  [400, 0, 100, 0, 100, "mint-buy", "mint"],
  [0, 0, 400, 0, 400, "mint-buy", "mint"],
] as const)
  test(`consumer buy contract: ${requested} with ${inventory} inventory`, () => {
    expect(
      adapter.describeCurveBuy(
        { issuedAtoms: atoms(issued), inventoryAtoms: atoms(inventory) },
        atoms(requested),
      ),
    ).toEqual({
      amountAtoms: atoms(requested),
      inventoryBuyAtoms: atoms(reused),
      newlyMintedAtoms: atoms(minted),
      operation,
      markerOperation,
    });
  });
function fixture(kind: "native" | "nested" | "taproot") {
  const saved = JSON.parse(
    readFileSync(
      new URL(
        "../../../artifacts/crc-core-integration/wallet-capabilities/xverse-core-mint-request.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const { state } = core.decodeProtocolDto<{ state: core.Asset }>(saved);
  state.issuedAtoms = state.inventoryAtoms = atoms(400);
  state.vault.sats = 1000n;
  const privateKey = Buffer.alloc(32, 2),
    publicKey = Buffer.from(ecc.pointFromScalar(privateKey)!);
  const native = bitcoin.payments.p2wpkh({ pubkey: publicKey, network: bitcoin.networks.testnet });
  const payment =
    kind === "nested"
      ? bitcoin.payments.p2sh({ redeem: native, network: bitcoin.networks.testnet })
      : kind === "taproot"
        ? bitcoin.payments.p2tr({
            internalPubkey: publicKey.subarray(1),
            network: bitcoin.networks.testnet,
          })
        : native;
  const input = {
    txid: "cc".repeat(32),
    vout: 0,
    sats: 100000n,
    scriptHex: payment.output!.toString("hex"),
    ...(kind === "nested" ? { redeemScriptHex: native.output!.toString("hex") } : {}),
  };
  const plan = core.buildBuy({
    state,
    funding: [input],
    amountAtoms: atoms(1000),
    recipientScriptHex: input.scriptHex,
  });
  const ledger = core.emptyLedger(state.config);
  ledger.assets[state.deployTxid] = state;
  const account = { address: payment.address!, publicKey: publicKey.toString("hex") };
  const prepared = adapter.prepareGuardianPlanSigning(plan, ledger, {
    network: "signet",
    walletInputs: [{ ...account, index: 1 }],
  });
  const psbt = bitcoin.Psbt.fromBase64(prepared.params.psbt);
  const even = publicKey[0] === 3 ? ecc.privateNegate(privateKey) : privateKey;
  const tweaked = ecc.privateAdd(even, core.taggedHash("TapTweak", publicKey.subarray(1)))!;
  psbt.signInput(
    1,
    kind === "taproot"
      ? {
          publicKey: Buffer.from(ecc.pointFromScalar(tweaked)!),
          sign: (hash) => Buffer.from(ecc.sign(hash, tweaked)),
          signSchnorr: (hash) => Buffer.from(ecc.signSchnorr(hash, tweaked)),
        }
      : { publicKey, sign: (hash) => Buffer.from(ecc.sign(hash, privateKey)) },
    [1],
  );
  return { plan, ledger, prepared, response: psbt.toBase64(), account };
}
test.each(["native", "nested", "taproot"] as const)(
  "mixed buy %s wallet preserves full receipt through browser/server preflight",
  (kind) => {
    const f = fixture(kind);
    const browser = adapter.completeBrowserWalletSigning(f.prepared, f.response, f.ledger);
    const completed = adapter.completeServerWalletSigning(
      f.plan,
      "signet",
      f.prepared.params.psbt,
      browser.psbtBase64,
      f.ledger,
      true,
    );
    expect(completed.transition).toMatchObject({
      kind: "mint",
      amountAtoms: atoms(1000),
      inventoryBuyAtoms: atoms(400),
      newlyMintedAtoms: atoms(600),
    });
    expect(
      bitcoin.Psbt.fromBase64(completed.psbtBase64).data.inputs[0]!.finalScriptWitness,
    ).toBeUndefined();
    expect(
      bitcoin.Psbt.fromBase64(completed.psbtBase64).data.inputs[1]!.finalScriptWitness,
    ).toBeDefined();
  },
);
test("pending Guardian signatures do not allow forged quoted receipt or issuance breakdown", () => {
  const f = fixture("native");
  for (const plan of [
    { ...f.plan, inventoryBuyAtoms: atoms(300) },
    { ...f.plan, newlyMintedAtoms: atoms(700) },
    {
      ...f.plan,
      outputs: f.plan.outputs.map((o, i) => (i === 1 ? { ...o, atoms: atoms(600) } : o)),
    },
  ]) {
    const prepared = { ...f.prepared, plan };
    expect(() => adapter.completeBrowserWalletSigning(prepared, f.response, f.ledger)).toThrow(
      /receipt|breakdown|amount/i,
    );
    expect(() => adapter.completeGuardianWalletSigning(prepared, f.response, f.ledger)).toThrow(
      /receipt|breakdown|amount/i,
    );
    expect(() =>
      adapter.completeServerWalletSigning(
        plan,
        "signet",
        f.prepared.params.psbt,
        f.response,
        f.ledger,
        true,
      ),
    ).toThrow(/receipt|breakdown|amount/i);
  }
});
