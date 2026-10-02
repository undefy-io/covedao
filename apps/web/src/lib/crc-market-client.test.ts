import { describe, expect, it, vi } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import { buildCoveV3MarketFill, buildUnsignedPsbt } from "@crclaunch/crc20-transactions";
import { buyCrcMarketListing, type CrcMarketListing } from "./crc-market-client";

const deployTxid = "a".repeat(64);
const sellerScript = `0014${"b".repeat(40)}`;
const buyerScript = `0014${"c".repeat(40)}`;
const protocolScript = `0014${"d".repeat(40)}`;
const vaultScript = `5120${"e".repeat(64)}`;
const sellerTxid = "f".repeat(64);
const buyerTxid = "1".repeat(64);
const listing: CrcMarketListing = {
  id: "11111111-1111-4111-8111-111111111111", network: "regtest", deployTxid,
  ticker: "COVE", sellerScriptHex: sellerScript, sellerPayoutScriptHex: sellerScript,
  sellerAnchorTxid: sellerTxid, sellerAnchorVout: 0, sellerAnchorSats: 10_000,
  amountAtoms: "100000000000", priceSats: 5_000, protocolFeeSats: 1_000,
  expiresAtHeight: "200", status: "OPEN",
};
const wallet = { network: "regtest", script: buyerScript, publicKey: "", ordinalsScript: buyerScript,
  address: bitcoin.address.fromOutputScript(Buffer.from(buyerScript, "hex"), bitcoin.networks.regtest),
  ordinalsAddress: bitcoin.address.fromOutputScript(Buffer.from(buyerScript, "hex"), bitcoin.networks.regtest),
  signPsbt: vi.fn(async () => "signed") };

function psbt(priceSats = 5_000, recipientScript = buyerScript) {
  const seller = { txid: sellerTxid, vout: 0, valueSats: 10_000, scriptHex: sellerScript,
    tokenAtoms: 100_000_000_000n, tokenDeploymentTxid: deployTxid };
  const buyer = { txid: buyerTxid, vout: 0, valueSats: 10_000, scriptHex: buyerScript,
    tokenAtoms: 0n };
  const template = buildCoveV3MarketFill({ ticker: "COVE", deploymentTxid: deployTxid,
    listedInput: seller, buyerScriptHex: recipientScript, recipientSats: 1_000,
    sellerNetPriceSats: priceSats, protocolScriptHex: protocolScript,
    protocolFeeSats: 1_000, buyerChangeSats: 2_600 - (priceSats - 5_000),
    buyerChangeScriptHex: buyerScript });
  const built = buildUnsignedPsbt(template, [seller, buyer], 400, bitcoin.networks.regtest);
  built.data.inputs[0]!.sighashType = bitcoin.Transaction.SIGHASH_SINGLE | bitcoin.Transaction.SIGHASH_ANYONECANPAY;
  return built.toBase64();
}

function response(data: unknown) {
  return new Response(JSON.stringify({ ok: true, data }), { status: 200 });
}

function requests(fillPsbt = psbt(), tokenAtoms = listing.amountAtoms,
  buyerCoins = [{ txid: buyerTxid, vout: 0, valueSats: "10000" }],
  tokenFreeOutpoints = buyerCoins.map(({ txid, vout }) => ({ txid, vout }))) {
  const requested: string[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    requested.push(url);
    if (url.includes(`/tokens/${encodeURIComponent(`regtest:${deployTxid}`)}/utxos`)) {
      return response({ utxos: [{ txid: sellerTxid, vout: 0, atoms: tokenAtoms, scriptHex: sellerScript }], truncated: false });
    }
    if (url.includes(`/tokens/${encodeURIComponent(`regtest:${deployTxid}`)}`)) {
      return response({ indexedTip: { height: "100" }, token: { network: "regtest", deployTxid,
        ticker: "COVE", protocolVersion: 3, protocolScriptHex: protocolScript,
        vault: { scriptHex: vaultScript } } });
    }
    if (url.startsWith("/api/crc/v1/wallet/utxos")) {
      return response({ utxos: url.includes(encodeURIComponent(wallet.address)) ? buyerCoins :
        [{ txid: sellerTxid, vout: 0, valueSats: "10000" }] });
    }
    if (url.endsWith("/market/funding-check")) {
      return response({ tokenFreeOutpoints });
    }
    if (url.endsWith("/market/reserve")) {
      return response({ fillId: JSON.parse(String(init?.body)).fillId, psbtBase64: fillPsbt });
    }
    if (url.endsWith("/market/buyer-sign")) return response({ fillId: JSON.parse(String(init?.body)).fillId,
      txid: "a".repeat(64), status: "BROADCAST" });
    throw new Error(`unexpected URL ${url}`);
  });
  return { fetcher, requested };
}

describe("CRC buyer market flow", () => {
  it("fetches indexed allocation and BTC anchors, then reviews the exact PSBT before wallet signing", async () => {
    wallet.signPsbt.mockClear();
    const { fetcher, requested } = requests();
    await expect(buyCrcMarketListing(listing, wallet, 400, fetcher)).resolves.toHaveProperty("txid", "a".repeat(64));
    expect(wallet.signPsbt).toHaveBeenCalledOnce();
    expect(wallet.signPsbt).toHaveBeenCalledWith(expect.any(String), "CRC_MARKET_BUY");
    expect(requested.some((url) => url.endsWith("/market/buyer-sign"))).toBe(true);
  });

  it("rejects stale token allocations and changed payouts without opening a wallet prompt", async () => {
    wallet.signPsbt.mockClear();
    const stale = requests(psbt(), "999");
    await expect(buyCrcMarketListing(listing, wallet, 400, stale.fetcher)).rejects.toThrow("Listed token output");
    expect(stale.requested.some((url) => url.endsWith("/market/reserve"))).toBe(false);
    const malicious = requests(psbt(5_001));
    await expect(buyCrcMarketListing(listing, wallet, 400, malicious.fetcher)).rejects.toThrow();
    expect(wallet.signPsbt).not.toHaveBeenCalled();
    expect(malicious.requested.some((url) => url.endsWith("/market/buyer-sign"))).toBe(false);
  });

  it("excludes token-bearing wallet outputs before reserving buyer funding", async () => {
    wallet.signPsbt.mockClear();
    const tokenTxid = "2".repeat(64);
    const coins = [{ txid: tokenTxid, vout: 0, valueSats: "10000" },
      { txid: buyerTxid, vout: 0, valueSats: "10000" }];
    const { fetcher } = requests(psbt(), listing.amountAtoms, coins, [{ txid: buyerTxid, vout: 0 }]);
    await buyCrcMarketListing(listing, wallet, 400, fetcher);
    const reserve = fetcher.mock.calls.find(([url]) => url.endsWith("/market/reserve"));
    expect(reserve).toBeDefined();
    expect(JSON.parse(String(reserve![1]?.body)).buyerFunding.map((coin: { txid: string }) => coin.txid))
      .toEqual([buyerTxid]);
    expect(wallet.signPsbt).toHaveBeenCalledOnce();
  });

  it("reviews a split payment and ordinals wallet with token carrier and BTC change at different scripts", async () => {
    wallet.signPsbt.mockClear();
    const ordinalsScript = `5120${"3".repeat(64)}`;
    const splitWallet = { ...wallet, ordinalsScript,
      ordinalsAddress: bitcoin.address.fromOutputScript(Buffer.from(ordinalsScript, "hex"), bitcoin.networks.regtest) };
    const { fetcher } = requests(psbt(5_000, ordinalsScript));
    await buyCrcMarketListing(listing, splitWallet, 400, fetcher);
    const reserve = fetcher.mock.calls.find(([url]) => url.endsWith("/market/reserve"));
    const body = JSON.parse(String(reserve![1]?.body));
    expect(body.buyerScriptHex).toBe(ordinalsScript);
    expect(body.buyerFundingScriptHex).toBe(buyerScript);
    expect(wallet.signPsbt).toHaveBeenCalledOnce();
  });
});
