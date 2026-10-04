import {createServer} from "node:http";
import {build} from "esbuild";
import {chromium} from "@playwright/test";
import {test, expect} from "vitest";
import * as bitcoin from "bitcoinjs-lib";

test("desktop/mobile saves before relay, survives reload, retries without wallet/backend, and isolates accounts", async()=>{
  const psbt=new bitcoin.Psbt();psbt.addInput({hash:'11'.repeat(32),index:0,witnessUtxo:{script:Buffer.from('0014'+'12'.repeat(20),'hex'),value:2000}});psbt.addOutput({script:Buffer.from('0014'+'12'.repeat(20),'hex'),value:1000});
  const final=bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer());final.ins[0]!.witness=[Buffer.from('01','hex')];
  const receipt={network:'signet',status:'READY',rawTxHex:final.toHex(),txid:final.getId()};
  const bundle=await build({stdin:{resolveDir:new URL('.',import.meta.url).pathname,contents:`
    import {submitCrcFromBrowser,pendingCrcBroadcasts,retryCrcBroadcast} from './crc-client-broadcast';
    const built={sessionId:'test-session',psbtBase64:${JSON.stringify(psbt.toBase64())}};
    window.signCount=0;
    window.submit=()=>submitCrcFromBrowser(built,{network:'signet',address:'alice'},'/api/crc/v1/backing/buy/submit',async()=>{window.signCount++;return 'signed-wallet-psbt';});
    window.saved=()=>pendingCrcBroadcasts('signet','alice');
    window.other=()=>pendingCrcBroadcasts('signet','bob');
    window.retry=()=>Promise.all([retryCrcBroadcast(window.saved()[0]),retryCrcBroadcast(window.saved()[0])]);
  `},bundle:true,write:false,platform:'browser',format:'esm',target:'es2022',inject:[new URL('../../../../packages/crc20-adapters/browser-buffer.mjs',import.meta.url).pathname],define:{'process.env.NEXT_PUBLIC_COVE_NETWORK':'"signet"','process.env.NEXT_PUBLIC_COVE_BITCOIN_RPC_URL':'"https://rpc.example"','process.env.NEXT_PUBLIC_COVE_ESPLORA_URL':'"https://index.example"'}});
  const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/bundle.js'?'text/javascript':'text/html');res.end(req.url==='/bundle.js'?bundle.outputFiles[0]!.text:'<script type="module" src="/bundle.js"></script>');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve)); const browser=await chromium.launch();
  try {for(const [viewport,failure] of [[{width:1280,height:800},"relay"],[{width:390,height:844},"relay"],[{width:1280,height:800},"prepare"]] as const){
    const page=await browser.newPage({viewport});let accept=false, prepares=0, sends=0; const calls:string[]=[];
    await page.route(/rpc\.example|index\.example|\/api\/crc\//,async route=>{
      const req=route.request(),body=req.postDataJSON(); let result:unknown;
      if(req.url().includes('/api/')) {prepares++;if(failure==='prepare'&&!accept){await route.abort();return;}expect(body.broadcast).toBe('client');expect(body.signedPsbtBase64).toBe('signed-wallet-psbt');result={ok:true,data:receipt};}
      else if(req.url().includes('index.example')) {await route.fulfill({body:'ab'.repeat(32),headers:{'access-control-allow-origin':'*'}});return;}
      else {
        calls.push(body.method);
        if(body.method==='sendrawtransaction') {sends++;expect(body.params).toEqual([receipt.rawTxHex]);expect(await page.evaluate('window.saved()[0].receipt.txid')).toBe(receipt.txid);result=accept?{result:receipt.txid,error:null}:{result:null,error:{code:-26,message:'provider unavailable'}};}
        else if(body.method==='getrawtransaction') result={result:null,error:{code:-5,message:'not found'}};
        else result={result:body.method==='getblockchaininfo'?{chain:'signet',blocks:100}:'00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6',error:null};
      }
      await route.fulfill({status:200,json:result,headers:{'access-control-allow-origin':'*'}});
    });
    await page.goto(`http://127.0.0.1:${(server.address() as {port:number}).port}`);await page.waitForFunction('typeof window.submit === "function"');
    const initialError=await page.evaluate('window.submit().catch(e=>e.message)');
    expect(initialError).toContain(failure==='prepare'?'fetch':'provider unavailable');
    expect(await page.evaluate('window.signCount')).toBe(1);expect(await page.evaluate('window.saved().length')).toBe(1);expect(await page.evaluate('window.other().length')).toBe(0);
    await page.reload();await page.waitForFunction('typeof window.retry === "function"');accept=true;
    expect(await page.evaluate('window.retry()')).toEqual([{txid:receipt.txid},{txid:receipt.txid}]);
    expect(await page.evaluate('window.signCount')).toBe(0);expect(await page.evaluate('window.saved().length')).toBe(0);
    expect(prepares).toBe(failure==='prepare'?2:1);expect(sends).toBe(failure==='prepare'?1:2);expect(calls.includes('testmempoolaccept')).toBe(false);
    await page.close();
  }} finally {await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
},30000);
