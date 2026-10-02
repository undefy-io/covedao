export interface Input {
  txid: string;
  vout: number;
  sats: bigint | number;
  scriptHex: string;
  redeemScriptHex?: string;
  atoms?: bigint;
  deployTxid?: string;
}
export interface Output {
  sats: bigint;
  scriptHex: string;
  atoms?: bigint;
  role?: string;
}
export interface Config {
  network: string;
  ticker: string;
  vaultScriptHex: string;
  creatorScriptHex: string;
  protocolScriptHex: string;
  guardianCustody?: GuardianCustody;
}
export interface Asset {
  config: Config;
  deployTxid: string;
  issuedAtoms: bigint;
  inventoryAtoms: bigint;
  burnedAtoms: bigint;
  vault: Input;
  vaultAvailable?: boolean;
}
export interface Plan {
  inputWitnesses?: string[][];
  inputs: Input[];
  outputs: Output[];
  transactions: { inputs: Input[]; outputs: Output[] }[];
  markerJson: string;
  markerVout: number;
  recipientVout: number;
  changeAtoms: bigint;
  listedAtoms?: bigint;
  buyerAtoms?: bigint;
  sellerPayoutSats?: bigint;
  protocolFeeSats: bigint;
  creatorFeeSats: bigint;
  minerFeeSats: bigint;
  walletTopUpSats?: bigint;
}
export interface Offer {
  network: string;
  deployTxid: string;
  ticker: string;
  listedInput: Input & { atoms: bigint };
  sellerScriptHex: string;
  priceSats: bigint;
  expiryHeight: number;
  publicKeyHex: string;
  signatureHex: string;
  sellerWitnessHex: string[];
  status?: "open" | "cancelPending" | "cancelled" | "filled";
}
export interface ChainTransaction {
  rawHex: string;
  prevouts: Input[];
  /** Parent bytes authenticate ordinary observations when a confirmed spend violates CRC policy. */
  parentRawTransactions?: Record<string, string>;
}
export interface Block {
  hash: string;
  parentHash: string;
  height: number;
  timestamp?: number;
  transactions: ChainTransaction[];
}
export interface Allocation {
  atoms: bigint;
  sats: bigint;
  scriptHex: string;
  deployTxid: string;
}
export interface Ledger {
  config: Config;
  assets: Record<string, Asset>;
  allocations: Record<string, Allocation>;
  offers: Record<string, Offer>;
  spent: Record<string, true>;
  seen: Record<string, true>;
  tip?: { hash: string; height: number; fingerprint: string };
  history: Record<string, BlockUndo>;
}

/** Trusted registration metadata; recovery hash comes from the configured custody profile. */
export interface GuardianCustody {
  assetCommitmentHex: string;
  guardianPublicKeyHex: string;
  executionScriptHex: string;
  controlBlockHex: string;
  recoveryLeafHashHex: string;
}

export type LedgerState = Omit<Ledger, "history">;
export interface BlockUndo {
  tip?: Ledger["tip"];
  assets: Record<string, Asset | null>;
  allocations: Record<string, Allocation | null>;
  offers: Record<string, Offer | null>;
  spent: Record<string, true | null>;
  seen: Record<string, true | null>;
}
export interface ConfirmedBlockOptions {
  authorizations?: readonly Offer[];
  registeredDeployments?: Record<string, Config>;
  undoLimit?: number;
}
export interface ConfirmedEvent {
  txid: string;
  deployTxid: string;
  txIndex: number;
  kind: "deploy" | "mint" | "sell" | "inventoryBuy" | "transfer" | "fill" | "burn";
  valid: boolean;
  amountAtoms?: bigint;
  grossSats?: bigint;
}
