import {createServer} from "node:http";
import {build} from "esbuild";
import {chromium} from "@playwright/test";
import {expect,test} from "vitest";

const assetId="regtest:"+"aa".repeat(32);
test("desktop/mobile amount seller stages confirmation, invalidates edits, and never restores signed transactions",async()=>{
 const fixture=`
 window.calls={review:0,prepare:0,publish:0,activated:0};window.confirmed=false;window.publishError='';window.readers=new Set();
 window.wallet={connected:true,network:'regtest',address:'alice',ordinalsAddress:'alice',script:'0014'+'11'.repeat(20),ordinalsScript:'0014'+'11'.repeat(20),publicKey:'02'+'22'.repeat(32),connect:async()=>{},signPsbt:async()=>'',signBip322:async()=>''};
 window.snapshot=()=>({height:window.confirmed?102:100,token:{assetId:${JSON.stringify(assetId)},network:'regtest',deployTxid:'aa'.repeat(32),ticker:'TEST',coreState:{}},coins:[{txid:window.confirmed?'ee'.repeat(32):'bb'.repeat(32),vout:window.confirmed?1:0,atoms:window.confirmed?'30000000000':'40000000000',btcSats:'1000',scriptHex:window.wallet.ordinalsScript}],listings:[],unavailableOutpoints:[],truncated:false});
 window.tip=()=>Promise.all([...window.readers].map(read=>read(new AbortController().signal)));
 window.prepareError='';window.suspended=false;
 `;
 const bundle=await build({stdin:{resolveDir:new URL('.',import.meta.url).pathname,contents:`
 import React from 'react';import {createRoot} from 'react-dom/client';import {CrcMarketSeller} from './CrcMarketSeller';
 ${fixture}
 const root=createRoot(document.getElementById('root'));window.render=()=>root.render(React.createElement(CrcMarketSeller));window.render();
 `},bundle:true,write:false,platform:'browser',format:'esm',target:'es2022',jsx:'automatic',tsconfig:new URL('../../tsconfig.json',import.meta.url).pathname,inject:[new URL('../../../../packages/crc20-adapters/browser-buffer.mjs',import.meta.url).pathname],plugins:[{name:'seller-fixtures',setup(builder){
 builder.onResolve({filter:/WalletProvider$/},()=>({path:'wallet',namespace:'fixture'}));
 builder.onResolve({filter:/CrcHome$/},()=>({path:'home',namespace:'fixture'}));
 builder.onResolve({filter:/crc-indexed-refresh$/},()=>({path:'refresh',namespace:'fixture'}));
 builder.onResolve({filter:/crc-market-listing$/},()=>({path:'listing',namespace:'fixture'}));
 builder.onResolve({filter:/crc-market-client$/},()=>({path:'client',namespace:'fixture'}));
 builder.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:({
 wallet:`export const useWallet=()=>window.wallet;`,home:`export const formatAtoms=a=>String(BigInt(a)/100000000n);`,
 refresh:`export const crcIndexedRefresh={subscribe(read){window.readers.add(read);void read(new AbortController().signal);return()=>window.readers.delete(read);}};`,
 client:`export const cancelCrcMarketListing=async()=>({txid:'ff'.repeat(32)});`,
 listing:`
 export const loadCrcSellerSnapshot=async()=>window.snapshot();
 export async function reviewCrcAmountListing(args,wallet,request,guard){guard();window.calls.review++;return {...args,selected:window.snapshot().coins,changeAtoms:40000000000n-args.amountAtoms,walletDeltaSats:1000n,...(args.amountAtoms===40000000000n||args.preferredCoin?{offer:{expiresAtHeight:BigInt(window.snapshot().height+args.expiryBlocks)}}:{built:{intent:{minerFeeSats:1000}}})};}
 export async function prepareCrcAmountListing(review,wallet,request,guard){guard();window.calls.prepare++;if(window.prepareError)throw Error(window.prepareError);return {txid:'ee'.repeat(32),review,coin:{txid:'ee'.repeat(32),vout:1,atoms:'30000000000',btcSats:'1000',scriptHex:wallet.ordinalsScript}};}
 export async function publishCrcAmountListing(review,wallet,request,guard){guard();window.calls.publish++;if(window.suspended)await new Promise(r=>window.release=r);guard();if(window.publishError)throw Error(window.publishError);window.calls.activated++;return 'offer-id';}
 `
 } as Record<string,string>)[path]!,loader:'js'}));
 }}]});
 const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/bundle.js'?'text/javascript':'text/html');res.end(req.url==='/bundle.js'?bundle.outputFiles[0]!.text:'<div id="root"></div><script type="module" src="/bundle.js"></script>');});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch();
 try {for(const viewport of [{width:1280,height:800},{width:390,height:844}]) {
  const page=await browser.newPage({viewport});
  await page.route('**/api/**',async route=>{const url=route.request().url();const data=url.includes('/balances')?{balances:[{assetId,ticker:'TEST',atoms:'40000000000'}],nextCursor:null}:{active:true,listings:[],truncated:false,unavailableOutpoints:[]};await route.fulfill({json:{ok:true,data}});});
  await page.goto(`http://127.0.0.1:${(server.address() as {port:number}).port}`);
  await page.getByText('Confirmed: 400',{exact:false}).waitFor();expect(await page.getByLabel('Whole token output').count()).toBe(0);
  await page.getByLabel('Amount to sell').fill('400');await page.getByLabel('Total price (sats)').fill('5000');await page.getByRole('button',{name:'Review listing',exact:true}).click();
  await page.getByRole('button',{name:'Sign and publish listing'}).waitFor();
  await page.getByLabel('Amount to sell').fill('300');expect(await page.getByRole('button',{name:'Sign and publish listing'}).count()).toBe(0);
  await page.getByRole('button',{name:'Review listing',exact:true}).click();await page.getByText('Tokens returned as change: 100').waitFor();
  await page.getByRole('button',{name:'Sign and prepare tokens'}).click();await page.getByText('Waiting for confirmation',{exact:false}).waitFor();
  expect(await page.getByRole('button',{name:'Review prepared listing'}).isDisabled()).toBe(true);
  expect(await page.evaluate('window.calls')).toMatchObject({prepare:1,publish:0});
  const calls=await page.evaluate('window.calls.review');await page.waitForTimeout(100);expect(await page.evaluate('window.calls.review')).toBe(calls);
  await page.evaluate('window.confirmed=true;window.tip()');await page.getByRole('button',{name:'Review prepared listing'}).click();await page.getByText('Expires after block 114').waitFor();
  await page.evaluate('window.publishError="Wallet cancelled"');await page.getByRole('button',{name:'Sign and publish listing'}).click();await page.getByRole('alert').filter({hasText:'Wallet cancelled'}).waitFor();
  expect(await page.evaluate('window.calls.prepare')).toBe(1);
  await page.evaluate('window.publishError=""');await page.getByRole('button',{name:'Sign and publish listing'}).click();await page.getByText('Listed 300 tokens',{exact:false}).waitFor();
  expect(await page.evaluate('window.calls')).toMatchObject({prepare:1,publish:2,activated:1});
  expect(await page.evaluate('Object.keys(localStorage).some(k=>k.startsWith("crc-pending"))')).toBe(false);
  await page.reload();await page.getByLabel('Amount to sell').waitFor();expect(await page.getByLabel('Amount to sell').inputValue()).toBe('');expect(await page.getByText('Preparation transaction:',{exact:false}).count()).toBe(0);
  // A switched wallet must not activate the old reviewed offer after a prompt resolves.
  await page.getByLabel('Amount to sell').fill('400');await page.getByLabel('Total price (sats)').fill('5000');await page.getByRole('button',{name:'Review listing',exact:true}).click();await page.evaluate('window.suspended=true');await page.getByRole('button',{name:'Sign and publish listing'}).click();
  await page.waitForFunction('typeof window.release === "function"');await page.evaluate('window.wallet={...window.wallet,connected:false};window.render()');await page.getByRole('button',{name:'Connect wallet'}).waitFor();await page.evaluate('window.release()');
  expect(await page.evaluate('window.calls.activated')).toBe(0);
  expect(await page.evaluate('document.documentElement.scrollWidth<=innerWidth')).toBe(true);
  await page.close();
 }}finally{await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
},30000);
