import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";
import { createDb, saveWalletFundingSnapshot } from "@crclaunch/db";
import { dev1RecoveryProfile } from "@crclaunch/cove-vault";
import { buildCrc20AssetVault } from "@crclaunch/cove-vault";
import { createCurveState } from "@crclaunch/crc20-curve";
import { buildCurveBuyV3, buildUnsignedPsbt } from "@crclaunch/crc20-transactions";
import { buildCrcLaunchSession } from "./crc-build";
import { createCrcBuildSession } from "./crc-session";
import { submitCrcSession } from "./crc-submit";

const url = process.env.CRC_READ_TEST_DATABASE_URL;
const isolated = !!url && (() => { const u = new URL(url); return u.hostname === "127.0.0.1" && u.port === "5435" && u.pathname === "/crc_test"; })();
const db = isolated ? createDb(url!) : undefined;
const key = `crc-submit-${randomUUID()}`;
const walletKey = ECPairFactory(ecc).fromPrivateKey(Buffer.from("11".repeat(32), "hex"));
const walletScript = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(walletKey.publicKey), network: bitcoin.networks.regtest }).output!.toString("hex");
const fundingTxid = "e".repeat(64);

describe.skipIf(!isolated)("CRC submission boundary", () => {
  afterAll(async () => {
    await db!.execute(sql`delete from cove_crc_token_metadata where network = 'regtest' and display_name = 'Signed Frog Coin'`);
    await db!.execute(sql`delete from cove_crc_build_sessions where network = 'regtest' and idempotency_key like ${key + "%"}`);
    await db!.execute(sql`delete from cove_wallet_funding where network = 'regtest' and wallet_script = ${walletScript}`);
    await db!.execute(sql`delete from cove_crc_launch_intents where network = 'regtest' and ticker = 'SUBMITTEST'`);
  });

  it("rejects unsigned wallet PSBT before Guardian or Core access", async () => {
    const psbt = new bitcoin.Psbt({ network: bitcoin.networks.regtest });
    psbt.addInput({ hash: "a".repeat(64), index: 0,
      witnessUtxo: { script: Buffer.from("0014" + "1".repeat(40), "hex"), value: 10000 },
      sighashType: bitcoin.Transaction.SIGHASH_ALL });
    psbt.addOutput({ script: Buffer.from("0014" + "2".repeat(40), "hex"), value: 9000 });
    const digest = (await import("@crclaunch/cove-app")).unsignedTxDigest(psbt);
    const session = await createCrcBuildSession(db!, {
      network: "regtest", operation: "deploy", deploymentTxid: null,
      idempotencyKey: key, requestHash: "f".repeat(64), unsignedTxDigest: digest,
      psbtBase64: psbt.toBase64(), walletScriptHex: "0014" + "1".repeat(40),
      tokenScriptHex: "0014" + "1".repeat(40), trustedJson: {},
    });
    const provider = { getTxout: async () => { throw new Error("Core must not be called"); } };
    await expect(submitCrcSession({ db: db!, network: "regtest", sessionId: session.id,
      signedPsbtBase64: psbt.toBase64(), provider: provider as never,
      guardianEndpoint: "http://127.0.0.1:1", guardianAuthToken: "test",
    })).rejects.toThrow(/signature/i);
  });

  it("verifies signed launch funding live, persists authorization before broadcasting, and replays idempotently", async () => {
    await saveWalletFundingSnapshot(db!, "regtest", walletScript, [{ txid: fundingTxid, vout: 0, valueSats: "20000", confirmations: 1 }]);
    const built = await buildCrcLaunchSession({
      db: db!, network: "regtest", bitcoinNetwork: bitcoin.networks.regtest,
      ticker: "SUBMITTEST", walletScriptHex: walletScript, tokenScriptHex: walletScript,
      metadata: { displayName: "Signed Frog Coin", description: "A signed deploy", websiteUrl: "https://example.com", xUrl: null, imageUrl: null },
      walletPublicKeyHex: Buffer.from(walletKey.publicKey).toString("hex"),
      funding: [{ txid: fundingTxid, vout: 0 }], minerFeeSats: 1000,
      idempotencyKey: key + "-live", feeScriptHex: "0014" + "9".repeat(40),
      guardianXOnly: Buffer.from("eec7245d6b7d2ccb30380bfbe2a3648cd7a942653f5aa340edcea1f283686619", "hex"),
      recoveryProfile: dev1RecoveryProfile(Buffer.from("24653eac434488002cc06bbfb7f10fe18991e35f9fe4302dbea6d2353dc0ab1c", "hex")),
    });
    const signed = bitcoin.Psbt.fromBase64(built.psbtBase64, { network: bitcoin.networks.regtest });
    signed.signAllInputs(walletKey);
    let broadcasts = 0;
    const provider = {
      getTxout: async () => ({ scriptPubKeyHex: walletScript, valueSats: 20000n, confirmations: 1 }),
      getBlockchainInfo: async () => ({ chain: "regtest" }),
      testMempoolAccept: async () => ({ allowed: true }),
      broadcastTransaction: async (raw: string) => {
        broadcasts++;
        const txid = bitcoin.Transaction.fromHex(raw).getId();
        const rows = await db!.execute(sql`select txid from cove_crc_launch_intents where network = 'regtest' and txid = ${txid}`);
        expect(rows.rows).toHaveLength(1);
        const metadata = await db!.execute(sql`select display_name, submitted_by_script from cove_crc_token_metadata where network = 'regtest' and deploy_txid = ${txid}`);
        expect(metadata.rows).toMatchObject([{ display_name: "Signed Frog Coin", submitted_by_script: walletScript }]);
        return txid;
      },
    };
    const input = { db: db!, network: "regtest" as const, sessionId: built.sessionId,
      signedPsbtBase64: signed.toBase64(), provider: provider as never,
      guardianEndpoint: "http://127.0.0.1:1", guardianAuthToken: "test" };
    const first = await submitCrcSession(input);
    expect(first.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(broadcasts).toBe(1);
    expect(await submitCrcSession(input)).toEqual(first);
    expect(broadcasts).toBe(1);
  });

  it("submits a wallet-and-Guardian-signed buy with a finalized vault witness", async () => {
    const guardianKey = ECPairFactory(ecc).fromPrivateKey(Buffer.alloc(32, 0x41));
    const recoveryKey = ECPairFactory(ecc).fromPrivateKey(Buffer.alloc(32, 0x43));
    const vault = buildCrc20AssetVault({
      asset: { deploymentTag: Buffer.alloc(32, 0x44), launchSalt: Buffer.alloc(32, 0x45) },
      guardianXOnly: guardianKey.publicKey.subarray(1),
      recoveryProfile: dev1RecoveryProfile(recoveryKey.publicKey.subarray(1)),
    });
    const vaultInput = {
      txid: "a".repeat(64), vout: 1, valueSats: 330,
      scriptHex: vault.scriptPubKey.toString("hex"), tokenAtoms: 0n,
    };
    const template = buildCurveBuyV3({
      ticker: "SUBMITTEST", deploymentTxid: "9".repeat(64),
      state: createCurveState(`${"aa".repeat(32)}:1`, 330n), amountTokens: 1_000n,
      scripts: { buyer: walletScript, seller: walletScript, vault: vaultInput.scriptHex,
        protocol: "5120" + "3".repeat(64), creator: "5120" + "4".repeat(64) },
      recipientSats: 330, vaultInput,
    });
    const unsigned = buildUnsignedPsbt(template, [vaultInput, {
      txid: "b".repeat(64), vout: 0, valueSats: template.requiredFundingSats + 1_000,
      scriptHex: walletScript, tokenAtoms: 0n,
    }], 1_000, bitcoin.networks.regtest);
    const walletSigned = bitcoin.Psbt.fromBase64(unsigned.toBase64(), { network: bitcoin.networks.regtest });
    walletSigned.signInput(1, walletKey);
    const guardianSigned = bitcoin.Psbt.fromBase64(walletSigned.toBase64(), { network: bitcoin.networks.regtest });
    guardianSigned.updateInput(0, {
      tapInternalKey: vault.numsKey, tapMerkleRoot: vault.merkleRoot,
      tapLeafScript: [{ leafVersion: 0xc0, script: vault.executionLeaf.script,
        controlBlock: vault.executionControlBlock }],
    });
    guardianSigned.signTaprootInput(0, guardianKey, vault.executionLeaf.tapleafHash, [bitcoin.Transaction.SIGHASH_ALL]);
    const signature = guardianSigned.data.inputs[0]!.tapScriptSig![0]!.signature;
    const leaf = vault.executionLeaf.script;
    const items = [signature, leaf.subarray(1, 33), leaf, vault.executionControlBlock];
    guardianSigned.updateInput(0, {
      finalScriptWitness: Buffer.concat([Buffer.from([4]), ...items.flatMap((item) => [Buffer.from([item.length]), item])]),
    });
    const session = await createCrcBuildSession(db!, {
      network: "regtest", operation: "mint-buy", deploymentTxid: "9".repeat(64),
      idempotencyKey: key + "-buy", requestHash: "f".repeat(64),
      unsignedTxDigest: (await import("@crclaunch/cove-app")).unsignedTxDigest(unsigned),
      psbtBase64: unsigned.toBase64(), walletScriptHex: walletScript, tokenScriptHex: walletScript,
      trustedJson: {},
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      ok: true, signedPsbtBase64: guardianSigned.toBase64(), unsignedTxDigest: session.unsignedTxDigest,
    }), { status: 200 }));
    let broadcasts = 0;
    try {
      const submitted = await submitCrcSession({
        db: db!, network: "regtest", sessionId: session.id, expectedOperation: "buy",
        signedPsbtBase64: walletSigned.toBase64(), guardianEndpoint: "http://guardian.test",
        guardianAuthToken: "test", provider: {
          getBlockchainInfo: async () => ({ chain: "regtest" }),
          testMempoolAccept: async () => ({ allowed: true }),
          broadcastTransaction: async (raw: string) => { broadcasts++; return bitcoin.Transaction.fromHex(raw).getId(); },
        } as never,
      });
      expect(submitted.status).toBe("BROADCAST");
      expect(broadcasts).toBe(1);
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      fetchMock.mockRestore();
    }
  });
});
