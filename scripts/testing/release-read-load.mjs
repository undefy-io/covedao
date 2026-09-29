import { createRequire } from "node:module";
import { createServer } from "node:http";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
const { Client } = require("pg");
const databaseUrl = process.env.RELEASE_TEST_DATABASE_URL;
const address = databaseUrl && new URL(databaseUrl);
if (
  address?.hostname !== "127.0.0.1" ||
  address.port !== "5435" ||
  address.pathname !== "/release_load"
) {
  throw new Error("Use only the isolated localhost:5435/release_load database");
}
const db = new Client({ connectionString: databaseUrl });
await db.connect();
const mode = process.argv[2];
const token = (
  await db.query(
    "select token_id from cove_v3_tokens where network='regtest' and ticker='RACE' limit 1",
  )
).rows[0]?.token_id;
if (!token)
  throw new Error("First copy the successful competing.regtest.test.ts fixture into release_load");
async function fresh() {
  await db.query(`update cove_v3_runtime r set core_reachable=true, core_height=c.height, core_tip=c.block_hash,
    chain_observed_at=clock_timestamp(), pending_observed_at=clock_timestamp(), fees_observed_at=clock_timestamp(),
    fee_rates='{"slow":1,"normal":2,"fast":3}'::jsonb from cove_v3_cursor c where r.network=c.network and r.network='regtest';
    update cove_pending_backing p set observed_at=clock_timestamp() where network='regtest' and payload is not null`);
}
if (mode === "seed") {
  await db.query(
    `insert into cove_v3_tokens (network,token_id,ticker,policy_version,nonce,deploy_txid,deploy_height,deploy_block_hash,creator_script)
    select 'regtest',md5('load-token-'||n)||md5('load-token-extra-'||n),'LOAD'||n,policy_version,nonce,deploy_txid,deploy_height,deploy_block_hash,creator_script
    from cove_v3_tokens cross join generate_series(1,100) n where token_id=$1 on conflict do nothing`,
    [token],
  );
  await db.query(
    `insert into cove_v3_market_trades (network,token_id,listing_id,fill_id,seller_token_script,buyer_token_script,
    amount_atoms,total_price_sats,market_fee_sats,miner_fee_sats,txid,block_height,block_hash,created_at)
    select 'regtest',case when n<=20000 then $1 else md5('load-token-'||(1+n%100))||md5('load-token-extra-'||(1+n%100)) end,
      md5('listing-'||n),md5('fill-'||n),'51','51',100000000000000,100000,500,1000,
      md5('load-trade-'||n)||md5('load-trade-extra-'||n),c.height,c.block_hash,clock_timestamp()-(n||' seconds')::interval
    from cove_v3_cursor c cross join generate_series(1,100000) n where c.network='regtest' on conflict do nothing`,
    [token],
  );
  await db.query(
    `insert into cove_v3_token_utxos (network,txid,vout,token_id,amount_atoms,script_pub_key,created_height,created_block_hash)
    select 'regtest',md5('load-holder-'||n)||md5('load-holder-extra-'||n),0,$1,100000000,
      '0014'||md5('holder-script-'||n)||substr(md5('holder-extra-'||n),1,8),c.height,c.block_hash
    from cove_v3_cursor c cross join generate_series(1,10000) n where c.network='regtest' on conflict do nothing`,
    [token],
  );
  await db.query(`update cove_pending_backing p set observed_revision=p.requested_revision,chain_generation=e.chain_generation,
    base_txid=b.txid,base_vout=b.vout,payload=jsonb_build_object('tokenId',b.token_id,'stateVersion',b.state_version,'policyVersion',b.policy_version,
      'issuedSupplyAtoms',b.issued_supply_atoms::text,'backingSats',b.backing_sats::text,'curveStage',b.curve_stage,'stateHash',b.state_hash,
      'txid',b.txid,'vout',b.vout,'script',b.script_pub_key,'valueSats',b.btc_value::text)
    from cove_v3_backing_states b join cove_observation_epochs e on e.network=b.network
    where p.network=b.network and p.token_id=b.token_id and b.canonical and p.network='regtest'`);
  await fresh();
  await db.query("analyze");
  console.log(JSON.stringify({ tokens: 101, trades: 100000, holders: 10000, token }));
} else if (mode === "serve") {
  let attempts = 0;
  let paused = false;
  const server = createServer(async (req, res) => {
    if (req.url === "/pause") paused = true;
    if (req.url === "/resume") paused = false;
    if (req.method === "POST") {
      attempts++;
      res.writeHead(503, { "content-type": "application/json" });
      res.end('{"error":"PUBLIC_RPC_FORBIDDEN"}');
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ attempts }));
    }
  });
  server.listen(18553, "127.0.0.1");
  await once(server, "listening");
  const timer = setInterval(
    () =>
      (paused ? Promise.resolve() : fresh()).catch((e) => {
        console.error(e.message);
        process.exitCode = 1;
      }),
    1000,
  );
  console.log("Isolated fixture clocks and RPC attempt recorder ready");
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => {
      clearInterval(timer);
      server.close();
      db.end();
    });
} else if (mode === "run") {
  const base = process.env.RELEASE_TEST_WEB_URL || "http://127.0.0.1:3003";
  if (!/^http:\/\/127\.0\.0\.1:300[34]$/.test(base))
    throw new Error("Only isolated web ports 3003/3004 are allowed");
  const cases = [
    ["/api/v3/status"],
    ["/api/v3/tokens"],
    [`/api/v3/tokens/${token}`],
    [`/api/v3/tokens/${token}/market`],
    [`/api/v3/tokens/${token}/holders`],
    [`/api/v3/tokens/${token}/candles?timeframe=1h`],
    ["/api/v3/tx/" + "aa".repeat(32)],
    ["/api/v3/backing/buy/quote", { tokenId: token, amountAtoms: "100000000000000" }],
    ["/api/v3/backing/buy/quote-sats", { tokenId: token, budgetSats: "100000" }],
    ["/api/v3/backing/redeem/quote", { tokenId: token, amountAtoms: "100000000000000" }],
  ];
  for (const [path, body] of cases) {
    const options = body
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {};
    const warm = await fetch(base + path, options);
    if (!warm.ok) throw new Error(`Warmup ${path}: ${warm.status} ${await warm.text()}`);
    await warm.arrayBuffer();
    const times = [],
      statuses = {};
    await Promise.all(
      Array.from({ length: 50 }, async () => {
        for (let i = 0; i < 10; i++) {
          const start = performance.now();
          const response = await fetch(base + path, options);
          await response.arrayBuffer();
          times.push(performance.now() - start);
          statuses[response.status] = (statuses[response.status] || 0) + 1;
        }
      }),
    );
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)],
      p99 = times[Math.floor(times.length * 0.99)];
    console.log(
      JSON.stringify({
        path,
        concurrency: 50,
        requests: times.length,
        statuses,
        p95Ms: +p95.toFixed(3),
        p99Ms: +p99.toFixed(3),
      }),
    );
    if (statuses[200] !== 500 || p95 > 250 || p99 > 500) process.exitCode = 1;
  }
  const rpc = await fetch("http://127.0.0.1:18553").then((r) => r.json());
  console.log(JSON.stringify({ publicRpcAttempts: rpc.attempts }));
  if (rpc.attempts !== 0) process.exitCode = 1;
} else if (mode === "faults") {
  const base = "http://127.0.0.1:3003";
  await fetch("http://127.0.0.1:18553/pause");
  const saved = (
    await db.query("select * from cove_pending_backing where network='regtest' and token_id=$1", [
      token,
    ])
  ).rows[0];
  const quote = async () =>
    fetch(base + "/api/v3/backing/buy/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tokenId: token, amountAtoms: "100000000000000" }),
    });
  try {
    for (const [name, update] of [
      ["expired pending observation", "observed_at=clock_timestamp()-interval '20 seconds'"],
      ["obsolete chain generation", "chain_generation=chain_generation-1"],
      ["missing positive proof", "payload=null"],
      ["invalidated pending revision", "observed_revision=null"],
    ]) {
      await db.query(
        "update cove_pending_backing set " + update + " where network='regtest' and token_id=$1",
        [token],
      );
      const response = await quote();
      const result = await response.json();
      if (response.status !== 503 || result.error?.retryable !== true)
        throw new Error(name + ": " + JSON.stringify(result));
      console.log(JSON.stringify({ fault: name, status: response.status, retryable: true }));
      await db.query(
        "update cove_pending_backing set observed_at=clock_timestamp(),chain_generation=$2,observed_revision=$3,payload=$4 where network='regtest' and token_id=$1",
        [token, saved.chain_generation, saved.observed_revision, saved.payload],
      );
    }
    await db.query(
      "update cove_v3_runtime set chain_observed_at=clock_timestamp()-interval '40 seconds' where network='regtest'",
    );
    const response = await quote();
    if (response.status !== 503) throw new Error("Stale Core observation remained usable");
    console.log(JSON.stringify({ fault: "expired chain observation", status: 503 }));
    await fresh();
    const recovered = await quote();
    if (!recovered.ok) throw new Error("Fresh observations did not restore quotes");
    console.log(
      JSON.stringify({
        recovered: recovered.status,
        publicRpcAttempts: (await fetch("http://127.0.0.1:18553").then((r) => r.json())).attempts,
      }),
    );
  } finally {
    await fresh();
    await fetch("http://127.0.0.1:18553/resume");
  }
} else throw new Error("Choose seed, serve, or run");
if (mode !== "serve") await db.end();
