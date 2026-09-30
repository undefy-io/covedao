import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import * as bitcoin from "bitcoinjs-lib";
import { createDb, saveWalletFundingSnapshot } from "@crclaunch/db";
import { buildCrcTradeSession } from "./crc-build";

const url = process.env.CRC_READ_TEST_DATABASE_URL;
const isolated = !!url && (() => { const u = new URL(url); return u.hostname === "127.0.0.1" && u.port === "5435" && u.pathname === "/crc_test"; })();
const db = isolated ? createDb(url!) : undefined;
const network = "regtest" as const;
const buyer = "0014" + "1".repeat(40);
const seller = "0014" + "2".repeat(40);
const fee = "0014" + "3".repeat(40);
const vault = "5120" + "4".repeat(64);
const deployTxid = "a".repeat(64);
const vaultTxid = "b".repeat(64);
const paymentTxid = "c".repeat(64);
const sellerTxid = "d".repeat(64);
const key = `trade-${randomUUID()}`;

describe.skipIf(!isolated)("CRC trade build from DB-observed inputs", () => {
  afterAll(async () => {
    await db!.execute(sql`delete from cove_crc_build_sessions where network = ${network} and idempotency_key like ${key + "%"}`);
    await db!.execute(sql`delete from cove_wallet_funding where network = ${network} and wallet_script in (${buyer}, ${seller})`);
  });

  it("makes vault input zero, payment change separate from token recipient, and immutable idempotency", async () => {
    await saveWalletFundingSnapshot(db!, network, buyer, [{ txid: paymentTxid, vout: 0, valueSats: "30000", confirmations: 1 }]);
    const asset = {
      assetId: `${network}:${deployTxid}`, network, deployTxid, ticker: "TEST", creatorScriptHex: seller,
      protocolScriptHex: fee, registeredVaultScriptHex: vault, mintedAtoms: "0", inventoryAtoms: "0",
      circulatingAtoms: "0", vaultAnchorSats: "330", availability: "active" as const,
      vault: { txid: vaultTxid, vout: 1, btcSats: "330", scriptHex: vault },
    };
    const input = {
      db: db!, network, bitcoinNetwork: bitcoin.networks.regtest, asset, operation: "buy" as const,
      amountAtoms: 10_000_000_000_000n, walletScriptHex: buyer, tokenScriptHex: seller,
      paymentFunding: [{ txid: paymentTxid, vout: 0 }], minerFeeSats: 1000,
      idempotencyKey: key + "-buy", feeScriptHex: fee,
    };
    const built = await buildCrcTradeSession(input);
    const psbt = bitcoin.Psbt.fromBase64(built.psbtBase64, { network: bitcoin.networks.regtest });
    expect(psbt.txInputs[0]).toMatchObject({ index: 1 });
    expect(Buffer.from(psbt.txInputs[0]!.hash).reverse().toString("hex")).toBe(vaultTxid);
    expect(psbt.txOutputs[1]!.script.toString("hex")).toBe(seller);
    expect(psbt.txOutputs.at(-1)!.script.toString("hex")).toBe(buyer);
    expect((await buildCrcTradeSession(input)).sessionId).toBe(built.sessionId);
    await expect(buildCrcTradeSession({ ...input, amountAtoms: 20_000_000_000_000n })).rejects.toThrow(/idempotency/i);
  });

  it("uses an observed seller carrier as input one and pays the payment address", async () => {
    await saveWalletFundingSnapshot(db!, network, seller, [{ txid: sellerTxid, vout: 1, valueSats: "1000", confirmations: 1 }]);
    await saveWalletFundingSnapshot(db!, network, buyer, [{ txid: paymentTxid, vout: 0, valueSats: "30000", confirmations: 1 }]);
    const asset = {
      assetId: `${network}:${deployTxid}`, network, deployTxid, ticker: "TEST", creatorScriptHex: seller,
      protocolScriptHex: fee, registeredVaultScriptHex: vault, mintedAtoms: "10000000000000", inventoryAtoms: "0",
      circulatingAtoms: "10000000000000", vaultAnchorSats: "330", availability: "active" as const,
      vault: { txid: vaultTxid, vout: 1, btcSats: "3030", scriptHex: vault },
    };
    const built = await buildCrcTradeSession({
      db: db!, network, bitcoinNetwork: bitcoin.networks.regtest, asset, operation: "sell",
      amountAtoms: 10_000_000_000_000n, walletScriptHex: buyer, tokenScriptHex: seller,
      sellerFunding: { txid: sellerTxid, vout: 1 }, paymentFunding: [{ txid: paymentTxid, vout: 0 }],
      minerFeeSats: 1000, idempotencyKey: key + "-sell", feeScriptHex: fee,
    });
    const psbt = bitcoin.Psbt.fromBase64(built.psbtBase64, { network: bitcoin.networks.regtest });
    expect(Buffer.from(psbt.txInputs[1]!.hash).reverse().toString("hex")).toBe(sellerTxid);
    expect(psbt.txOutputs[2]!.script.toString("hex")).toBe(buyer);
  });
});
