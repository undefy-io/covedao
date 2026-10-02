import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";

const pairs = ECPairFactory(ecc);
export const aliceKey = pairs.fromPrivateKey(Buffer.alloc(32, 0x61), {
  network: bitcoin.networks.regtest,
});
export const bobKey = pairs.fromPrivateKey(Buffer.alloc(32, 0x62), {
  network: bitcoin.networks.regtest,
});
const payment = (key: typeof aliceKey) =>
  bitcoin.payments.p2wpkh({ pubkey: key.publicKey, network: bitcoin.networks.regtest });
export const aliceScript = payment(aliceKey).output!.toString("hex");
export const bobScript = payment(bobKey).output!.toString("hex");
export const aliceAddress = payment(aliceKey).address!;
export const bobAddress = payment(bobKey).address!;
export const protocolScript = bitcoin.payments
  .p2wpkh({ hash: Buffer.alloc(20, 0x63) })
  .output!.toString("hex");

export class Core {
  name = `crc-isolated-${randomUUID()}`;
  datadir = new URL(`../.regtest/${this.name}/`, import.meta.url).pathname;
  calls: string[] = [];
  start() {
    mkdirSync(this.datadir, { recursive: true });
    execFileSync(
      "docker",
      [
        "run",
        "-d",
        "--name",
        this.name,
        "--network",
        "none",
        "--user",
        `${process.getuid!()}:${process.getgid!()}`,
        "--entrypoint",
        "bitcoind",
        "-v",
        `${this.datadir}:/data`,
        "bitcoin/bitcoin:30.0",
        "-regtest",
        "-datadir=/data",
        "-server",
        "-txindex",
        "-fallbackfee=0.00001",
        "-rpcuser=isolated",
        "-rpcpassword=isolated",
        "-listen=0",
        "-persistmempool=0",
        "-walletbroadcast=0",
      ],
      { encoding: "utf8" },
    );
    this.rpc("getblockchaininfo");
    for (const [wallet, key] of [
      ["alice", aliceKey],
      ["bob", bobKey],
    ] as const) {
      this.rpc("createwallet", [wallet, false, false, "", false, true]);
      const descriptor = this.rpc("getdescriptorinfo", [`wpkh(${key.toWIF()})`]).descriptor;
      // getdescriptorinfo returns the public descriptor; retain the private key.
      const checksum = this.rpc("getdescriptorinfo", [`wpkh(${key.toWIF()})`]).checksum;
      this.rpc(
        "importdescriptors",
        [[{ desc: `wpkh(${key.toWIF()})#${checksum}`, timestamp: "now", active: false }]],
        wallet,
      );
      if (!descriptor) throw new Error("descriptor prerequisite");
    }
    this.mine(101);
    const fundingId = this.rpc("sendtoaddress", [bobAddress, 10], "alice");
    this.broadcast(this.rpc("gettransaction", [fundingId], "alice").hex);
    this.mine(1);
  }
  rpc(method: string, args: unknown[] = [], wallet?: string): any {
    this.calls.push(method);
    const result = execFileSync(
      "docker",
      [
        "exec",
        this.name,
        "bitcoin-cli",
        "-regtest",
        "-datadir=/data",
        "-rpcuser=isolated",
        "-rpcpassword=isolated",
        "-rpcwait",
        "-rpcwaittimeout=15",
        ...(wallet ? [`-rpcwallet=${wallet}`] : []),
        method,
        ...args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))),
      ],
      { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    try {
      return JSON.parse(result);
    } catch {
      return result;
    }
  }
  mine(count = 1) {
    return this.rpc("generatetoaddress", [count, aliceAddress]);
  }
  funding(wallet: "alice" | "bob", excluded: Set<string> = new Set()) {
    const rows = this.rpc("listunspent", [1, 9999999], wallet);
    const row = rows.find((r: any) => r.amount > 0.01 && !excluded.has(`${r.txid}:${r.vout}`));
    if (!row) throw new Error(`no ordinary ${wallet} funding`);
    return {
      txid: row.txid,
      vout: row.vout,
      sats: BigInt(Math.round(row.amount * 1e8)),
      scriptHex: row.scriptPubKey,
    };
  }
  sign(plan: any, wallets: ("alice" | "bob")[] = ["alice"]) {
    const tx = new bitcoin.Transaction();
    tx.version = 2;
    for (const input of plan.inputs)
      tx.addInput(Buffer.from(input.txid, "hex").reverse(), input.vout, 0xfffffffe);
    for (const output of plan.outputs)
      tx.addOutput(Buffer.from(output.scriptHex, "hex"), Number(output.sats));
    plan.inputWitnesses?.forEach((w: string[], i: number) =>
      tx.setWitness(
        i,
        w.map((h) => Buffer.from(h, "hex")),
      ),
    );
    let hex = tx.toHex();
    let signed: any;
    for (const wallet of wallets) {
      signed = this.rpc("signrawtransactionwithwallet", [hex], wallet);
      hex = signed.hex;
    }
    if (!signed.complete)
      throw new Error(`wallets could not sign: ${JSON.stringify(signed.errors)}`);
    return hex;
  }
  accepted(hex: string) {
    return this.rpc("testmempoolaccept", [[hex]])[0];
  }
  broadcast(hex: string) {
    return this.rpc("sendrawtransaction", [hex]);
  }
  transaction(txid: string) {
    const data = this.rpc("getrawtransaction", [txid, true]);
    const prevouts = data.vin.map((input: any) => {
      const parent = this.rpc("getrawtransaction", [input.txid, true]);
      const out = parent.vout[input.vout];
      return {
        txid: input.txid,
        vout: input.vout,
        sats: BigInt(Math.round(out.value * 1e8)),
        scriptHex: out.scriptPubKey.hex,
      };
    });
    return { rawHex: data.hex, prevouts };
  }
  block(hash: string) {
    const block = this.rpc("getblock", [hash, 1]);
    return {
      hash,
      parentHash: block.previousblockhash ?? "",
      height: block.height,
      transactions: block.tx.slice(1).map((id: string) => this.transaction(id)),
    };
  }
  clearOrphanMempool() {
    this.rpc("stop");
    execFileSync("docker", ["wait", this.name], { stdio: "pipe" });
    execFileSync("docker", ["start", this.name], { stdio: "pipe" });
    this.rpc("getblockchaininfo");
    for (const wallet of ["alice", "bob"]) this.rpc("loadwallet", [wallet]);
    if (this.rpc("getrawmempool").length) throw new Error("orphan mempool was not cleared");
  }
  stop() {
    try {
      execFileSync("docker", ["rm", "-f", this.name], { stdio: "pipe" });
    } finally {
      rmSync(this.datadir, { recursive: true, force: true });
    }
  }
}
