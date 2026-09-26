/**
 * What Cove needs from a Bitcoin wallet.
 *
 * Seven wallets, seven slightly different interfaces. Each adapter reduces its
 * wallet to this, so the rest of the app never learns which one is connected.
 *
 * Deliberately NOT here: reading UTXOs. Cove asks its own Bitcoin node for
 * those. A wallet's idea of your unspent outputs comes from whatever indexer
 * it happens to use, and disagreeing with the node that will actually validate
 * the transaction is how a build fails for reasons nobody can see.
 */

export type WalletId = "unisat" | "xverse" | "magiceden" | "leather" | "okx" | "phantom" | "oyl";

export type CoveNetwork = "mainnet" | "testnet" | "signet" | "regtest";

/** One of a wallet's two addresses. */
export interface WalletAccount {
  address: string;
  /** scriptPubKey, hex. Derived from the address, never taken on trust. */
  script: string;
  /** Hex public key. Needed to spend anything but native segwit. */
  publicKey: string;
}

export interface WalletConnection {
  walletId: WalletId;
  /** Holds BTC: funds every purchase, receives every payout and change. */
  payments: WalletAccount;
  /** Holds token carriers. Taproot in every wallet that has a separate one. */
  ordinals: WalletAccount;
}

export interface SignPsbtRequest {
  psbtBase64: string;
  /**
   * Which inputs this wallet owns, and which of its addresses owns each.
   *
   * Cove works this out by matching each input's script against the two
   * connected addresses, rather than asking the wallet to guess. The backing
   * vault input is deliberately absent: only the Guardian can sign it, which
   * it does after the user, when the transaction is submitted.
   */
  inputsByAddress: { address: string; indexes: number[] }[];
  /**
   * The sighash to sign with. Omitted: SIGHASH_ALL. A presigned listing asks
   * for SIGHASH_SINGLE|ANYONECANPAY (0x83): the seller's carrier, paid out to
   * them, and nothing else — so a buyer can complete the sale later.
   */
  sighashType?: number;
}

export interface WalletAdapter {
  id: WalletId;
  name: string;
  /** Where to get it, shown when it is not installed. */
  installUrl: string;
  /** The wallet has no test networks; the picker says so instead of failing on connect. */
  mainnetOnly?: boolean;
  isInstalled(): Promise<boolean>;
  connect(network: CoveNetwork): Promise<WalletConnection>;
  /**
   * Sign, WITHOUT finalizing.
   *
   * Cove validates every signature server-side and finalizes there. A wallet
   * that finalized would hand back a transaction Cove could no longer check
   * input by input, which is the check that stops a wrong or hostile
   * transaction from being broadcast.
   */
  signPsbt(network: CoveNetwork, request: SignPsbtRequest): Promise<string>;
  /** BIP-322 message signature, used to authorise marketplace orders. */
  signMessage(network: CoveNetwork, address: string, message: string): Promise<string>;
}

export class WalletError extends Error {
  readonly code: "NOT_INSTALLED" | "REJECTED" | "WRONG_NETWORK" | "UNSUPPORTED" | "FAILED";
  constructor(code: WalletError["code"], message: string) {
    super(message);
    this.name = "WalletError";
    this.code = code;
  }
}
