import { rawWithWitnesses } from "./psbt.js";
import { Buffer } from "buffer";
import * as bitcoin from "bitcoinjs-lib";
import * as core from "@crclaunch/crc20-protocol";
import type {
  ChainTransaction,
  Input,
  Ledger,
  Offer,
  OfferTerms,
  Plan,
  ProtocolNetwork,
} from "@crclaunch/crc20-protocol";

export interface WalletAccount {
  address: string;
  publicKey: string;
}
/** Consumer labels follow the core's inventory-first transition, not inventory presence. */
export function describeCurveBuy(
  state: Pick<core.Asset, "issuedAtoms" | "inventoryAtoms">,
  amountAtoms: bigint,
) {
  const amounts = core.curveBuyAmounts(state, amountAtoms);
  return {
    amountAtoms,
    ...amounts,
    operation: amounts.newlyMintedAtoms ? ("mint-buy" as const) : ("inventory-buy" as const),
    markerOperation: amounts.newlyMintedAtoms ? ("mint" as const) : ("transfer" as const),
  };
}
function assertBuyReceipt(
  plan: Plan,
  transition: Pick<
    core.ValidatedTransition,
    "kind" | "amountAtoms" | "inventoryBuyAtoms" | "newlyMintedAtoms"
  >,
) {
  if (
    (transition.kind === "mint" || transition.kind === "inventoryBuy") &&
    (plan.outputs[plan.recipientVout]?.atoms !== transition.amountAtoms ||
      plan.inventoryBuyAtoms !== transition.inventoryBuyAtoms ||
      plan.newlyMintedAtoms !== transition.newlyMintedAtoms)
  )
    throw new Error("Quoted buy receipt or inventory breakdown differs from transition");
}
export interface WalletInput extends WalletAccount {
  index: number;
}
export interface SigningOptions {
  network: string;
  walletInputs: WalletInput[];
  /** Already finalized external signer witnesses, e.g. Guardian. */
  finalizedWitnesses?: Record<number, string[]>;
}
export interface WalletParams {
  psbt: string;
  signInputs: Record<string, number[]>;
  broadcast: false;
}
export interface PreparedSigning {
  network: ProtocolNetwork;
  params: WalletParams;
  prevouts: Input[];
  walletInputs: WalletInput[];
  plan?: Plan;
  terms?: OfferTerms;
  guardianPending?: true;
}
const networkFor = (network: ProtocolNetwork) =>
  network === "bitcoin"
    ? bitcoin.networks.bitcoin
    : network === "regtest"
      ? bitcoin.networks.regtest
      : bitcoin.networks.testnet;
const fromHex = (hex: string) => {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) throw new Error("noncanonical hex");
  return Buffer.from(hex, "hex");
};
function accountScript(address: string, network: ProtocolNetwork): string {
  // Decode the address without invoking bitcoinjs' ECC-backed p2tr payment factory.
  // Script ownership and curve validity are proven by the authoritative core.
  if (address.startsWith("bc1p") || address.startsWith("tb1p") || address.startsWith("bcrt1p")) {
    const decoded = bitcoin.address.fromBech32(address);
    if (
      decoded.prefix !== networkFor(network).bech32 ||
      decoded.version !== 1 ||
      decoded.data.length !== 32
    )
      throw new Error("wallet address network or encoding mismatch");
    return `5120${decoded.data.toString("hex")}`;
  }
  return bitcoin.address.toOutputScript(address, networkFor(network)).toString("hex");
}
/** Server transport construction; authorization is verified separately against the current core ledger. */
export function createPlanPsbt(
  plan: Plan,
  networkName: string,
  options: { publicKeys?: Record<number, string> } = {},
): bitcoin.Psbt {
  const psbt = new bitcoin.Psbt({ network: networkFor(core.protocolNetwork(networkName)) });
  psbt.setVersion(2);
  psbt.setLocktime(0);
  plan.inputs.forEach((input, index) => {
    const publicKey = options.publicKeys?.[index];
    const witness = plan.inputWitnesses?.[index];
    const kind = core.walletScriptKind(input.scriptHex, input.redeemScriptHex);
    if (publicKey)
      core.canonicalOfferPublicKey(
        publicKey,
        kind === "p2sh-p2wpkh" ? input.redeemScriptHex! : input.scriptHex,
      );
    psbt.addInput({
      hash: input.txid,
      index: input.vout,
      sequence: 0xfffffffe,
      witnessUtxo: { script: fromHex(input.scriptHex), value: Number(core.sats(input.sats)) },
      ...(witness?.length
        ? { finalScriptWitness: fromHex(core.encodeWitness(witness.map(fromHex))) }
        : { sighashType: 1 }),
      ...(input.redeemScriptHex
        ? {
            redeemScript: fromHex(input.redeemScriptHex),
            ...(witness?.length
              ? { finalScriptSig: bitcoin.script.compile([fromHex(input.redeemScriptHex)]) }
              : {}),
          }
        : {}),
      ...(kind === "p2tr" && publicKey
        ? { tapInternalKey: fromHex(publicKey.length === 64 ? publicKey : publicKey.slice(2)) }
        : {}),
    });
  });
  plan.outputs.forEach((output) =>
    psbt.addOutput({ script: fromHex(output.scriptHex), value: Number(core.sats(output.sats)) }),
  );
  return psbt;
}
function walletMetadata(input: Input, account: WalletAccount, network: ProtocolNetwork) {
  if (accountScript(account.address, network) !== input.scriptHex)
    throw new Error("wallet address/input script mismatch");
  const kind = core.walletScriptKind(input.scriptHex, input.redeemScriptHex);
  core.canonicalOfferPublicKey(
    account.publicKey,
    kind === "p2sh-p2wpkh" ? input.redeemScriptHex! : input.scriptHex,
  );
  return kind === "p2sh-p2wpkh"
    ? { redeemScript: fromHex(input.redeemScriptHex!) }
    : kind === "p2tr"
      ? {
          tapInternalKey: fromHex(
            account.publicKey.length === 64 ? account.publicKey : account.publicKey.slice(2),
          ),
        }
      : {};
}
function preparedPsbt(
  inputs: Input[],
  outputs: { sats: bigint; scriptHex: string }[],
  options: SigningOptions,
  sighash: number,
  witnesses: Record<number, string[]> = {},
  guardianPending = false,
): PreparedSigning {
  const network = core.protocolNetwork(options.network);
  const psbt = new bitcoin.Psbt({ network: networkFor(network) });
  psbt.setVersion(2);
  psbt.setLocktime(0);
  const signInputs: Record<string, number[]> = {};
  const indexed = new Map<number, WalletInput>();
  for (const account of options.walletInputs) {
    if (
      !Number.isSafeInteger(account.index) ||
      account.index < 0 ||
      account.index >= inputs.length ||
      indexed.has(account.index)
    )
      throw new Error("invalid or duplicate wallet input index");
    if (witnesses[account.index]) throw new Error("cannot sign finalized external input");
    if (guardianPending && account.index === 0)
      throw new Error("custody input is not a wallet input");
    indexed.set(account.index, account);
    (signInputs[account.address] ??= []).push(account.index);
  }
  if (indexed.size === 0) throw new Error("wallet input required");
  for (const key of Object.keys(witnesses))
    if (!Number.isSafeInteger(Number(key)) || Number(key) < 0 || Number(key) >= inputs.length)
      throw new Error("invalid finalized input index");
  inputs.forEach((input, index) => {
    if (
      !/^[0-9a-f]{64}$/.test(input.txid) ||
      !Number.isSafeInteger(input.vout) ||
      input.vout < 0 ||
      input.vout > 0xffffffff
    )
      throw new Error("invalid prevout");
    const account = indexed.get(index);
    const witness = witnesses[index];
    const unsignedGuardian = guardianPending && index === 0;
    if (!account && !witness && !unsignedGuardian) throw new Error("unassigned signing input");
    psbt.addInput({
      hash: input.txid,
      index: input.vout,
      sequence: 0xfffffffe,
      witnessUtxo: { script: fromHex(input.scriptHex), value: Number(core.sats(input.sats)) },
      ...(account
        ? { sighashType: sighash, ...walletMetadata(input, account, network) }
        : unsignedGuardian
          ? {}
          : {
              finalScriptWitness: fromHex(core.encodeWitness(witness!.map(fromHex))),
              ...(input.redeemScriptHex
                ? { finalScriptSig: bitcoin.script.compile([fromHex(input.redeemScriptHex)]) }
                : {}),
            }),
    });
  });
  outputs.forEach((output) =>
    psbt.addOutput({ script: fromHex(output.scriptHex), value: Number(core.sats(output.sats)) }),
  );
  const raw = core.parseRawTransaction(rawWithWitnesses(psbt).toHex());
  for (const key of Object.keys(witnesses))
    core.verifyInputSignature(
      raw,
      inputs,
      Number(key),
      sighash === 1 && witnesses[0] ? core.outpoint(inputs[0]!) : undefined,
    );
  return {
    network,
    params: { psbt: psbt.toBase64(), signInputs, broadcast: false },
    prevouts: structuredClone(inputs),
    walletInputs: structuredClone(options.walletInputs),
  };
}
export function preparePlanSigning(plan: Plan, options: SigningOptions): PreparedSigning {
  const witnesses: Record<number, string[]> = { ...options.finalizedWitnesses };
  plan.inputWitnesses?.forEach((witness, index) => {
    if (witness.length) {
      if (witnesses[index] && JSON.stringify(witnesses[index]) !== JSON.stringify(witness))
        throw new Error("conflicting finalized witness");
      witnesses[index] = witness;
    }
  });
  return {
    ...preparedPsbt(plan.inputs, plan.outputs, options, 1, witnesses),
    plan: structuredClone(plan),
  };
}
/** Wallet signs first; authoritative Guardian preflight runs once those signatures exist. */
export function prepareGuardianPlanSigning(
  plan: Plan,
  ledger: Ledger,
  options: SigningOptions,
): PreparedSigning {
  const first = plan.inputs[0];
  const escrowOffer = Object.values(ledger.offers).find(
    (o) => o.escrowTerms && first && core.outpoint(o.listedInput) === core.outpoint(first),
  );
  if (escrowOffer) {
    core.verifyOffer(escrowOffer);
    const asset = ledger.assets[escrowOffer.deployTxid];
    if (
      !asset ||
      core.protocolNetwork(options.network) !== asset.config.network ||
      first!.scriptHex !== escrowOffer.listedInput.scriptHex ||
      core.sats(first!.sats) !== core.sats(escrowOffer.listedInput.sats)
    )
      throw new Error("escrow custody/network mismatch");
    core.validateEscrowConfig(escrowOffer.escrowTerms!, asset.config);
    if (options.finalizedWitnesses?.[0] || plan.inputWitnesses?.some((w) => w.length))
      throw new Error("escrow must be unsigned");
    return {
      ...preparedPsbt(plan.inputs, plan.outputs, options, 1, options.finalizedWitnesses, true),
      plan: structuredClone(plan),
      guardianPending: true,
    };
  }
  const asset = Object.values(ledger.assets).find(
    (asset) => first && core.outpoint(asset.vault) === core.outpoint(first),
  );
  if (!asset?.config.guardianCustody || asset.vaultAvailable === false)
    throw new Error("current registered Guardian vault required");
  core.validateConfig(asset.config);
  if (
    core.protocolNetwork(options.network) !== asset.config.network ||
    ledger.config.network !== asset.config.network ||
    first!.scriptHex !== asset.vault.scriptHex ||
    first!.sats !== asset.vault.sats
  )
    throw new Error("Guardian vault or network mismatch");
  if (options.finalizedWitnesses?.[0] || plan.inputWitnesses?.some((witness) => witness.length))
    throw new Error("wallet-first Guardian plan must be unsigned");
  return {
    ...preparedPsbt(plan.inputs, plan.outputs, options, 1, options.finalizedWitnesses, true),
    plan: structuredClone(plan),
    guardianPending: true,
  };
}
export function prepareOfferSigning(terms: OfferTerms, account: WalletAccount): PreparedSigning {
  const tx = core.offerSigningTransaction(terms);
  const prepared = preparedPsbt(
    [terms.listedInput],
    tx.outputs,
    { network: terms.network, walletInputs: [{ ...account, index: 0 }] },
    131,
  );
  if (core.canonicalOfferPublicKey(account.publicKey, terms.sellerScriptHex) !== terms.publicKeyHex)
    throw new Error("offer public key mismatch");
  return { ...prepared, terms: structuredClone(terms) };
}
function checkedResponse(prepared: PreparedSigning, response: string): bitcoin.Psbt {
  const original = bitcoin.Psbt.fromBase64(prepared.params.psbt);
  const signed = bitcoin.Psbt.fromBase64(response);
  if (
    !signed.data.globalMap.unsignedTx
      .toBuffer()
      .equals(original.data.globalMap.unsignedTx.toBuffer())
  )
    throw new Error("wallet changed transaction");
  original.data.inputs.forEach((before, index) => {
    const after = signed.data.inputs[index]!;
    if (
      !after.witnessUtxo ||
      !before.witnessUtxo ||
      after.witnessUtxo.value !== before.witnessUtxo.value ||
      !after.witnessUtxo.script.equals(before.witnessUtxo.script)
    )
      throw new Error("wallet changed prevout");
    for (const field of ["finalScriptWitness", "finalScriptSig"] as const)
      if (before[field] && !before[field]!.equals(after[field] ?? Buffer.alloc(0)))
        throw new Error(`wallet changed ${field}`);
    for (const field of ["redeemScript", "tapInternalKey"] as const) {
      if (!before[field] || before[field]!.equals(after[field] ?? Buffer.alloc(0))) continue;
      // BIP174 finalization removes signing metadata. Only an omitted field on
      // a finalized wallet input is allowed; core still verifies its full spend.
      const finalizedWallet =
        prepared.walletInputs.some((input) => input.index === index) && after.finalScriptWitness;
      if (after[field] || !finalizedWallet) throw new Error(`wallet changed ${field}`);
      if (
        field === "redeemScript" &&
        !bitcoin.script
          .compile([before.redeemScript!])
          .equals(after.finalScriptSig ?? Buffer.alloc(0))
      )
        throw new Error("wallet changed nested redeem script spend");
    }
    if (after.sighashType !== undefined && after.sighashType !== before.sighashType)
      throw new Error("wallet changed sighash");
  });
  return signed;
}
function finalizeWalletInputs(psbt: bitcoin.Psbt, prepared: PreparedSigning): void {
  for (const { index } of prepared.walletInputs) {
    const input = psbt.data.inputs[index]!;
    if (!input.finalScriptWitness) {
      // bitcoinjs' default Taproot finalizer requires an injected ECC runtime.
      // Serialization needs none; the authoritative core verifies the signature.
      if (input.tapKeySig)
        psbt.updateInput(index, {
          finalScriptWitness: fromHex(core.encodeWitness([input.tapKeySig])),
        });
      else psbt.finalizeInput(index);
    }
    const witness = core.decodeWitness(
      psbt.data.inputs[index]!.finalScriptWitness!.toString("hex"),
    );
    const expected = prepared.terms ? 131 : 1;
    if (
      witness[0]?.at(-1) !== expected ||
      (/^5120/.test(prepared.prevouts[index]!.scriptHex) && witness[0]?.length !== 65)
    )
      throw new Error("wallet signature must use requested sighash");
  }
}
export function completePlanSigning(
  prepared: PreparedSigning,
  response: string,
  ledger?: Ledger,
): ChainTransaction {
  if (!prepared.plan || prepared.terms || prepared.guardianPending)
    throw new Error("complete plan signing context required");
  const psbt = checkedResponse(prepared, response);
  finalizeWalletInputs(psbt, prepared);
  const transaction = {
    rawHex: rawWithWitnesses(psbt).toHex(),
    prevouts: structuredClone(prepared.prevouts),
  };
  core.validateFinalTransaction(prepared.plan, transaction, ledger);
  return transaction;
}
export function completeGuardianWalletSigning(
  prepared: PreparedSigning,
  response: string,
  ledger: Ledger,
): { psbtBase64: string; transaction: ChainTransaction; transition: core.ValidatedTransition } {
  if (!prepared.guardianPending || !prepared.plan || prepared.terms)
    throw new Error("wallet-first Guardian context required");
  const psbt = checkedResponse(prepared, response);
  finalizeWalletInputs(psbt, prepared);
  const transaction = {
    rawHex: rawWithWitnesses(psbt).toHex(),
    prevouts: structuredClone(prepared.prevouts),
  };
  const transition = (
    hasEscrowInput(ledger, transaction)
      ? core.validateEscrowGuardianTransaction
      : core.validateGuardianTransaction
  )(ledger, transaction);
  assertBuyReceipt(prepared.plan, transition);
  return { psbtBase64: psbt.toBase64(), transaction, transition };
}
/** Server-side verification uses the stored plan; key ownership is proven by core signatures. */
export function completeServerWalletSigning(
  plan: Plan,
  networkName: string,
  originalPsbtBase64: string,
  response: string,
  ledger: Ledger,
  guardianPending = false,
): { psbtBase64: string; transaction: ChainTransaction; transition?: core.ValidatedTransition } {
  const original = bitcoin.Psbt.fromBase64(originalPsbtBase64);
  if (
    !original.data.globalMap.unsignedTx
      .toBuffer()
      .equals(createPlanPsbt(plan, networkName).data.globalMap.unsignedTx.toBuffer())
  )
    throw new Error("stored PSBT differs from core plan");
  original.data.inputs.forEach((input, index) => {
    if (
      !input.witnessUtxo ||
      BigInt(input.witnessUtxo.value) !== core.sats(plan.inputs[index]!.sats) ||
      input.witnessUtxo.script.toString("hex") !== plan.inputs[index]!.scriptHex
    )
      throw new Error("stored prevout differs from core plan");
  });
  const prepared: PreparedSigning = {
    network: core.protocolNetwork(networkName),
    params: { psbt: originalPsbtBase64, signInputs: {}, broadcast: false },
    prevouts: structuredClone(plan.inputs),
    plan: structuredClone(plan),
    // Only input positions are used for finalization; wallet keys come from the verified witness.
    walletInputs: original.data.inputs.flatMap((input, index) =>
      input.finalScriptWitness || (guardianPending && index === 0)
        ? []
        : [{ index, address: "", publicKey: "" }],
    ),
    ...(guardianPending ? { guardianPending: true } : {}),
  };
  if (guardianPending) return completeGuardianWalletSigning(prepared, response, ledger);
  const psbt = checkedResponse(prepared, response);
  finalizeWalletInputs(psbt, prepared);
  const transaction = {
    rawHex: rawWithWitnesses(psbt).toHex(),
    prevouts: structuredClone(plan.inputs),
  };
  core.validateFinalTransaction(plan, transaction, ledger);
  return { psbtBase64: psbt.toBase64(), transaction };
}
/** Browser-only input-scoped preview; authoritative submission still verifies the full ledger. */
export function completeBrowserWalletSigning(
  prepared: PreparedSigning,
  response: string,
  view: core.TransactionView,
): { psbtBase64: string; transaction: ChainTransaction } {
  if (!prepared.plan || prepared.terms) throw new Error("browser plan context required");
  const psbt = checkedResponse(prepared, response);
  finalizeWalletInputs(psbt, prepared);
  const transaction = {
    rawHex: rawWithWitnesses(psbt).toHex(),
    prevouts: structuredClone(prepared.prevouts),
  };
  if (prepared.guardianPending)
    assertBuyReceipt(
      prepared.plan,
      (hasEscrowInput(view, transaction)
        ? core.validateEscrowGuardianTransactionView
        : core.validateGuardianTransactionView)(view, transaction),
    );
  else core.validateFinalTransactionView(prepared.plan, transaction, view);
  return { psbtBase64: psbt.toBase64(), transaction };
}
export function completeOfferSigning(
  prepared: PreparedSigning,
  messageSignatureBase64: string,
  response: string,
): Offer {
  if (!prepared.terms || prepared.plan) throw new Error("offer signing context required");
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(messageSignatureBase64)
  )
    throw new Error("invalid wallet BIP322 base64");
  const signature = Buffer.from(messageSignatureBase64, "base64");
  if (signature.toString("base64") !== messageSignatureBase64)
    throw new Error("noncanonical wallet BIP322 framing");
  const psbt = checkedResponse(prepared, response);
  finalizeWalletInputs(psbt, prepared);
  const witness = core
    .decodeWitness(psbt.data.inputs[0]!.finalScriptWitness!.toString("hex"))
    .map((w) => Buffer.from(w).toString("hex"));
  return core.attachOfferAuthorization(prepared.terms, signature.toString("hex"), witness);
}
export interface WalletProvider {
  request(method: string, params: unknown): Promise<any>;
}
export class WalletSigningError extends Error {
  constructor(
    public readonly code: "REJECTED" | "NETWORK" | "FAILED",
    message: string,
  ) {
    super(message);
    this.name = "WalletSigningError";
  }
}
async function request(provider: WalletProvider, method: string, params: unknown): Promise<any> {
  try {
    const response = await provider.request(method, params);
    if (response?.error) throw response.error;
    if (!response?.result) throw new Error("wallet result missing");
    return response.result;
  } catch (error) {
    if (error instanceof WalletSigningError) throw error;
    const value = error as { code?: number; message?: string };
    const message = value?.message ?? String(error);
    throw new WalletSigningError(
      value?.code === 4001 || /reject|cancel|declin/i.test(message) ? "REJECTED" : "FAILED",
      message,
    );
  }
}
export async function assertWalletNetwork(
  provider: WalletProvider,
  network: ProtocolNetwork,
): Promise<void> {
  const result = await request(provider, "wallet_getNetwork", null);
  const name = result?.bitcoin?.name;
  try {
    if (typeof name !== "string" || core.protocolNetwork(name.toLowerCase()) !== network)
      throw new Error("wallet network mismatch");
  } catch {
    throw new WalletSigningError("NETWORK", "wallet network mismatch");
  }
}
export async function requestWalletSigning(
  provider: WalletProvider,
  prepared: PreparedSigning,
): Promise<string> {
  await assertWalletNetwork(provider, prepared.network);
  const result = await request(provider, "signPsbt", prepared.params);
  if (typeof result.psbt !== "string")
    throw new WalletSigningError("FAILED", "wallet PSBT missing");
  return result.psbt;
}
export async function requestOfferSigning(
  provider: WalletProvider,
  prepared: PreparedSigning,
): Promise<Offer> {
  if (!prepared.terms) throw new Error("offer signing context required");
  await assertWalletNetwork(provider, prepared.network);
  const result = await request(provider, "signMessage", {
    address: prepared.walletInputs[0]!.address,
    message: core.offerMessage(prepared.terms),
    protocol: "BIP322",
  });
  if (typeof result.signature !== "string")
    throw new WalletSigningError("FAILED", "wallet BIP322 signature missing");
  const signed = await requestWalletSigning(provider, prepared);
  return completeOfferSigning(prepared, result.signature, signed);
}

export * from "./guardian.js";

function hasEscrowInput(
  ledger: core.TransactionView | Ledger,
  transaction: ChainTransaction,
): boolean {
  const first = core.parseRawTransaction(transaction.rawHex).inputs[0];
  return (
    !!first &&
    Object.values(ledger.offers).some(
      (o) => o.escrowTerms && core.outpoint(o.listedInput) === core.outpoint(first),
    )
  );
}
