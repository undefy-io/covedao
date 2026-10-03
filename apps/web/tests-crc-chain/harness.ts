/** Owned real-chain HTTP harness. The wallet is simulated; chain/DB/API/indexer/Guardian are real. */
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, createWriteStream, mkdirSync, symlinkSync, cpSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { expect, type Page } from "@playwright/test";
import { build as bundle } from "esbuild";
import type { CrcBrowserBuild, CrcBrowserReview } from "../src/lib/crc-browser-session";
import * as core from "@crclaunch/crc20-protocol";
import { CoreRpcProvider } from "@crclaunch/bitcoin";
import { initializeCrcLedger, loadCrcCoreLedger, loadCrcRegistrations, crcCoreStateRoot } from "@crclaunch/crc20-state";
import { collectFeeObservation, saveFeeObservation } from "@crclaunch/cove-app";
import { resolveMainnetProfile } from "@crclaunch/cove-mainnet";
import { syncCrcTip } from "@crclaunch/cove-indexer/crc20";
import { CrcGuardianSigningService } from "@crclaunch/crc20-guardian";
import { TestGuardianCustodyBackend } from "../../../packages/cove-guardian/src/v3/custody.js";
import { isolatedDatabase } from "../../../packages/cove-indexer/src/crc20/test-support/database.js";
import { Core, protocolScript } from "../../../packages/cove-market/crc20-protocol/test-support/core.js";
import { signNativeInput } from "../../../packages/cove-market/crc20-protocol/test-support/signing.js";
bitcoin.initEccLib(ecc);
const pairs = ECPairFactory(ecc), params = bitcoin.networks.regtest;
function actor(byte: number, dual: boolean) {
  const key = pairs.fromPrivateKey(Buffer.alloc(32, byte));
  const native = bitcoin.payments.p2wpkh({ pubkey: key.publicKey, network: params });
  const payment = dual ? bitcoin.payments.p2sh({ redeem: native, network: params }) : native;
  const ordinal = dual ? bitcoin.payments.p2tr({ internalPubkey: key.publicKey.subarray(1), network: params }) : native;
  return { key, address: payment.address!, script: payment.output!.toString("hex"), ordinalsAddress: ordinal.address!,
    ordinalsScript: ordinal.output!.toString("hex"), publicKey: key.publicKey.toString("hex"), network: "regtest" };
}
export const alice = actor(0x47, false), bob = actor(0x48, true);
export type Actor = typeof alice;
class CountingCustody extends TestGuardianCustodyBackend {
  signatures = 0;
  override async signTaprootScriptPath(params: { sighash: Buffer; leafTapleafHash: Buffer }) {
    this.signatures++; return super.signTaprootScriptPath(params);
  }
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function closeServer(server?: Server) {
  if (server) { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
}
export class CrcChainHarness {
  node = new Core(); database!: Awaited<ReturnType<typeof isolatedDatabase>>;
  private rpcServer?: Server; private guardianServer?: Server; private next?: ChildProcess;
  private env!: NodeJS.ProcessEnv; private log?: ReturnType<typeof createWriteStream>;
  private config?: core.Config;
  private project = "";
  private closed = false;
  private built = false;
  private client = "";
  private sourceHashes: Record<string, string> = {};
  readonly directory = mkdtempSync(join(tmpdir(), "crc-chain-browser-"));
  url = ""; activationHeight = 0; provider!: CoreRpcProvider; ledger: core.Ledger | null = null;
  backend = new CountingCustody(Buffer.alloc(32, 0x42));
  onWalletResponse?: (operation: string, owner: Actor) => Promise<void>;
  prompts: { operation: string; psbt?: string; signed?: string; message?: string; account: string }[] = [];
  evidence: unknown[] = [];
  async start() {
    try {
      this.database = await isolatedDatabase(); this.node.start();
      for (const owner of [alice, bob]) {
        const id = this.node.rpc("sendtoaddress", [owner.address, 5], "alice");
        this.node.broadcast(this.node.rpc("gettransaction", [id], "alice").hex);
      }
      this.node.mine(); this.activationHeight = this.node.rpc("getblockcount") + 1;
      this.rpcServer = createServer(async (req, res) => {
        if (req.headers.authorization !== "Basic " + Buffer.from("isolated:isolated").toString("base64")) { res.writeHead(401); res.end(); return; }
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString());
        try {
          const value = this.node.rpc(body.method, body.params);
          // bitcoin-cli prints no stdout for a JSON null (not an empty string).
          const result = value === "" ? null : value;
          res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ result, error: null, id: body.id }));
        }
        catch (error) {
          const detail = String((error as { stderr?: unknown }).stderr ?? error);
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ result: null, id: body.id, error: { code: Number(detail.match(/error code:\s*(-?\d+)/)?.[1] ?? -1), message: detail.split("error message:").at(-1)!.trim() } }));
        }
      });
      const rpcUrl = await listen(this.rpcServer);
      this.provider = new CoreRpcProvider({ url: rpcUrl, user: "isolated", password: "isolated" });
      const profilePath = join(this.directory, "profile.toml");
      writeFileSync(profilePath, readFileSync(resolve("../../packages/cove-mainnet/profiles.toml"), "utf8")
        .replace(/guardianXOnly = "[^"]+"/, `guardianXOnly = "${(await this.backend.xOnlyPubkey()).toString("hex")}"`)
        .replace(/feeScript = "[^"]+"/, `feeScript = "${protocolScript}"`)
        .replace(/activationHeight = \d+/, `activationHeight = ${this.activationHeight}`));
      const profile = resolveMainnetProfile({ network: "regtest", testOnlyPath: profilePath });
      expect(profile.validation.ok, JSON.stringify(profile.validation)).toBe(true);
      const service = new CrcGuardianSigningService({ db: this.database.db, core: this.provider, custodyBackend: this.backend,
        guardianXOnly: await this.backend.xOnlyPubkey(), recoveryProfile: { profileVersion: "COVE_V3_VAULT_PROFILE_MAINNET1",
          recoveryCsvBlocks: profile.profile.recovery.csvBlocks!, recoveryThreshold: profile.profile.recovery.threshold,
          recoveryPubkeys: profile.profile.recovery.pubkeys.map((key) => Buffer.from(key, "hex")) }, network: "regtest",
        protocolScript: Buffer.from(protocolScript, "hex"), maxMinerFeeSats: core.maxMinerFeeSats });
      this.guardianServer = createServer(async (req, res) => {
        if (req.url !== "/sign/crc20" || req.headers.authorization !== "Bearer owned-crc-browser") { res.writeHead(401); res.end(); return; }
        try {
          const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const result = await service.sign(JSON.parse(Buffer.concat(chunks).toString()));
          res.writeHead(result.ok ? 200 : 400, { "content-type": "application/json" }); res.end(JSON.stringify(result));
        } catch (error) { res.writeHead(500); res.end(JSON.stringify({ ok: false, detail: String(error) })); }
      });
      const guardianUrl = await listen(this.guardianServer);
      const options = this.database.pool.options;
      const dbUrl = `postgres://crc_test:crc_test@127.0.0.1:${options.port}/crc_core_test`;
      await this.observeFees();
      const reservation = createServer(); const reserved = await listen(reservation); await closeServer(reservation);
      this.url = reserved;
      this.env = { ...process.env, COVE_NETWORK: "regtest", COVE_CRC_TRADING_ACTIVE: "true",
        COVE_CRC_MARKET_TESTING_ENABLED: "true", COVE_DATABASE_URL: dbUrl, DATABASE_URL: dbUrl,
        COVE_BITCOIN_RPC_URL: rpcUrl, COVE_BITCOIN_RPC_USER: "isolated", COVE_BITCOIN_RPC_PASSWORD: "isolated", COVE_BITCOIN_RPC_API_KEY: "",
        COVE_GUARDIAN_ENDPOINT: guardianUrl, COVE_GUARDIAN_AUTH_TOKEN: "owned-crc-browser", COVE_TEST_ONLY_PROFILE_PATH: profilePath,
        COVE_FEE_ADDRESS: "", COVE_RPC_REQUESTS_PER_SECOND: "90", COVE_TRUSTED_CLIENT_IP_HEADER: "x-real-ip",
        COVE_V3_CANARY_ACTIVE: "false", SENTRY_DSN: "", NEXT_PUBLIC_SENTRY_DSN: "", SENTRY_AUTH_TOKEN: "" };
      this.project = join(this.directory, "web"); mkdirSync(this.project);
      cpSync(resolve("src"), join(this.project, "src"), { recursive: true });
      const verifyCopy = (relative: string) => {
        for (const entry of readdirSync(resolve(relative), { withFileTypes: true })) {
          const path = join(relative, entry.name);
          if (entry.isDirectory()) verifyCopy(path);
          else {
            const canonical = readFileSync(resolve(path));
            expect(readFileSync(join(this.project, path)).equals(canonical), `production source copy: ${path}`).toBe(true);
            this.sourceHashes[path] = createHash("sha256").update(canonical).digest("hex");
          }
        }
      };
      verifyCopy("src");
      for (const name of ["postcss.config.mjs", "tailwind.config.ts"]) cpSync(resolve(name), join(this.project, name));
      for (const name of ["public", "node_modules", "package.json"]) symlinkSync(resolve(name), join(this.project, name));
      const tsconfig = JSON.parse(readFileSync(resolve("tsconfig.json"), "utf8"));
      tsconfig.extends = resolve("../../tsconfig.base.json");
      writeFileSync(join(this.project, "tsconfig.json"), JSON.stringify(tsconfig));
      writeFileSync(join(this.project, "next.config.mjs"), `import config from ${JSON.stringify(resolve("next.config.mjs"))}; export default config;\n`);
      await this.startWeb();
    } catch (error) { await this.close(); throw error; }
  }
  async startWeb() {
    this.log = createWriteStream(join(this.directory, "next.log"), { flags: "a" });
    if (!this.built) {
      this.next = spawn(process.execPath, [resolve("node_modules/next/dist/bin/next"), "build", this.project], { env: this.env, stdio: ["ignore", "pipe", "pipe"] });
      this.next.stdout!.pipe(this.log, { end: false }); this.next.stderr!.pipe(this.log, { end: false });
      const exit = await new Promise<number | null>((done) => this.next!.once("exit", done));
      if (exit !== 0) throw new Error(`Owned production build failed: ${readFileSync(join(this.directory, "next.log"), "utf8")}`);
      this.built = true;
    }
    this.next = spawn(process.execPath, [resolve("node_modules/next/dist/bin/next"), "start", this.project, "--hostname", "127.0.0.1", "--port", new URL(this.url).port], { env: this.env, stdio: ["ignore", "pipe", "pipe"] });
    this.next.stdout!.pipe(this.log); this.next.stderr!.pipe(this.log);
    const deadline = Date.now() + 90_000; let failure = "";
    while (Date.now() < deadline) {
      if (this.next.exitCode !== null) throw new Error(`Owned Next exited: ${readFileSync(join(this.directory, "next.log"), "utf8")}`);
      try { const response = await fetch(this.url + "/api/crc/v1/trading/status"); const body = await response.json(); if (response.ok && body.ok) return; failure = JSON.stringify(body); } catch (error) { failure = String(error); }
      await new Promise((done) => setTimeout(done, 200));
    }
    throw new Error(`Owned Next not ready: ${failure}`);
  }
  async initialize(config: core.Config) {
    this.config = config; await initializeCrcLedger(this.database.db, config, { activationHeight: this.activationHeight });
  }
  async observeFees() {
    const observed = await collectFeeObservation(this.provider, "regtest");
    await saveFeeObservation(this.database.db, "regtest", observed.rates, observed.observedAt);
  }
  async json(path: string, body?: unknown) {
    const response = await fetch(this.url + path, { headers: { "content-type": "application/json", "x-real-ip": "127.0.0.4" },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
    const result = await response.json(); expect(result.ok, JSON.stringify(result)).toBe(true); return result.data;
  }
  async reviewInBrowser(page: Page, built: CrcBrowserBuild, review: CrcBrowserReview, owner: Actor) {
    if (!this.client) {
      const result = await bundle({ entryPoints: [resolve("tests-crc-chain/client.ts")], bundle: true, platform: "browser", format: "iife", write: false,
        alias: { "@": resolve("src") }, conditions: ["browser"], inject: [resolve("../../packages/crc20-adapters/browser-buffer.mjs")],
        define: { "process.env.NEXT_PUBLIC_COVE_NETWORK": '"regtest"', "process.env.NODE_ENV": '"test"' } });
      this.client = result.outputFiles[0]!.text;
    }
    await page.addScriptTag({ content: this.client });
    return page.evaluate(async ({ built, review, wallet }) => {
      const target = window as unknown as { __crcChainReview: (built: CrcBrowserBuild, review: CrcBrowserReview, wallet: { network: string; address: string; publicKey: string; ordinalsAddress: string; ordinalsPublicKey: string }) => Promise<string> };
      return target.__crcChainReview(built, review, wallet);
    }, { built, review, wallet: { network: "regtest", address: owner.address, publicKey: owner.publicKey, ordinalsAddress: owner.ordinalsAddress, ordinalsPublicKey: owner.publicKey } });
  }
  async sync() {
    if (!this.config) throw new Error("Initialize the owned ledger from its independently reviewed deployment config first");
    this.ledger = (await syncCrcTip({ db: this.database.db, provider: this.provider, network: "regtest", activationHeight: this.activationHeight,
      protocolScriptHex: protocolScript })).snapshot.state!;
    await this.observeFees();
    return this.ledger;
  }
  async mineAndVerify(txid: string, built: { intent: Record<string, unknown> }) {
    const plan = core.decodeProtocolDto<core.Plan>(built.intent.corePlan);
    const actual = this.node.transaction(txid);
    const before = await loadCrcCoreLedger(this.database.db, "regtest");
    core.validateFinalTransaction(plan, actual, { ...before!, config: core.decodeProtocolDto<core.Config>(built.intent.coreConfig) });
    const registrations = await loadCrcRegistrations(this.database.db, "regtest");
    if (built.intent.operation === "deploy") expect(registrations[txid]).toBeDefined();
    const rows = (await this.database.pool.query("select status,operation,trusted_json from crc_sessions where txid=$1", [txid])).rows;
    expect(rows).toHaveLength(1); expect(rows[0]!.status).toBe("BROADCAST");
    const [blockHash] = this.node.mine();
    const block = this.node.block(blockHash);
    // Match the canonical observation shape independently, including coinbase
    // and real raw parents, because the core fingerprints those exact bytes.
    const observed = this.node.rpc("getblock", [blockHash, 1]);
    block.transactions = observed.tx.map((id: string, index: number) => {
      if (index === 0) return { rawHex: this.node.rpc("getrawtransaction", [id]), prevouts: [] };
      const transaction = this.node.transaction(id);
      const parentRawTransactions: Record<string, string> = {};
      for (const input of transaction.prevouts) parentRawTransactions[input.txid] = this.node.rpc("getrawtransaction", [input.txid]);
      return { ...transaction, parentRawTransactions };
    });
    const expected = core.applyConfirmedBlockDetailed(before!, block, { registeredDeployments: registrations });
    expect(expected.events.some((event) => event.txid === txid)).toBe(true);
    const after = await this.sync();
    expect(crcCoreStateRoot(after)).toBe(crcCoreStateRoot(expected.ledger));
    expect(crcCoreStateRoot((await loadCrcCoreLedger(this.database.db, "regtest"))!)).toBe(crcCoreStateRoot(after));
    expect(this.node.rpc("getrawtransaction", [txid, true]).confirmations).toBeGreaterThan(0);
    this.evidence.push({ txid, actual: core.encodeProtocolDto(actual), plan: core.encodeProtocolDto(plan), session: rows[0], state: core.encodeProtocolDto(core.snapshotLedger(after)), expectedCoreStateRoot: crcCoreStateRoot(expected.ledger), stateRoot: crcCoreStateRoot(after) });
  }
  async wallet(page: Page, owner: Actor, beforeResponse?: () => Promise<void>) {
    page.on("pageerror", (error) => process.stdout.write(`Owned browser error: ${error.stack}\n`));
    page.on("console", (message) => { if (message.type() === "error") process.stdout.write(`Owned browser console: ${message.text()}\n`); });
    await page.context().setExtraHTTPHeaders({ "x-real-ip": owner === alice ? "127.0.0.2" : "127.0.0.3" });
    await page.exposeFunction("__crcChainSign", async (base64: string, operation: string) => {
      const psbt = bitcoin.Psbt.fromBase64(base64);
      const held = psbt.data.inputs.map((input) => input.finalScriptWitness?.toString("hex"));
      const indexes: number[] = [];
      psbt.data.inputs.forEach((input, index) => {
        if (input.finalScriptWitness || input.finalScriptSig) return;
        const script = input.witnessUtxo?.script.toString("hex");
        if (script !== owner.script && script !== owner.ordinalsScript) return;
        indexes.push(index); const flag = operation === "P2P_LIST" ? 131 : 1;
        expect(input.sighashType).toBe(flag);
        const schnorrKey = owner.key.publicKey[0] === 3 ? pairs.fromPrivateKey(Buffer.from(ecc.privateNegate(owner.key.privateKey!))) : owner.key;
        const signingKey = script!.startsWith("5120") ? schnorrKey.tweak(bitcoin.crypto.taggedHash("TapTweak", owner.key.publicKey.subarray(1))) : owner.key;
        psbt.signInput(index, signingKey, [flag]);
      });
      expect(indexes.length).toBeGreaterThan(0);
      held.forEach((witness, index) => { if (witness) expect(psbt.data.inputs[index]!.finalScriptWitness!.toString("hex")).toBe(witness); });
      const signed = psbt.toBase64(); this.prompts.push({ operation, psbt: base64, signed, account: owner.address });
      await beforeResponse?.(); await this.onWalletResponse?.(operation, owner); return signed;
    });
    await page.exposeFunction("__crcChainMessage", (message: string) => {
      const virtual = core.bip322SigningTransaction(owner.ordinalsScript, message);
      let witness: string[];
      if (owner.ordinalsScript.startsWith("0014")) witness = signNativeInput(virtual.tx, virtual.prevouts, 0, owner.key.privateKey!, 1);
      else {
        const normalized = owner.key.publicKey[0] === 3 ? ecc.privateNegate(owner.key.privateKey!) : owner.key.privateKey!;
        const tweaked = ecc.privateAdd(normalized, core.taggedHash("TapTweak", owner.key.publicKey.subarray(1)))!;
        witness = [Buffer.from(ecc.signSchnorr(core.taprootSignatureHash(virtual.tx, virtual.prevouts, 0, 0), tweaked)).toString("hex")];
      }
      this.prompts.push({ operation: "BIP322", message, account: owner.ordinalsAddress });
      return Buffer.from(core.encodeMessageWitness(witness), "hex").toString("base64");
    });
    const metadata = { address: owner.address, script: owner.script, ordinalsAddress: owner.ordinalsAddress, ordinalsScript: owner.ordinalsScript, publicKey: owner.publicKey };
    await page.addInitScript({ content: `window.__crcChainAccount=${JSON.stringify(metadata)};${readFileSync(new URL("./wallet-init.js", import.meta.url), "utf8")}` });
  }
  async stopWeb() {
    if (this.next && this.next.exitCode === null) { this.next.kill("SIGTERM"); await new Promise<void>((done) => { const timer = setTimeout(() => { this.next!.kill("SIGKILL"); done(); }, 5000); this.next!.once("exit", () => { clearTimeout(timer); done(); }); }); }
    this.log?.end();
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.stopWeb(); await closeServer(this.guardianServer); await closeServer(this.rpcServer);
    if (process.env.CRC_CORE_CHAIN_EVIDENCE_PATH) writeFileSync(process.env.CRC_CORE_CHAIN_EVIDENCE_PATH, JSON.stringify({ network: "regtest", simulatedWallet: true, productionSourceHashes: this.sourceHashes, walletPrompts: this.prompts, custodySignatures: this.backend.signatures, transactions: this.evidence }, null, 2) + "\n");
    if (this.database) { await this.database.close(); this.database = undefined!; }
    this.node.stop();
  }
}
