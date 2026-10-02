import * as bitcoin from "bitcoinjs-lib";
import * as core from "@crclaunch/crc20-protocol";
import {
  completeBrowserWalletSigning,
  prepareGuardianPlanSigning, preparePlanSigning,
  type WalletAccount,
} from "@crclaunch/crc20-adapters";

export type CrcReviewedSigning = {
  /** Independently reconstructed with a core builder from the user's reviewed request. */
  plan: core.Plan;
  psbtBase64: string;
  ledger: core.Ledger;
  network: string;
  accounts: WalletAccount[];
  operation: string;
  guardianPending?: boolean;
};

function addressScript(address: string, network: string): string {
  const chain = core.protocolNetwork(network);
  const params = chain === "bitcoin" ? bitcoin.networks.bitcoin : chain === "regtest" ? bitcoin.networks.regtest : bitcoin.networks.testnet;
  if (/^(bc1p|tb1p|bcrt1p)/.test(address)) {
    const decoded = bitcoin.address.fromBech32(address);
    if (decoded.prefix !== params.bech32 || decoded.version !== 1 || decoded.data.length !== 32) throw new Error("Wallet network differs from reviewed transaction");
    return `5120${decoded.data.toString("hex")}`;
  }
  return bitcoin.address.toOutputScript(address, params).toString("hex");
}

export async function signCrcReviewedPlan(
  context: CrcReviewedSigning,
  signPsbt: (psbtBase64: string, operation: string) => Promise<string>,
): Promise<string> {
  const network = core.protocolNetwork(context.network);
  if (context.ledger.config.network !== network) throw new Error("Wallet network differs from reviewed transaction");
  const accounts = context.accounts.map((account) => ({ ...account, scriptHex: addressScript(account.address, network) }));
  const walletInputs = context.plan.inputs.flatMap((input, index) => {
    if (context.plan.inputWitnesses?.[index]?.length || (context.guardianPending && index === 0)) return [];
    const owner = accounts.find((account) => account.scriptHex === input.scriptHex);
    if (!owner) throw new Error("Reviewed input does not belong to the connected wallet");
    return [{ address: owner.address, publicKey: owner.publicKey, index }];
  });
  const options = { network, walletInputs };
  const prepared = context.guardianPending
    ? prepareGuardianPlanSigning(context.plan, context.ledger, options)
    : preparePlanSigning(context.plan, options);
  const expected = bitcoin.Psbt.fromBase64(prepared.params.psbt);
  const received = bitcoin.Psbt.fromBase64(context.psbtBase64);
  if (!received.data.globalMap.unsignedTx.toBuffer().equals(expected.data.globalMap.unsignedTx.toBuffer())) throw new Error("Server transaction differs from reviewed core plan");
  expected.data.inputs.forEach((input, index) => {
    const actual = received.data.inputs[index]!;
    if (!actual.witnessUtxo || !input.witnessUtxo || actual.witnessUtxo.value !== input.witnessUtxo.value ||
      !actual.witnessUtxo.script.equals(input.witnessUtxo.script)) throw new Error("Server prevout differs from reviewed core plan");
    for (const field of ["redeemScript", "tapInternalKey", "finalScriptWitness", "finalScriptSig"] as const) {
      if ((input[field] || actual[field]) && !input[field]?.equals(actual[field] ?? Buffer.alloc(0))) throw new Error(`Server changed ${field}`);
    }
    if (context.guardianPending && index === 0) {
      if (actual.sighashType !== undefined && actual.sighashType !== 1) throw new Error("Server changed vault signing metadata");
    } else if (actual.sighashType !== input.sighashType) throw new Error("Server changed signing sighash");
  });
  const response = await signPsbt(prepared.params.psbt, context.operation);
  return completeBrowserWalletSigning(prepared, response, context.ledger).psbtBase64;
}
