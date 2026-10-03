import { expect, test, vi } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import { CrcWalletData } from "./crc-wallet-data";
import { type CrcPublicChain, PublicChainInvalid, PublicChainUnavailable } from "./crc-public-chain";
const address = "tb1qg358gsla30dtx228u3za8253zncpzdwkrl6eem";
const script = bitcoin.address.toOutputScript(address, bitcoin.networks.testnet).toString("hex");
const tx = new bitcoin.Transaction(); tx.addInput(Buffer.alloc(32, 1), 0); tx.addOutput(Buffer.from(script, "hex"), 12000);
const candidates = [{ txid: tx.getId(), vout: 0 }];
test("normal browser proof path never calls the backend wallet observation", async () => {
  const server = vi.fn();
  const client = { evidence: vi.fn(async () => ({ version: 1, network: "signet", parents: [{ txid: tx.getId(), rawHex: tx.toHex() }] })) } as unknown as CrcPublicChain;
  const result = await new CrcWalletData("signet", server, client).funding(address, candidates);
  expect(result.fundingEvidence?.version).toBe(1); expect(server).not.toHaveBeenCalled();
});
test("outage restarts funding from server observations and omits all browser proof", async () => {
  const fresh = { txid: "aa".repeat(32), vout: 2, valueSats: "20000", confirmations: 1 };
  const server = vi.fn(async () => Response.json({ ok: true, data: { utxos: [fresh] } }));
  const client = { evidence: vi.fn(async () => { throw new PublicChainUnavailable("timeout"); }) } as unknown as CrcPublicChain;
  const result = await new CrcWalletData("signet", server, client).funding(address, candidates);
  expect(result).toEqual({ funding: [{ txid: fresh.txid, vout: 2 }], fundingEvidence: undefined });
  expect(server).toHaveBeenCalledOnce();
});
test("semantic invalidity and cancellation never trigger server fallback", async () => {
  const server = vi.fn();
  const client = { evidence: vi.fn(async () => { throw new PublicChainInvalid("wrong network"); }) } as unknown as CrcPublicChain;
  await expect(new CrcWalletData("signet", server, client).funding(address, candidates)).rejects.toThrow("wrong network");
  const controller = new AbortController(); controller.abort(new Error("canceled"));
  await expect(new CrcWalletData("signet", server, client).funding(address, candidates, [address], controller.signal)).rejects.toThrow("canceled");
  expect(server).not.toHaveBeenCalled();
});
