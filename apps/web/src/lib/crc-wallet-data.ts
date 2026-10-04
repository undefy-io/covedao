import * as bitcoin from "bitcoinjs-lib";
import * as core from "@crclaunch/crc20-protocol";
import { CrcPublicChain } from "./crc-public-chain";
import { verifyFundingEvidence, type FundingOutpoint } from "./crc-funding-evidence";
import { type WalletFundingCoin } from "./funding-candidates";

type Requester = (url: string, init?: RequestInit) => Promise<Response>;
type Input = { txid: string; vout: number; sats: bigint; scriptHex: string };
export function fundingAddressScript(address: string, network: string): string {
  const net = network === "mainnet" || network === "bitcoin" ? bitcoin.networks.bitcoin
    : network === "regtest" ? bitcoin.networks.regtest : bitcoin.networks.testnet;
  if (/^(bc1p|tb1p|bcrt1p)/.test(address)) {
    const decoded = bitcoin.address.fromBech32(address);
    if (decoded.prefix !== net.bech32 || decoded.version !== 1 || decoded.data.length !== 32) throw new Error("Wallet network mismatch");
    return `5120${decoded.data.toString("hex")}`;
  }
  return bitcoin.address.toOutputScript(address, net).toString("hex");
}

export class CrcWalletData {
  constructor(readonly network: string, private readonly request: Requester, private readonly client?: CrcPublicChain) {}
  get canBroadcast(): boolean { return !!this.client; }
  broadcast(rawHex: string, txid: string, signal?: AbortSignal): Promise<string> {
    if (!this.client) throw new Error("Public broadcast is unavailable. Refresh this page and retry.");
    return this.client.broadcast(rawHex, txid, signal);
  }
  private requireRegtest(): void {
    if (this.network !== "regtest") throw new Error("Public chain configuration is unavailable. Refresh this page and retry.");
  }
  private async serverCoins(address: string, signal?: AbortSignal): Promise<WalletFundingCoin[]> {
    this.requireRegtest();
    signal?.throwIfAborted();
    const response = await (0, this.request)(`/api/crc/v1/wallet/utxos?address=${encodeURIComponent(address)}`, { cache: "no-store", signal });
    const body = await response.json();
    if (!response.ok || !body.ok || !Array.isArray(body.data?.utxos)) throw new Error(body.error?.message || "Wallet funding lookup failed");
    return body.data.utxos;
  }
  async coins(address: string, signal?: AbortSignal): Promise<WalletFundingCoin[]> {
    fundingAddressScript(address, this.network);
    if (this.client) return this.client.coins(address, signal);
    return this.serverCoins(address, signal);
  }
  async funding(address: string, candidates: FundingOutpoint[], _addresses: string[] = [address], signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.client) {
      const fundingEvidence = await this.client.evidence(candidates, signal);
      verifyFundingEvidence(fundingEvidence, this.network, candidates, fundingAddressScript(address, this.network));
      return { funding: candidates, fundingEvidence };
    }
    this.requireRegtest();
    return { funding: candidates, fundingEvidence: undefined };
  }
  async observe(addresses: string[], inputs: Input[], signal?: AbortSignal) {
    if (this.client) return (await this.client.observe(inputs, signal)).map(input => ({txid:input.txid,vout:input.vout,
      valueSats:core.sats(input.sats).toString(),confirmations:input.confirmations,scriptHex:input.scriptHex}));
    this.requireRegtest();
    const rows = await Promise.all([...new Set(addresses)].map(async address => ({
      scriptHex: fundingAddressScript(address, this.network), coins: await this.serverCoins(address, signal),
    })));
    return rows.flatMap(row => row.coins.filter(coin => (coin.confirmations ?? 0) > 0).map(coin => ({ ...coin, scriptHex: row.scriptHex })));
  }
}
let shared: { key: string; client: CrcPublicChain } | undefined;
export function crcWalletData(network: string, request: Requester = fetch): CrcWalletData {
  const rpc = process.env.NEXT_PUBLIC_COVE_BITCOIN_RPC_URL;
  const index = process.env.NEXT_PUBLIC_COVE_ESPLORA_URL;
  let client: CrcPublicChain | undefined;
  if (typeof window !== "undefined" && network !== "regtest" && rpc && index) {
    if (network !== process.env.NEXT_PUBLIC_COVE_NETWORK) throw new Error("Public chain configuration network mismatch");
    const key = JSON.stringify([network, rpc, index]);
    if (shared?.key !== key) shared = { key, client: new CrcPublicChain(network, rpc, index) };
    client = shared.client;
  }
  return new CrcWalletData(network, request, client);
}
