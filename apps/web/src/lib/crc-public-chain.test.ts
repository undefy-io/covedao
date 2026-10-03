import { expect, test, vi } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import { CrcPublicChain, PublicChainInvalid, PublicChainUnavailable } from "./crc-public-chain";
const script = `0014${"12".repeat(20)}`, genesis = "ab".repeat(32);
const tx = new bitcoin.Transaction(); tx.addInput(Buffer.alloc(32, 1), 0); tx.addOutput(Buffer.from(script, "hex"), 12345);
const input = { txid: tx.getId(), vout: 0, sats: 12345n, scriptHex: script };
function fixture(overrides: Record<string, unknown> = {}) {
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("block-height")) return new Response(String(overrides.genesis ?? genesis));
    if (url.includes("/utxo")) return Response.json([{ txid: tx.getId(), vout: 0, value: 12345, status: { confirmed: true, block_height: 10 } }]);
    const body = JSON.parse(String(init!.body));
    const results: Record<string, unknown> = { getblockchaininfo: { chain: "signet", blocks: 12 }, getblockhash: genesis,
      getrawtransaction: tx.toHex(), gettxout: { confirmations: 3, value: 0.00012345, scriptPubKey: { hex: script } }, ...overrides };
    return Response.json({ result: results[body.method], error: null });
  });
  return { request, client: new CrcPublicChain("signet", "https://rpc.example", "https://index.example", request) };
}
test("coalesces address/identity/raw reads and observes reviewed inputs directly without proxy calls", async () => {
  const { request, client } = fixture();
  await Promise.all(Array.from({ length: 20 }, () => client.coins("wallet")));
  expect(request).toHaveBeenCalledTimes(4);
  const proofs = await Promise.all([client.evidence([input]), client.evidence([input])]);
  expect(proofs[0]).toEqual({ version: 1, network: "signet", parents: [{ txid: tx.getId(), rawHex: tx.toHex() }] });
  expect(request).toHaveBeenCalledTimes(5);
  expect(await client.observe([input])).toEqual([{ ...input, confirmations: 3 }]);
  expect(request).toHaveBeenCalledTimes(6);
  const observed = request.mock.calls.map(([, init]) => init?.body && JSON.parse(String(init.body))).filter(Boolean);
  expect(observed.at(-1).params).toEqual([input.txid, 0, true]);
});
test("wrong RPC/index networks, forged raw content and spent/unconfirmed outputs fail closed", async () => {
  for (const overrides of [
    { getblockchaininfo: { chain: "test", blocks: 12 } }, { genesis: "cd".repeat(32) },
    { getrawtransaction: "00" }, { gettxout: null },
    { gettxout: { confirmations: 0, value: 0.00012345, scriptPubKey: { hex: script } } },
    { gettxout: { confirmations: 3, value: 0.000123455, scriptPubKey: { hex: script } } },
  ]) await expect(fixture(overrides).client.observe([input])).rejects.toThrow();
  await expect(fixture({ gettxout: null }).client.observe([input])).rejects.toBeInstanceOf(PublicChainInvalid);
});
test("aborting one joined reader leaves another reader's observation intact", async () => {
  const { client } = fixture(), controller = new AbortController();
  const aborted = client.coins("wallet", controller.signal);
  const other = client.coins("wallet"); controller.abort(new Error("canceled"));
  await expect(aborted).rejects.toThrow("canceled");
  await expect(other).resolves.toHaveLength(1);
});

test("honors long seconds/date Retry-After without retrying earlier than the provider permits", async () => {
  for (const header of ["60", new Date(Date.now() + 60000).toUTCString()]) {
    const request = vi.fn(async () => new Response("quota", { status: 429, headers: { "retry-after": header } }));
    const client = new CrcPublicChain("signet", "https://rpc.example", "https://index.example", request);
    await expect(client.coins("wallet")).rejects.toBeInstanceOf(PublicChainUnavailable);
    expect(request).toHaveBeenCalledOnce();
  }
});
test("queued requests share a deadline and expired waiters never fetch", async () => {
  const f = fixture(); let active = 0, maximum = 0, parentRequests = 0;
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.body && JSON.parse(String(init.body)).method === "getrawtransaction") {
      parentRequests++; maximum = Math.max(maximum, ++active);
      return new Promise<Response>((_resolve, reject) => {
        const aborted = () => { active--; reject(new Error("timeout")); };
        init.signal!.addEventListener("abort", aborted, { once: true });
        if (init.signal!.aborted) aborted();
      });
    }
    return f.request(url, init);
  });
  const client = new CrcPublicChain("signet", "https://rpc.example", "https://index.example", request, 30);
  const candidates = Array.from({ length: 8 }, (_, n) => ({ txid: n.toString(16).padStart(64, "0"), vout: 0 }));
  await expect(client.evidence(candidates)).rejects.toBeInstanceOf(PublicChainUnavailable);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(maximum).toBe(4); expect(parentRequests).toBe(4);
  await expect(client.coins("wallet")).resolves.toHaveLength(1);
});

test("a fast outage cannot hide delayed forged or spent evidence behind fallback", async () => {
  const f = fixture();
  const other = { ...input, txid: "cd".repeat(32) };
  const request = async (url: string, init?: RequestInit) => {
    const call = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (call?.method === "getrawtransaction" && call.params[0] === other.txid) {
      await new Promise(resolve => setTimeout(resolve, 10));
      return Response.json({ result: tx.toHex(), error: null });
    }
    if (call?.method === "getrawtransaction" && call.params[0] === input.txid) throw new Error("offline");
    return f.request(url, init);
  };
  const client = new CrcPublicChain("signet", "https://rpc.example", "https://index.example", request);
  await expect(client.evidence([input, other])).rejects.toBeInstanceOf(PublicChainInvalid);
  await expect(client.observe([input, other])).rejects.toBeInstanceOf(PublicChainInvalid);
});

test("broadcasts exact bytes once for joined callers and verifies the returned txid", async () => {
  const {client, request} = fixture({sendrawtransaction:tx.getId()});
  expect(await Promise.all([client.broadcast(tx.toHex(),tx.getId()),client.broadcast(tx.toHex(),tx.getId())])).toEqual([tx.getId(),tx.getId()]);
  const calls=request.mock.calls.filter(([,init])=>init?.body).map(([,init])=>JSON.parse(String(init!.body)));
  expect(calls.filter(c=>c.method==='sendrawtransaction')).toEqual([{jsonrpc:'1.0',id:'sendrawtransaction',method:'sendrawtransaction',params:[tx.toHex()]}]);
  expect(calls.some(c=>c.method==='testmempoolaccept')).toBe(false);
  await expect(client.broadcast(tx.toHex(),'cd'.repeat(32))).rejects.toThrow('identity');
});
test("recognizes Core HTTP 500 already-known responses and recovers ambiguous acceptance by exact raw hash", async () => {
  for(const code of [-27,-26]) {
    const f=fixture();const request=vi.fn(async(url:string,init?:RequestInit)=>{
      if(init?.body&&JSON.parse(String(init.body)).method==='sendrawtransaction') return Response.json({result:null,error:{code,message:'relay result'}},{status:500});
      return f.request(url,init);
    });
    const client=new CrcPublicChain('signet','https://rpc.example','https://index.example',request);
    expect(await client.broadcast(tx.toHex(),tx.getId())).toBe(tx.getId());
    expect(request.mock.calls.filter(([,init])=>init?.body&&JSON.parse(String(init.body)).method==='getrawtransaction')).toHaveLength(code===-27?0:1);
  }
});
test("wrong network and mismatching relay/observation identities never acknowledge a broadcast", async()=>{
  const wrong=fixture({getblockchaininfo:{chain:'test',blocks:12}});
  await expect(wrong.client.broadcast(tx.toHex(),tx.getId())).rejects.toThrow('network');
  expect(wrong.request.mock.calls.some(([,init])=>init?.body&&JSON.parse(String(init.body)).method==='sendrawtransaction')).toBe(false);
  await expect(fixture({sendrawtransaction:'cd'.repeat(32)}).client.broadcast(tx.toHex(),tx.getId())).rejects.toThrow('identity');
  const f=fixture({getrawtransaction:'00'});
  const client=new CrcPublicChain('signet','https://rpc.example','https://index.example',async(url,init)=>{
    if(init?.body&&JSON.parse(String(init.body)).method==='sendrawtransaction') throw new Error('lost response');
    return f.request(url,init);
  });
  await expect(client.broadcast(tx.toHex(),tx.getId())).rejects.toThrow();
});
