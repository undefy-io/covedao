import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import * as bitcoin from "bitcoinjs-lib";
import { createDb, saveWalletFundingSnapshot } from "@crclaunch/db";
import { dev1RecoveryProfile } from "@crclaunch/cove-vault";
import { estimateVsize } from "@crclaunch/bitcoin";
import { buildCrcLaunchSession } from "./crc-build";

const url = process.env.CRC_READ_TEST_DATABASE_URL;
const isolated = !!url && (() => { const u = new URL(url); return u.hostname === "127.0.0.1" && u.port === "5435" && u.pathname === "/crc_test"; })();
const db = isolated ? createDb(url!) : undefined;
const idempotencyKey = `crc-build-test-${randomUUID()}`;
const walletScriptHex = "0014" + "5".repeat(40);
const txid = "b".repeat(64);
const dustTxid = "c".repeat(64);

describe.skipIf(!isolated)("CRC launch build from observed wallet funding", () => {
  afterAll(async () => {
    await db!.execute(sql`delete from cove_crc_build_sessions where network = 'regtest' and idempotency_key like ${idempotencyKey + "%"}`);
    await db!.execute(sql`delete from cove_wallet_funding where network = 'regtest' and wallet_script = ${walletScriptHex}`);
  });

  it("builds a canonical deploy PSBT and persists one immutable session", async () => {
    await saveWalletFundingSnapshot(db!, "regtest", walletScriptHex, [
      { txid: dustTxid, vout: 0, valueSats: "546", confirmations: 1 },
      { txid, vout: 0, valueSats: "10000", confirmations: 1 },
    ]);
    const params = {
      db: db!, network: "regtest" as const, ticker: "TEST", walletScriptHex,
      tokenScriptHex: walletScriptHex, walletPublicKeyHex: undefined,
      funding: [{ txid: dustTxid, vout: 0 }, { txid, vout: 0 }], minerFeeSats: 1000,
      idempotencyKey,
      feeScriptHex: "0014" + "2".repeat(40),
      guardianXOnly: Buffer.from("eec7245d6b7d2ccb30380bfbe2a3648cd7a942653f5aa340edcea1f283686619", "hex"),
      recoveryProfile: dev1RecoveryProfile(Buffer.from("24653eac434488002cc06bbfb7f10fe18991e35f9fe4302dbea6d2353dc0ab1c", "hex")),
      bitcoinNetwork: bitcoin.networks.regtest,
    };
    const built = await buildCrcLaunchSession(params);
    const psbt = bitcoin.Psbt.fromBase64(built.psbtBase64, { network: bitcoin.networks.regtest });
    expect(psbt.inputCount).toBe(1);
    expect(psbt.txOutputs.map((output) => output.value)).toEqual([0, 330, 1000, 7000, 670]);
    expect(psbt.txOutputs[0]!.script.toString("utf8")).toContain('"p":"crc-20","op":"deploy"');
    expect(built.intent.vaultScriptHex).toMatch(/^5120[0-9a-f]{64}$/);
    expect((await buildCrcLaunchSession(params)).sessionId).toBe(built.sessionId);
    await expect(buildCrcLaunchSession({ ...params, metadata: { displayName: "Different name", description: "" } }))
      .rejects.toThrow(/idempotency conflict/);
    const rated = await buildCrcLaunchSession({ ...params, minerFeeSats: undefined,
      feeRateSatPerVb: 2, feeTier: "standard", idempotencyKey: `${idempotencyKey}-rated` });
    const ratedPsbt = bitcoin.Psbt.fromBase64(rated.psbtBase64, { network: bitcoin.networks.regtest });
    const vsize = estimateVsize({ vaultInputs: 0, p2wpkhInputs: ratedPsbt.inputCount,
      outputScriptBytes: ratedPsbt.txOutputs.map((output) => output.script.length) });
    expect(rated.intent.minerFeeSats).toBeGreaterThanOrEqual(2 * vsize);
    expect(rated.intent.feeRateSatPerVb).toBe(2);
    expect(rated.intent.feeTier).toBe("standard");
    await expect(buildCrcLaunchSession({ ...params, minerFeeSats: undefined,
      feeRateSatPerVb: 500, feeTier: "priority", idempotencyKey: `${idempotencyKey}-expensive` }))
      .rejects.toMatchObject({ code: "MINER_FEE_TOO_HIGH" });
    await saveWalletFundingSnapshot(db!, "regtest", walletScriptHex, [
      { txid: dustTxid, vout: 0, valueSats: "6000", confirmations: 1 },
      { txid, vout: 0, valueSats: "6000", confirmations: 1 },
    ]);
    const multi = await buildCrcLaunchSession({ ...params, minerFeeSats: undefined,
      feeRateSatPerVb: 2, feeTier: "eco", idempotencyKey: `${idempotencyKey}-multi` });
    const multiPsbt = bitcoin.Psbt.fromBase64(multi.psbtBase64, { network: bitcoin.networks.regtest });
    expect(multiPsbt.inputCount).toBe(2);
    expect(multi.intent.minerFeeSats).toBeGreaterThanOrEqual(2 * estimateVsize({ vaultInputs: 0,
      p2wpkhInputs: multiPsbt.inputCount,
      outputScriptBytes: multiPsbt.txOutputs.map((output) => output.script.length),
    }));
    await saveWalletFundingSnapshot(db!, "regtest", walletScriptHex, [
      { txid, vout: 0, valueSats: "9800", confirmations: 1 },
    ]);
    const narrow = await buildCrcLaunchSession({ ...params, funding: [{ txid, vout: 0 }], minerFeeSats: undefined,
      feeRateSatPerVb: 4, feeTier: "standard", idempotencyKey: `${idempotencyKey}-narrow` });
    const narrowPsbt = bitcoin.Psbt.fromBase64(narrow.psbtBase64, { network: bitcoin.networks.regtest });
    expect(narrowPsbt.txOutputs).toHaveLength(4);
    expect(narrow.intent.minerFeeSats).toBeGreaterThanOrEqual(4 * estimateVsize({ vaultInputs: 0,
      p2wpkhInputs: narrowPsbt.inputCount,
      outputScriptBytes: narrowPsbt.txOutputs.map((output) => output.script.length),
    }));
  });

  it("reports insufficient BTC as a client error when only small outputs remain", async () => {
    await saveWalletFundingSnapshot(db!, "regtest", walletScriptHex, [
      { txid: dustTxid, vout: 0, valueSats: "546", confirmations: 1 },
    ]);
    await expect(buildCrcLaunchSession({
      db: db!, network: "regtest", bitcoinNetwork: bitcoin.networks.regtest,
      ticker: "TEST", walletScriptHex, tokenScriptHex: walletScriptHex,
      funding: [{ txid: dustTxid, vout: 0 }], minerFeeSats: 1000,
      idempotencyKey: `${idempotencyKey}-insufficient`,
      feeScriptHex: "0014" + "2".repeat(40),
      guardianXOnly: Buffer.from("eec7245d6b7d2ccb30380bfbe2a3648cd7a942653f5aa340edcea1f283686619", "hex"),
      recoveryProfile: dev1RecoveryProfile(Buffer.from("24653eac434488002cc06bbfb7f10fe18991e35f9fe4302dbea6d2353dc0ab1c", "hex")),
    })).rejects.toMatchObject({ code: "INSUFFICIENT_BTC" });
  });
});
