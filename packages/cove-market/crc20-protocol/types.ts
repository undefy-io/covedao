export interface Input {
  txid: string;
  vout: number;
  sats: bigint | number;
  scriptHex: string;
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
}
export interface Asset {
  config: Config;
  deployTxid: string;
  issuedAtoms: bigint;
  inventoryAtoms: bigint;
  burnedAtoms: bigint;
  vault: Input;
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
}
export interface Block {
  hash: string;
  parentHash: string;
  height: number;
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
  history: Record<string, Ledger>;
}
