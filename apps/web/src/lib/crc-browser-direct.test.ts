import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { expect, test } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as core from "@crclaunch/crc20-protocol";
import { createPlanPsbt, prepareGuardianPlanSigning, preparePlanSigning } from "@crclaunch/crc20-adapters";
import { aliceKey, bobKey } from "../../../../packages/cove-market/crc20-protocol/test-support/core";
import { authorizeOffer } from "../../../../packages/cove-market/crc20-protocol/test-support/signing";

test("desktop/mobile browser callers discover, prove and review trades/purchases directly with zero wallet proxy reads", async () => {
  const saved = JSON.parse(readFileSync(new URL("../../../../artifacts/crc-core-integration/wallet-capabilities/xverse-core-mint-request.json", import.meta.url), "utf8"));
  const asset = core.decodeProtocolDto<{ state: core.Asset }>(saved).state;
  asset.issuedAtoms = core.atomsPerToken * 100n;
  asset.vault.sats = core.carrierSats + core.backingSats(asset.issuedAtoms);
  const payment = bitcoin.payments.p2wpkh({ pubkey: aliceKey.publicKey, network: bitcoin.networks.testnet });
  const script = payment.output!.toString("hex"), address = payment.address!;
  const parent = new bitcoin.Transaction(); parent.addInput(Buffer.alloc(32, 3), 0); parent.addOutput(payment.output!, 100000);
  const input = { txid: parent.getId(), vout: 0, sats: 100000n, scriptHex: script };
  const wallet = { network: "signet", address, publicKey: aliceKey.publicKey.toString("hex"), ordinalsAddress: address, ordinalsPublicKey: aliceKey.publicKey.toString("hex") };
  const buy = core.buildBuy({ state: asset, funding: [input], amountAtoms: core.atomsPerToken * 100n, recipientScriptHex: script, changeScriptHex: script, minerFeeSats: 400n });
  const seller = bitcoin.payments.p2wpkh({ pubkey: bobKey.publicKey, network: bitcoin.networks.testnet }).output!.toString("hex");
  const offer = await authorizeOffer({ network: "signet", deployTxid: asset.deployTxid, ticker: asset.config.ticker, listedInput: { txid: "bb".repeat(32), vout: 1, atoms: core.atomsPerToken * 100n, sats: 1000n, scriptHex: seller }, sellerScriptHex: seller, priceSats: 5000n, expiryHeight: 1000 }, bobKey.privateKey!);
  const purchase = core.buildPurchase({ offer, currentHeight: 100, buyerFunding: [input], buyerScriptHex: script, protocolScriptHex: asset.config.protocolScriptHex, changeScriptHex: script, minerFeeSats: 400n });
  function session(plan: core.Plan, operation: string) {
    const psbt = createPlanPsbt(plan, "signet", { publicKeys: { 1: wallet.publicKey } });
    const built = { sessionId: operation, psbtBase64: psbt.toBase64(), intent: { operation, offerId: operation === "purchase" ? core.offerId(offer) : undefined, assetId: `signet:${asset.deployTxid}`, amountAtoms: (core.atomsPerToken * 100n).toString(), minerFeeSats: 400, coreConfig: core.encodeProtocolDto(asset.config), corePlan: core.encodeProtocolDto(plan) } };
    const ledger = core.emptyLedger(asset.config); ledger.assets[asset.deployTxid] = asset;
    const options = { network: "signet", walletInputs: [{ index: 1, address, publicKey: wallet.publicKey }] };
    const prepared = operation === "mint-buy" ? prepareGuardianPlanSigning(plan, ledger, options) : preparePlanSigning(plan, options);
    const response = bitcoin.Psbt.fromBase64(prepared.params.psbt); response.signInput(1, aliceKey);
    return { built, signed: response.toBase64() };
  }
  const fixtures = { wallet, buy: session(buy, "mint-buy"), purchase: session(purchase, "purchase"), offer: core.encodeProtocolDto(offer), input: { txid: input.txid, vout: input.vout } };
  const bundle = await build({ stdin: { resolveDir: new URL(".", import.meta.url).pathname, contents: `
    import * as core from '@crclaunch/crc20-protocol';
    import {crcWalletData} from './crc-wallet-data';
    import {signCrcBuildSession} from './crc-browser-session';
    const f=${JSON.stringify(fixtures)};
    window.run=async()=>{
      const data=crcWalletData('signet');
      const coins=await data.coins(f.wallet.address);
      const proof=await data.funding(f.wallet.address,[f.input]);
      for(const [key,operation] of [['buy','buy'],['purchase','purchase']]){
        const current=f[key];
        await signCrcBuildSession(current.built,{operation,assetId:current.built.intent.assetId,amountAtoms:current.built.intent.amountAtoms,minerFeeSats:400,...(operation==='purchase'?{offer:core.decodeProtocolDto(f.offer)}:{})},f.wallet,async()=>current.signed);
      }
      return {coins:coins.length,proof:proof.fundingEvidence.version};
    };` }, bundle: true, write: false, platform: "browser", format: "esm", target: "es2022", inject: [new URL("../../../../packages/crc20-adapters/browser-buffer.mjs", import.meta.url).pathname], define: { "process.env.NEXT_PUBLIC_COVE_NETWORK": '"signet"', "process.env.NEXT_PUBLIC_COVE_BITCOIN_RPC_URL": '"https://rpc.example"', "process.env.NEXT_PUBLIC_COVE_ESPLORA_URL": '"https://index.example"' } });
  const server = createServer((req, res) => { res.setHeader("content-type", req.url === "/bundle.js" ? "text/javascript" : "text/html"); res.end(req.url === "/bundle.js" ? bundle.outputFiles[0]!.text : '<script type="module" src="/bundle.js"></script>'); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch();
  try {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport }), calls: { url: string; method?: string; params?: unknown[] }[] = [];
      await page.route(/rpc\.example|index\.example|\/api\/crc\//, async route => {
        const req = route.request(), url = req.url(), body = req.postDataJSON() as { method?: string; params?: unknown[] } | null;
        calls.push({ url, method: body?.method, params: body?.params });
        let result: unknown;
        if (url.includes("rpc.example")) {
          const values: Record<string, unknown> = { getblockchaininfo: { chain: "signet", blocks: 100 }, getblockhash: "11".repeat(32), getrawtransaction: parent.toHex(), gettxout: { confirmations: 1, value: 0.001, scriptPubKey: { hex: script } } };
          result = { result: values[body!.method!], error: null };
        } else if (url.includes("block-height/0")) {
          await route.fulfill({ status: 200, body: "11".repeat(32), headers: { "access-control-allow-origin": "*" } }); return;
        } else if (url.includes("index.example")) result = [{ txid: input.txid, vout: 0, value: 100000, status: { confirmed: true, block_height: 100 } }];
        else if (url.includes("funding-check")) result = { ok: true, data: { tokenFreeOutpoints: [fixtures.input] } };
        else if (url.includes("/utxos")) result = { ok: true, data: { utxos: [{ txid: offer.listedInput.txid, vout: offer.listedInput.vout, scriptHex: seller, atoms: offer.listedInput.atoms.toString(), btcSats: "1000" }], truncated: false } };
        else result = { ok: true, data: { token: { coreState: core.encodeProtocolDto(asset) }, indexedTip: { height: "100", blockHash: "11".repeat(32) } } };
        await route.fulfill({ status: 200, json: result, headers: { "access-control-allow-origin": "*" } });
      });
      const port = (server.address() as { port: number }).port;
      await page.goto(`http://127.0.0.1:${port}`); await page.waitForFunction("typeof window.run === 'function'");
      expect(await page.evaluate("window.run()")).toEqual({ coins: 1, proof: 1 });
      expect(calls.some(call => call.url.includes("/wallet/utxos"))).toBe(false);
      expect(calls.filter(call => call.method === "getrawtransaction")).toHaveLength(1);
      expect(calls.filter(call => call.method === "gettxout").map(call => call.params)).toEqual([[input.txid, 0, true], [input.txid, 0, true]]);
      await page.close();
    }
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 30000);
