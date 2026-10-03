// Read-only smoke check of the shared browser data path. No wallet signing or API mutations.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { build } = require("esbuild"), { chromium } = require("@playwright/test");
const rpc = process.env.NEXT_PUBLIC_COVE_BITCOIN_RPC_URL;
const index = process.env.NEXT_PUBLIC_COVE_ESPLORA_URL;
const address = process.env.CRC_BROWSER_PROBE_ADDRESS;
if (!rpc || !index || !address) throw new Error("Explicit public RPC, Esplora and probe address required");
const bundle = await build({ stdin: { resolveDir: new URL("../../apps/web/src/lib/", import.meta.url).pathname, contents: `
  import {crcWalletData} from './crc-wallet-data';
  import {verifyFundingEvidence} from './crc-funding-evidence';
  import {fundingAddressScript} from './crc-wallet-data';
  const address=${JSON.stringify(address)};
  window.crcPublicProbe=async()=>{
    const data=crcWalletData('signet');
    const coins=await data.coins(address);
    const coin=coins.filter(c=>c.confirmations>0).sort((a,b)=>Number(BigInt(b.valueSats)-BigInt(a.valueSats)))[0];
    if(!coin)throw Error('Probe requires one confirmed coin');
    const candidates=[{txid:coin.txid,vout:coin.vout}];
    const packet=await data.funding(address,candidates);
    if(!packet.fundingEvidence)throw Error('Probe fell back to backend discovery');
    const inputs=verifyFundingEvidence(packet.fundingEvidence,'signet',candidates,fundingAddressScript(address,'signet'));
    const observed=await data.observe([address],inputs);
    return {network:'signet',address,coins:coins.length,proofVersion:packet.fundingEvidence.version,observedInputs:observed.length,signing:false};
  };` }, bundle: true, write: false, format: "iife", platform: "browser", target: "es2022", inject: [new URL("../../packages/crc20-adapters/browser-buffer.mjs", import.meta.url).pathname], define: { "process.env.NEXT_PUBLIC_COVE_NETWORK": '"signet"', "process.env.NEXT_PUBLIC_COVE_BITCOIN_RPC_URL": JSON.stringify(rpc), "process.env.NEXT_PUBLIC_COVE_ESPLORA_URL": JSON.stringify(index) } });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(process.env.CRC_BROWSER_BASE_URL ?? "http://127.0.0.1:3000", { waitUntil: "domcontentloaded" });
  const requests = [];
  page.on("request", request => {
    if (request.url().startsWith(rpc) || request.url().startsWith(index) || request.url().includes("/wallet/utxos")) {
      requests.push({ url: request.url(), method: request.method(), rpcMethod: request.postDataJSON()?.method });
    }
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate("window.crcPublicProbe()");
  if (requests.some(request => request.url.includes("/wallet/utxos"))) throw new Error("Unexpected backend address discovery");
  const evidence = { ...result, requests, backendAddressDiscovery: 0, checkedAt: new Date().toISOString() };
  if (process.env.CRC_BROWSER_PROBE_OUTPUT) writeFileSync(process.env.CRC_BROWSER_PROBE_OUTPUT, JSON.stringify(evidence, null, 2)+"\n");
  console.log(JSON.stringify(evidence));
} finally { await browser.close(); }
