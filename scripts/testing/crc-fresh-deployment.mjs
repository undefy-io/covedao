import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function deploymentManifest(appImage, guardianImage) {
  const prefix = `crc-fresh-${randomUUID()}`;
  return {
    prefix, appImage, guardianImage,
    common: {
      COVE_NETWORK: "regtest", NEXT_PUBLIC_COVE_NETWORK: "regtest",
      COVE_DATABASE_URL: `postgres://crc:crc@${prefix}-db:5432/crc_fresh`,
      COVE_BITCOIN_RPC_URL: `http://${prefix}-core:18443`,
      COVE_BITCOIN_RPC_USER: "crc", COVE_BITCOIN_RPC_PASSWORD: "crc",
      COVE_CRC_WORKER_ENABLED: "true", COVE_CRC_TRADING_ACTIVE: "true",
      COVE_CRC_MARKET_TESTING_ENABLED: "true", COVE_CRC_SIGNING_ACTIVE: "true",
      COVE_V3_CANARY_ACTIVE: "false", COVE_RPC_REQUESTS_PER_SECOND: "90",
      COVE_CRC_POLL_MS: "1000", COVE_GUARDIAN_ENDPOINT: `http://${prefix}-guardian:4391`,
      COVE_GUARDIAN_AUTH_TOKEN: prefix, GUARDIAN_AUTH_TOKEN: prefix,
      GUARDIAN_TEST_KEY_HEX: "42".repeat(32),
      SENTRY_DSN: "", NEXT_PUBLIC_SENTRY_DSN: "", COVE_DEV_WALLET: "false",
    },
  };
}
export function verifyRuntimeHashes(expected, actual) {
  for (const path of ["packages/crc20-protocol/index.ts", "packages/crc20-adapters/src/index.ts", "packages/crc20-state/src/index.ts", "packages/crc20-guardian/src/index.ts", "packages/db/src/quotas.ts", "packages/crc20-protocol/wire.ts", "packages/crc20-guardian/src/verified-parents.ts"])
    if (!Object.hasOwn(expected, path)) throw new Error("incomplete CRC runtime manifest");
  for (const [path, digest] of Object.entries(expected))
    if (!/^[0-9a-f]{64}$/.test(digest) || actual[path] !== digest) throw new Error(`CRC runtime mismatch: ${path}`);
  return Object.keys(expected).length;
}
export function assertOwnedResource(manifest, name) {
  if (!/^crc-fresh-[0-9a-f-]{36}$/.test(manifest.prefix) ||
      ![manifest.prefix, ...["core", "db", "guardian", "worker", "web", "baseline"].map((role) => `${manifest.prefix}-${role}`)].includes(name))
    throw new Error("refusing a resource outside this owned deployment");
}
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 });
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, seconds = 60) {
  const deadline = Date.now() + seconds * 1000; let last;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; } catch (error) { last = error; }
    await pause(200);
  }
  throw new Error(`owned deployment readiness timeout: ${last?.message ?? "not ready"}`);
}
export async function deployFreshRegtest({ appImage, guardianImage, output, inventoryFirst = false, browserUi = false, baselineImage }) {
  const manifest = deploymentManifest(appImage, guardianImage);
  const evidence = { network: "regtest", actualExtension: false, manifest: { prefix: manifest.prefix }, checks: [], createdAt: new Date().toISOString() };
  const owned = [], directory = mkdtempSync(join(tmpdir(), "crc-fresh-deploy-"));
  const name = (role) => `${manifest.prefix}-${role}`;
  const run = (role, image, args = [], environment = manifest.common, ports = []) => {
    const resource = name(role); assertOwnedResource(manifest, resource);
    const result = docker("run", "-d", "--name", resource, "--network", manifest.prefix,
      ...ports.flatMap((port) => ["-p", `127.0.0.1::${port}`]),
      ...Object.entries(environment).flatMap(([key, value]) => ["-e", `${key}=${value}`]), image, ...args);
    owned.push(resource); return result.trim();
  };
  const rpc = (method, ...params) => {
    const value = docker("exec", name("core"), "bitcoin-cli", "-regtest", "-rpcuser=crc", "-rpcpassword=crc", "-rpcwait", method,
      ...params.map((p) => typeof p === "string" ? p : JSON.stringify(p))).trim();
    try { return value ? JSON.parse(value) : null; } catch { return value; }
  };
  const sql = (query) => docker("exec", name("db"), "psql", "-U", "crc", "-d", "crc_fresh", "-At", "-c", query).trim();
  const appCommand = (...command) => docker("run", "--rm", "--network", manifest.prefix,
    ...Object.entries(manifest.common).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    "-e", `DATABASE_URL=${manifest.common.COVE_DATABASE_URL}`, appImage, ...command);
  const port = (role, containerPort) => {
    const ports = JSON.parse(docker("inspect", "--format", "{{json .NetworkSettings.Ports}}", name(role)));
    return Number(ports[`${containerPort}/tcp`][0].HostPort);
  };
  try {
    for (const [role, image] of [["app", appImage], ["guardian", guardianImage]])
      evidence[`${role}Image`] = JSON.parse(docker("image", "inspect", image))[0].Id;
    assertOwnedResource(manifest, manifest.prefix); docker("network", "create", manifest.prefix);
    mkdirSync(join(directory, "core"));
    const resource = name("core"); assertOwnedResource(manifest, resource);
    docker("run", "-d", "--name", resource, "--network", manifest.prefix,
      "--user", `${process.getuid()}:${process.getgid()}`, "--entrypoint", "bitcoind",
      "-v", `${join(directory, "core")}:/data`, "bitcoin/bitcoin:30.0", "-regtest", "-datadir=/data", "-server", "-txindex",
      "-rpcbind=0.0.0.0", "-rpcallowip=0.0.0.0/0", "-rpcuser=crc", "-rpcpassword=crc", "-listen=0", "-fallbackfee=0.00001");
    owned.push(resource);
    run("db", "postgres:16-alpine", [], { POSTGRES_DB: "crc_fresh", POSTGRES_USER: "crc", POSTGRES_PASSWORD: "crc" });
    await until(() => sql("select 1") === "1");
    const info = rpc("getblockchaininfo"); if (info.chain !== "regtest") throw new Error("wrong chain");
    rpc("createwallet", "miner"); const miner = rpc("getnewaddress"); rpc("generatetoaddress", 103, miner);
    evidence.chain = rpc("getblockchaininfo");
    appCommand("pnpm", "--filter", "@crclaunch/db", "exec", "drizzle-kit", "migrate");
    const legacy = sql("select count(*) from pg_tables where schemaname='public' and tablename like 'cove_crc_%'");
    if (legacy !== "0") throw new Error("obsolete CRC schema remains");
    if (sql("select count(*) from crc_networks") !== "0") throw new Error("deployment is not fresh");
    evidence.checks.push("committed migrations applied to new DB; old CRC tables absent; namespace empty");
    const bootstrap = `(async()=>{const {createDb}=await import('@crclaunch/db'); const {initializeCrcLedger}=await import('@crclaunch/crc20-state'); const {resolveMainnetProfile}=await import('@crclaunch/cove-mainnet'); const {profile,validation}=resolveMainnetProfile({network:'regtest'}); if(!validation.ok||!profile.feeScript||profile.activationHeight==null) throw new Error('profile'); const db=createDb(process.env.COVE_DATABASE_URL); await initializeCrcLedger(db,{network:'regtest',ticker:'CRC',vaultScriptHex:profile.feeScript,creatorScriptHex:profile.feeScript,protocolScriptHex:profile.feeScript},{activationHeight:Number(profile.activationHeight)}); process.exit(0);})().catch(e=>{console.error(e);process.exit(1)});`;
    appCommand("pnpm", "--filter", "@crclaunch/web", "exec", "tsx", "-e", bootstrap);
    run("guardian", guardianImage, [], manifest.common, [4391]);
    run("worker", appImage, ["pnpm", "--filter", "@crclaunch/worker", "start"]);
    run("web", appImage, [], manifest.common, [3000]);
    let web = `http://127.0.0.1:${await until(() => port("web", 3000))}`, guardian = `http://127.0.0.1:${await until(() => port("guardian", 4391))}`;
    evidence.webUrl = web; evidence.guardianUrl = guardian;
    const json = async (url, headers) => { const response = await fetch(url, { headers, signal: AbortSignal.timeout(3000) }); if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 2000)}`); return response.json(); };
    const guardianReady = () => until(async () => {
      const health = await json(guardian+"/health", { authorization: `Bearer ${manifest.prefix}` });
      return health.reachable && health.auditHealthy && health.signingJournalHealthy && health.custodyBackendReady ? health : false;
    });
    evidence.guardianHealth = await guardianReady();
    evidence.trading = await until(async () => { const response = await json(web+"/api/crc/v1/trading/status"); return response.ok && response.data.tradingActive ? response.data : false; });
    await until(() => { docker("exec", "-w", "/app/apps/worker", name("worker"), "pnpm", "exec", "tsx", "src/crc-health.ts"); return true; });
    await until(() => sql("select height from crc_cursors where network='regtest'") === "103");
    const catalog = await json(web+"/api/crc/v1/tokens");
    if (!catalog.ok || catalog.data.tokens.length !== 0) throw new Error("fresh catalog is not empty");
    evidence.checks.push("actual standalone Guardian health; CRC worker readiness; production web active; empty catalog indexed at Core tip");
    const storedManifest = JSON.parse(docker("exec", name("guardian"), "node", "-e", "process.stdout.write(require('fs').readFileSync('/app/crc-core-source-manifest.json','utf8'))"));
    const runtimeHashes = Object.fromEntries(Object.entries(storedManifest.files).filter(([path]) => (path.startsWith("packages/crc20-") && /\.(ts|mjs)$/.test(path)) || path === "packages/db/src/quotas.ts"));
    const fingerprintCheck = `const fs=require('fs'),crypto=require('crypto'),files=JSON.parse(process.argv[1]),hashes={};for(const path of Object.keys(files)){const file=process.argv[2]==='app'?path.replace('packages/crc20-protocol/','packages/cove-market/crc20-protocol/'):path;hashes[path]=crypto.createHash('sha256').update(fs.readFileSync('/app/'+file)).digest('hex');}console.log(JSON.stringify(hashes));`;
    evidence.alignedRuntimeFiles = verifyRuntimeHashes(runtimeHashes, JSON.parse(docker("exec", name("web"), "node", "-e", fingerprintCheck, JSON.stringify(runtimeHashes), "app")));
    verifyRuntimeHashes(runtimeHashes, JSON.parse(docker("exec", name("guardian"), "node", "-e", fingerprintCheck, JSON.stringify(runtimeHashes), "guardian")));
    const schemaDigest = "const fs=require('fs'),crypto=require('crypto'),s=fs.readFileSync('/app/packages/db/src/schema.ts','utf8');const start=s.indexOf('/** Single-core CRC state.');if(start<0)throw new Error('CRC schema marker missing');console.log(crypto.createHash('sha256').update(s.slice(start)).digest('hex'));";
    evidence.crcSchemaHash = docker("exec", name("web"), "node", "-e", schemaDigest).trim();
    if (docker("exec", name("guardian"), "node", "-e", schemaDigest).trim() !== evidence.crcSchemaHash) throw new Error("CRC schema definitions differ");
    evidence.checks.push("actual app/standalone Guardian CRC runtime source hashes and CRC schema definitions match");
    const root = sql("select state_root from crc_cursors where network='regtest'");
    for (const role of ["web", "worker", "guardian"]) docker("restart", name(role));
    web = `http://127.0.0.1:${await until(() => port("web", 3000))}`;
    guardian = `http://127.0.0.1:${await until(() => port("guardian", 4391))}`;
    evidence.recoveryUrls ??= [];
    evidence.recoveryUrls.push({ web, guardian });
    await guardianReady();
    await until(async () => (await json(web+"/api/crc/v1/trading/status")).data.tradingActive);
    await until(() => { docker("exec", "-w", "/app/apps/worker", name("worker"), "pnpm", "exec", "tsx", "src/crc-health.ts"); return true; });
    if (sql("select state_root from crc_cursors where network='regtest'") !== root) throw new Error("restart changed CRC state");
    evidence.checks.push("coordinated service restart preserves core state root");
    evidence.stateRoot = root;
    for (const role of ["web", "worker", "guardian"]) docker("stop", "-t", "5", name(role));
    const reset = await import("node:fs");
    const statements = reset.readFileSync(resolve("packages/db/drizzle/0041_crc_fresh_reset.sql"), "utf8");
    sql("BEGIN;"+statements.replaceAll("--> statement-breakpoint", "")+"COMMIT;");
    if (sql("select count(*) from crc_networks") !== "0") throw new Error("reset failed");
    appCommand("pnpm", "--filter", "@crclaunch/web", "exec", "tsx", "-e", bootstrap);
    for (const role of ["guardian", "worker", "web"]) docker("start", name(role));
    await until(() => sql("select height from crc_cursors where network='regtest'") === "103");
    web = `http://127.0.0.1:${await until(() => port("web", 3000))}`;
    guardian = `http://127.0.0.1:${await until(() => port("guardian", 4391))}`;
    evidence.recoveryUrls ??= [];
    evidence.recoveryUrls.push({ web, guardian });
    await guardianReady();
    await until(async () => (await json(web+"/api/crc/v1/trading/status")).data.tradingActive);
    if (sql("select state_root from crc_cursors where network='regtest'") !== root) throw new Error("reset/replay changed core state root");
    evidence.checks.push("services stopped; explicit CRC reset; rebootstrap/replay returns exact prior empty core root");
    // Public regtest fixture signing stays in Node; it is not extension evidence.
    const require = createRequire(new URL("../../apps/web/package.json", import.meta.url));
    const bitcoin = require("bitcoinjs-lib"), ecc = require("tiny-secp256k1");
    bitcoin.initEccLib(ecc);
    const key = require("ecpair").ECPairFactory(ecc).fromPrivateKey(Buffer.from("47".repeat(32), "hex"), { network: bitcoin.networks.regtest });
    const payment = bitcoin.payments.p2wpkh({ pubkey: key.publicKey, network: bitcoin.networks.regtest });
    rpc("sendtoaddress", payment.address, 1); rpc("generatetoaddress", 1, miner);
    await until(() => sql("select height from crc_cursors where network='regtest'") === "104");
    const api = async (path, body) => {
      const response = await fetch(web+path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
      const result = await response.json(); if (!response.ok || !result.ok) throw new Error(JSON.stringify(result)); return result.data;
    };
    const funding = async () => {
      const coins = await json(web+"/api/crc/v1/wallet/utxos?address="+encodeURIComponent(payment.address));
      if (!coins.ok) throw new Error(JSON.stringify(coins)); return coins.data.utxos.map(({txid,vout})=>({txid,vout}));
    };
    const common = { walletAddress: payment.address, ordinalsAddress: payment.address, walletPublicKey: key.publicKey.toString("hex"), ordinalsPublicKey: key.publicKey.toString("hex"), feeTier: "standard" };
    const deploy = await api("/api/crc/v1/launch/build", { ...common, ticker: "FRESH", metadata: { displayName: "Fresh deployment", description: "Owned regtest fixture" }, idempotencyKey: randomUUID(), funding: await funding() });
    const transact = async (built, path, height) => {
      const psbt = bitcoin.Psbt.fromBase64(built.psbtBase64);
      psbt.data.inputs.forEach((input, index) => { if (input.witnessUtxo?.script.equals(payment.output)) psbt.signInput(index, key); });
      const receipt = await api(path, { sessionId: built.sessionId, signedPsbtBase64: psbt.toBase64() });
      const raw = rpc("getrawtransaction", receipt.txid);
      const verification = `(async()=>{const core=await import('@crclaunch/crc20-protocol');const {createDb}=await import('@crclaunch/db');const {loadCrcCoreLedger}=await import('@crclaunch/crc20-state');const ledger=await loadCrcCoreLedger(createDb(process.env.COVE_DATABASE_URL),'regtest');const intent=${JSON.stringify(built.intent)};const plan=core.decodeProtocolDto(intent.corePlan),config=core.decodeProtocolDto(intent.coreConfig);const actual=core.validateFinalTransaction(plan,{rawHex:${JSON.stringify(raw)},prevouts:plan.inputs},{...ledger,config});if(actual!==${JSON.stringify(receipt.txid)})throw new Error('validated txid differs');console.log(JSON.stringify({operation:intent.operation,minerFeeSats:core.sats(plan.minerFeeSats).toString()}));process.exit(0);})().catch(e=>{console.error(e);process.exit(1)});`;
      const checked = appCommand("pnpm", "--filter", "@crclaunch/web", "exec", "tsx", "-e", verification);
      rpc("generatetoaddress", 1, miner);
      await until(() => sql("select height from crc_cursors where network='regtest'") === String(height));
      (evidence.fixtureTransactions ??= []).push({ txid: receipt.txid, rawHex: raw, verification: checked.trim().split("\n").at(-1), sessionId: built.sessionId, intent: built.intent });
      return receipt.txid;
    };
    const deployTxid = await transact(deploy, "/api/crc/v1/launch/submit", 105);
    const buy = await api("/api/crc/v1/backing/buy/build", { ...common, assetId: "regtest:"+deployTxid, amountAtoms: inventoryFirst ? "40000000000" : "50000000000", paymentFunding: await funding(), idempotencyKey: randomUUID() });
    await transact(buy, "/api/crc/v1/backing/buy/submit", 106);
    if (sql("select count(*) from crc_signatures") !== "1") throw new Error("actual standalone Guardian signature journal missing");
    evidence.deployedCatalog = await json(web+"/api/crc/v1/tokens");
    if (evidence.deployedCatalog.data.tokens.length !== 1 || evidence.deployedCatalog.data.tokens[0].mintedAtoms !== (inventoryFirst ? "40000000000" : "50000000000")) throw new Error("fresh deployment replay differs");
    evidence.finalStateRoot = sql("select state_root from crc_cursors where network='regtest'");
    evidence.checks.push("fresh Node-fixture launch and purchase mine through actual standalone Guardian; authoritative raw fees/outputs and worker catalog match");

    if (inventoryFirst) {
      const assetId = "regtest:"+deployTxid;
      const tokens = await json(web+"/api/crc/v1/tokens/"+encodeURIComponent(assetId)+"/utxos?address="+encodeURIComponent(payment.address));
      if (!tokens.ok) throw new Error(JSON.stringify(tokens));
      const sell = await api("/api/crc/v1/backing/sell/build", { ...common, assetId, amountAtoms:"40000000000", sellerFunding:tokens.data.utxos.map(({txid,vout})=>({txid,vout})), paymentFunding:await funding(), idempotencyKey:randomUUID() });
      await transact(sell,"/api/crc/v1/backing/sell/submit",107);
      const quote = await api("/api/crc/v1/backing/buy/quote",{assetId,amountAtoms:"100000000000"});
      for (const [field,value] of Object.entries({amountAtoms:"100000000000",inventoryBuyAtoms:"40000000000",newlyMintedAtoms:"60000000000",grossSats:"27",protocolFeeSats:"5013",creatorFeeSats:"546",operation:"mint"}))
        if (quote.quote[field] !== value) throw new Error("mixed quote differs: "+field);
      const mixed = await api("/api/crc/v1/backing/buy/build",{...common,assetId,amountAtoms:"100000000000",paymentFunding:await funding(),idempotencyKey:randomUUID()});
      if (mixed.intent.operation !== "mint-buy" || mixed.intent.inventoryBuyAtoms !== "40000000000" || mixed.intent.newlyMintedAtoms !== "60000000000") throw new Error("mixed session differs");
      const mixedTxid = await transact(mixed,"/api/crc/v1/backing/buy/submit",108);
      const activity = await json(web+"/api/crc/v1/tokens/"+encodeURIComponent(assetId)+"/activity");
      const event = activity.data.rows.find(row=>row.txid===mixedTxid);
      if (event?.amountAtoms !== "100000000000" || event?.inventoryBuyAtoms !== "40000000000" || event?.newlyMintedAtoms !== "60000000000") throw new Error("mixed indexed receipt differs");
      const repeat = await api("/api/crc/v1/backing/buy/build",{...common,assetId,amountAtoms:"10000000000",paymentFunding:await funding(),idempotencyKey:randomUUID()});
      await transact(repeat,"/api/crc/v1/backing/buy/submit",109);
      const detail = await json(web+"/api/crc/v1/tokens/"+encodeURIComponent(assetId));
      if (detail.data.token.mintedAtoms !== "110000000000" || detail.data.token.inventoryAtoms !== "0") throw new Error("follow-on supply differs");
      const finalRoot = sql("select state_root from crc_cursors where network='regtest'");
      for (const role of ["web","worker","guardian"]) docker("restart",name(role));
      web = `http://127.0.0.1:${await until(() => port("web", 3000))}`;
      guardian = `http://127.0.0.1:${await until(() => port("guardian", 4391))}`;
      evidence.recoveryUrls.push({ web, guardian });
      await guardianReady();
      await until(async() => (await json(web+"/api/crc/v1/trading/status")).data.tradingActive);
      if (sql("select state_root from crc_cursors where network='regtest'") !== finalRoot) throw new Error("mixed history restart changed root");
      evidence.finalStateRoot = finalRoot;
      evidence.inventoryFirst = { quote:quote.quote, receipt:event, finalToken:detail.data.token, actualExtension:false };
      evidence.checks.push("actual production images: buy400/sell400/buy1000 delivers1000, reuses400, issues600 with one fee set; repeat100 and coordinated restart preserve mixed history");
    }
    if (browserUi) {
      if (!baselineImage) throw new Error("browser UI parity requires an explicit previous regtest image");
      run("baseline", baselineImage, [], manifest.common, [3000]);
      const baseline = `http://127.0.0.1:${await until(() => port("baseline", 3000))}`;
      await until(async () => (await json(baseline+"/api/crc/v1/trading/status")).ok);
      evidence.baselineImage = JSON.parse(docker("image", "inspect", baselineImage))[0].Id;
      const result = execFileSync("pnpm", ["--filter", "@crclaunch/web", "exec", "playwright", "test", "-c", "playwright.crc-core.config.ts"], { encoding: "utf8", env: { ...process.env, CRC_CORE_UI_URL: web, CRC_CORE_BASELINE_URL: baseline }, timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
      evidence.browserUi = { output: result, actualExtension: false };
      evidence.checks.push("desktop/mobile production bundle UI regressions pass on the owned regtest deployment");
    }
    evidence.status = "passed";
  } catch (error) {
    evidence.status = "failed"; evidence.error = String(error);
    if (browserUi && error.stdout) evidence.browserUiFailure = String(error.stdout);
    throw error;
  } finally {
    evidence.logs = {};
    for (const resource of owned) {
      assertOwnedResource(manifest, resource);
      try { evidence.logs[resource] = docker("logs", "--tail", "60", resource); } catch { /* Startup may fail before logs exist. */ }
      try { docker("rm", "-f", "-v", resource); } catch (error) { (evidence.cleanupErrors ??= []).push(String(error)); }
      try { docker("inspect", resource); (evidence.cleanupErrors ??= []).push(`owned container remains: ${resource}`); } catch { /* Absence is expected. */ }
    }
    try { docker("network", "rm", manifest.prefix); } catch (error) { (evidence.cleanupErrors ??= []).push(String(error)); }
    try { docker("network", "inspect", manifest.prefix); (evidence.cleanupErrors ??= []).push("owned network remains"); } catch { /* Absence is expected. */ }
    if (!evidence.cleanupErrors?.length) rmSync(directory, { recursive: true, force: true });
    else evidence.status = "failed";
    evidence.finishedAt = new Date().toISOString();
    if (output) writeFileSync(output, JSON.stringify(evidence, null, 2)+"\n");
    console.log(JSON.stringify({ status: evidence.status, checks: evidence.checks, output, appImage: evidence.appImage, guardianImage: evidence.guardianImage }));
  }
  if (evidence.status !== "passed") throw new Error(`deployment cleanup failed: ${evidence.cleanupErrors}`);
  return evidence;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await deployFreshRegtest({ appImage: "covedao-crc-cleanup-regtest:ag3-11", guardianImage: "covedao-crc-guardian-regtest:ag3-11", output: process.env.CRC_DEPLOYMENT_EVIDENCE_PATH ?? "/tmp/crc-fresh-deployment-evidence.json" });
