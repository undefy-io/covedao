import { buildCancel, buildPurchase, buildTransfer, validateConfig } from "./builders.js";
import { escrowCustody, validateEscrowConfig } from "./escrow-terms.js";
import type { Config, EscrowTerms, Input, Offer, Plan } from "./types.js";
export function buildEscrowListing(args: {
  config: Config;
  terms: EscrowTerms;
  inputs: Input[];
  funding: Input[];
  changeScriptHex?: string;
  minerFeeSats?: bigint;
}): Plan {
  const { terms: t } = args;
  validateConfig(args.config);
  validateEscrowConfig(t, args.config);
  if (
    !args.inputs.length ||
    args.inputs.length > 32 ||
    args.inputs.some(
      (i) => i.scriptHex !== t.sellerTokenScriptHex || i.deployTxid !== t.deployTxid,
    ) ||
    args.funding.some((i) => i.scriptHex !== t.sellerAuthorityScriptHex)
  )
    throw new Error("escrow seller inputs/authority mismatch");
  const plan = buildTransfer({
    network: t.network,
    deployTxid: t.deployTxid,
    ticker: t.ticker,
    amountAtoms: t.amountAtoms,
    inputs: args.inputs,
    funding: args.funding,
    recipientScriptHex: escrowCustody(t).scriptHex,
    changeScriptHex: args.changeScriptHex ?? t.sellerAuthorityScriptHex,
    minerFeeSats: args.minerFeeSats,
  });
  return { ...plan, listedAtoms: t.amountAtoms };
}
export function buildEscrowPurchase(
  args: Parameters<typeof buildPurchase>[0] & { offer: Offer },
): Plan {
  if (!args.offer.escrowTerms) throw new Error("escrow offer required");
  if (args.protocolScriptHex !== args.offer.escrowTerms.protocolScriptHex)
    throw new Error("escrow protocol payout mismatch");
  return buildPurchase(args);
}
export function buildEscrowCancel(args: Parameters<typeof buildCancel>[0]): Plan {
  if (!args.offer.escrowTerms) throw new Error("escrow offer required");
  if (
    !args.funding.length ||
    args.funding.some((i) => i.scriptHex !== args.offer.escrowTerms!.sellerAuthorityScriptHex)
  )
    throw new Error("seller cancellation authority funding required");
  return buildCancel(args);
}
