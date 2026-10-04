import {expect,test,vi} from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as core from "@crclaunch/crc20-protocol";
import {createPlanPsbt} from "@crclaunch/crc20-adapters";
import {ECPairFactory} from "ecpair";
import * as ecc from "tiny-secp256k1";
import {authorizeOffer} from "../../../../packages/cove-market/crc20-protocol/test-support/signing.js";
import {reviewCrcAmountListing,prepareCrcAmountListing,publishCrcAmountListing,loadCrcSellerSnapshot} from "./crc-market-listing";
const key=ECPairFactory(ecc).fromPrivateKey(Buffer.alloc(32,2));
const pay=bitcoin.payments.p2wpkh({pubkey:key.publicKey,network:bitcoin.networks.regtest});
const script=pay.output!.toString("hex"), deployTxid="aa".repeat(32),assetId=`regtest:${deployTxid}`;
const input={txid:"bb".repeat(32),vout:0,atoms:400n*core.atomsPerToken,sats:1000n,scriptHex:script,deployTxid};
const funding={txid:"cc".repeat(32),vout:0,sats:10000n,scriptHex:script};
const config={network:"regtest",ticker:"TEST",vaultScriptHex:"0014"+"11".repeat(20),creatorScriptHex:script,protocolScriptHex:"0014"+"22".repeat(20)};
const state={config,deployTxid,issuedAtoms:input.atoms,inventoryAtoms:0n,burnedAtoms:0n,vault:{txid:"dd".repeat(32),vout:0,sats:1000n+core.backingSats(input.atoms),scriptHex:config.vaultScriptHex}};
function fixture() {
 let confirmed=false,height=100,truncated=false,spent=false,tamper=false,proofHook=()=>{};
 const prepared={txid:"ee".repeat(32),vout:1,atoms:300n*core.atomsPerToken,sats:1000n,scriptHex:script,deployTxid};
 const signer=vi.fn(async(base64:string,operation:string)=>{const psbt=bitcoin.Psbt.fromBase64(base64); if(operation==="P2P_LIST") psbt.signInput(0,key,[131]);else psbt.signAllInputs(key);return psbt.toBase64();});
 const proof=vi.fn(async()=>{proofHook();const terms={network:"regtest",deployTxid,ticker:"TEST",listedInput:confirmed?prepared:input,sellerScriptHex:script,priceSats:5000n,expiryHeight:height+12};const offer=await authorizeOffer(terms,key.privateKey!);return Buffer.from(offer.signatureHex,"hex").toString("base64");});
 const wallet={network:"regtest",address:pay.address!,ordinalsAddress:pay.address!,publicKey:key.publicKey.toString("hex"),ordinalsPublicKey:key.publicKey.toString("hex"),script,ordinalsScript:script,signPsbt:signer,signBip322:proof};
 const request=vi.fn(async(url:string,init?:RequestInit)=>{
  const body=init?.body?JSON.parse(String(init.body)):undefined;let data:unknown;
  if(url.includes('/wallet/utxos')) data={utxos:[...(!spent?[{txid:input.txid,vout:0,valueSats:"1000",confirmations:1},{txid:prepared.txid,vout:1,valueSats:"1000",confirmations:confirmed?1:0}]:[]),{txid:funding.txid,vout:0,valueSats:"10000",confirmations:1}]};
  else if(url.includes('/utxos?')) data={utxos:(confirmed?[prepared]:[input]).map(c=>({txid:c.txid,vout:c.vout,atoms:c.atoms.toString(),btcSats:c.sats.toString(),scriptHex:c.scriptHex})),truncated:false};
  else if(url.includes('/tokens/')) data={token:{assetId,network:'regtest',deployTxid,ticker:'TEST',coreState:core.encodeProtocolDto(state)},indexedTip:{height:String(height),blockHash:'ff'.repeat(32)}};
  else if(url.includes('/listings?')) data={active:true,listings:[],unavailableOutpoints:[],truncated};
  else if(url.endsWith('/fees')) data={tiers:[{key:'standard',satPerVb:'2'}]};
  else if(url.endsWith('/funding-check')) data={tokenFreeOutpoints:[{txid:funding.txid,vout:0}]};
  else if(url.endsWith('/listing-build')) {
   expect(body.feeRateSatPerVb).toBe(2);expect(body.minerFeeSats).toBeUndefined();expect(body.recipientScriptHex).toBe(script);expect(body.amountAtoms).toBe((300n*core.atomsPerToken).toString());expect(body.tokenFunding).toEqual([{txid:input.txid,vout:0}]);
   const plan=core.buildListing({network:'regtest',deployTxid,ticker:'TEST',input,funding:[funding],amountAtoms:300n*core.atomsPerToken,sellerScriptHex:script,recipientScriptHex:script,changeScriptHex:script,priceSats:5000n,minerFeeSats:1000n});
   if(tamper) plan.outputs.find(o=>o.role==="btcChange")!.scriptHex=config.protocolScriptHex;
   data={sessionId:'test-session',psbtBase64:createPlanPsbt(plan,'regtest').toBase64(),intent:{operation:'listing',assetId,amountAtoms:body.amountAtoms,priceSats:'5000',minerFeeSats:1000,feeRateSatPerVb:2,corePlan:core.encodeProtocolDto(plan),coreConfig:core.encodeProtocolDto(config)}};
  } else if(url.endsWith('/listing-submit')) data={txid:prepared.txid};
  else if(url.endsWith('/listings')) {const offer=core.decodeProtocolDto<core.Offer>(body.offer);core.verifyOffer(offer);data={listingId:core.offerId(offer)};}
  else throw new Error(`Unexpected ${url}`);
  return new Response(JSON.stringify({ok:true,data}));
 });
 return {wallet,request,signer,proof,confirm:()=>{confirmed=true;height=102;},truncate:()=>{truncated=true;},spend:()=>{spent=true;},tamper:()=>{tamper=true;},onProof:(fn:()=>void)=>{proofHook=fn;}};
}
const args={assetId,amountAtoms:300n*core.atomsPerToken,priceSats:5000n,expiryBlocks:12};
test('exact400 offer needs no payment discovery, setup transaction or broadcast',async()=>{
 const f=fixture();const review=await reviewCrcAmountListing({...args,amountAtoms:input.atoms},f.wallet,f.request);
 expect(review.built).toBeUndefined();expect(review.offer?.amountAtoms).toBe(input.atoms);
 await publishCrcAmountListing(review,f.wallet,f.request);
 expect(f.signer).toHaveBeenCalledOnce();expect(f.proof).toHaveBeenCalledOnce();
 expect(f.request.mock.calls.some(([url])=>/listing-build|listing-submit|funding-check|\/fees/.test(url))).toBe(false);
});
test('400 lists300 with100change, waits indexed confirmation and publishes only explicitly',async()=>{
 const f=fixture();const review=await reviewCrcAmountListing(args,f.wallet,f.request);
 expect(review.changeAtoms).toBe(100n*core.atomsPerToken);expect(f.signer).not.toHaveBeenCalled();
 const prepared=await prepareCrcAmountListing(review,f.wallet,f.request);
 expect(prepared.coin.atoms).toBe(args.amountAtoms.toString());expect(prepared.coin.vout).toBe(1);expect(f.signer).toHaveBeenCalledOnce();expect(f.proof).not.toHaveBeenCalled();
 const waiting=await loadCrcSellerSnapshot(assetId,f.wallet,f.request);
 expect(waiting.coins.some(c=>c.txid===prepared.txid)).toBe(false);
 await expect(publishCrcAmountListing(review,f.wallet,f.request)).rejects.toThrow(/confirmation/);
 f.confirm();const final=await reviewCrcAmountListing({...args,preferredCoin:prepared.coin},f.wallet,f.request);
 expect(final.offer?.expiresAtHeight).toBe(114n);expect(f.proof).not.toHaveBeenCalled();
 await publishCrcAmountListing(final,f.wallet,f.request);
 expect(f.signer).toHaveBeenCalledTimes(2);expect(f.proof).toHaveBeenCalledOnce();
 expect(f.request.mock.calls.filter(([url])=>url.endsWith('/listing-submit'))).toHaveLength(1);
});
test('incomplete availability, spent input and altered setup output stop before wallet signing',async()=>{
 const incomplete=fixture();incomplete.truncate();await expect(reviewCrcAmountListing(args,incomplete.wallet,incomplete.request)).rejects.toThrow(/incomplete/);
 const spent=fixture();spent.spend();await expect(reviewCrcAmountListing(args,spent.wallet,spent.request)).rejects.toThrow(/confirmed/);
 const changed=fixture();changed.tamper();const review=await reviewCrcAmountListing(args,changed.wallet,changed.request);
 await expect(prepareCrcAmountListing(review,changed.wallet,changed.request)).rejects.toThrow(/reconstructed/);expect(changed.signer).not.toHaveBeenCalled();
});
test('wallet change between offer approvals blocks presigning and activation',async()=>{
 const f=fixture();let current=true;const guard=()=>{if(!current) throw new Error('Wallet changed');};
 const review=await reviewCrcAmountListing({...args,amountAtoms:input.atoms},f.wallet,f.request,guard);
 f.onProof(()=>{current=false;});
 await expect(publishCrcAmountListing(review,f.wallet,f.request,guard)).rejects.toThrow('Wallet changed');expect(f.signer).not.toHaveBeenCalled();
 expect(f.request.mock.calls.some(([url])=>url.endsWith('/listings'))).toBe(false);
});

test('preparation rejection never publishes and offer rejection does not prepare again',async()=>{
 const f=fixture();const review=await reviewCrcAmountListing(args,f.wallet,f.request);
 const rejected=async(url:string,init?:RequestInit)=>url.endsWith('/listing-submit')?new Response(JSON.stringify({ok:false,error:{message:'Provider unavailable'}}),{status:503}):f.request(url,init);
 await expect(prepareCrcAmountListing(review,f.wallet,rejected)).rejects.toThrow('Provider unavailable');
 expect(f.proof).not.toHaveBeenCalled();expect(f.request.mock.calls.some(([url])=>url.endsWith('/listings'))).toBe(false);
 f.confirm();const final=await reviewCrcAmountListing({...args,preferredCoin:{txid:'ee'.repeat(32),vout:1,atoms:args.amountAtoms.toString(),btcSats:'1000',scriptHex:script}},f.wallet,f.request);
 f.onProof(()=>{throw new Error('Wallet cancelled');});
 await expect(publishCrcAmountListing(final,f.wallet,f.request)).rejects.toThrow('Wallet cancelled');
 expect(f.request.mock.calls.filter(([url])=>url.endsWith('/listing-submit'))).toHaveLength(0);
});
test('identity change after setup signature prevents server submission and activation',async()=>{
 const f=fixture();let current=true;const guard=()=>{if(!current)throw new Error('Wallet changed');};
 const review=await reviewCrcAmountListing(args,f.wallet,f.request,guard);
 const original=f.wallet.signPsbt;f.wallet.signPsbt=vi.fn(async(psbt,operation)=>{const signed=await original(psbt,operation);current=false;return signed;});
 await expect(prepareCrcAmountListing(review,f.wallet,f.request,guard)).rejects.toThrow('Wallet changed');
 expect(f.request.mock.calls.some(([url])=>url.endsWith('/listing-submit')||url.endsWith('/listings'))).toBe(false);
});

test('fee estimation failures stop preparation while exact listings need no estimate',async()=>{
 const f=fixture();const request=async(url:string,init?:RequestInit)=>url.endsWith('/fees')?new Response(JSON.stringify({ok:false,error:{message:'Fee estimate unavailable'}}),{status:503}):f.request(url,init);
 await expect(reviewCrcAmountListing(args,f.wallet,request)).rejects.toThrow('Fee estimate unavailable');
 expect(f.signer).not.toHaveBeenCalled();
 await expect(reviewCrcAmountListing({...args,amountAtoms:input.atoms},f.wallet,request)).resolves.toHaveProperty('offer');
});
