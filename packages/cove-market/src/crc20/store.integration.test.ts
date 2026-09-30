import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@crclaunch/db";
import { signBip322P2wpkh } from "../order/signature.js";
import { crcCancelMessage, crcListingMessage, type CrcListing } from "./market.js";
import { acceptSignedCrcFill, broadcastCrcFill, cancelCrcListing, createCrcListing, listCrcSellerFillRequests, reconcileCrcFill, releaseExpiredCrcReservations, reserveCrcFill, submitBuyerSignedCrcFill } from "./store.js";
import type { CoreRpcProvider } from "@crclaunch/bitcoin";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory } from "ecpair";

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const dbUrl = process.env.TEST_DATABASE_URL;
const maybe = dbUrl ? describe : describe.skip;
const sellerKey = ECPairFactory(ecc).fromPrivateKey(Buffer.alloc(32, 0x51));
const buyerKey = ECPairFactory(ecc).fromPrivateKey(Buffer.alloc(32, 0x52));
const sellerScript = bitcoin.payments.p2wpkh({ pubkey: sellerKey.publicKey }).output!.toString("hex");
const buyerScript = bitcoin.payments.p2wpkh({ pubkey: buyerKey.publicKey }).output!.toString("hex");

maybe("CRC market SQL concurrency", () => {
  const db = createDb(dbUrl!);
  it("rejects an external deployment and races one reservation per Cove listing", async () => {
    const migration = readFileSync(resolve(import.meta.dirname, "../../../db/drizzle/0031_crc_market.sql"), "utf8");
    await db.execute(sql.raw(migration));
    const v2Migration = readFileSync(resolve(import.meta.dirname, "../../../db/drizzle/0032_crc_token_utxos.sql"), "utf8");
    const hasV2 = await db.execute(sql`SELECT to_regclass('cove_crc_token_utxos') AS relation`);
    if (!(hasV2.rows[0] as { relation: string | null }).relation) await db.execute(sql.raw(v2Migration));
    const deployTxid = Buffer.from(randomUUID().replaceAll("-", "").repeat(2), "hex").toString("hex");
    const listing: CrcListing = {
      id: randomUUID(), network: "regtest", deployTxid, ticker: "TSTX",
      sellerScriptHex: sellerScript, sellerPayoutScriptHex: sellerScript,
      sellerAnchorTxid: "d".repeat(64), sellerAnchorVout: 0, sellerAnchorSats: 10_000,
      amountAtoms: 100_000_000_000n, priceSats: 5_000, protocolFeeSats: 1_000,
      expiresAtHeight: 300n,
    };
    const auth = signBip322P2wpkh(Buffer.alloc(32, 0x51), Buffer.from(sellerScript, "hex"), crcListingMessage(listing));
    const core = { getTxout: async (txid: string) => ({
      scriptPubKeyHex: txid === listing.sellerAnchorTxid ? sellerScript : buyerScript,
      valueSats: 10_000n, confirmations: 1,
    }) };
    await expect(createCrcListing(db, listing, auth, core, 750n)).rejects.toThrow("registered Cove");
    try {
      await db.execute(sql`INSERT INTO cove_crc_assets (network, deploy_txid, ticker, deploy_height, deploy_block_hash, launch_salt_hex, creator_script_hex, protocol_script_hex, protocol_version, burned_atoms)
        VALUES ('regtest', ${deployTxid}, 'TSTX', 10, ${"a".repeat(64)}, ${"e".repeat(64)}, ${sellerScript}, ${buyerScript}, 2, 0)`);
      await db.execute(sql`INSERT INTO cove_crc_vaults (network, deploy_txid, txid, vout, script_hex, btc_sats, minted_atoms, inventory_atoms, availability)
        VALUES ('regtest', ${deployTxid}, ${"c".repeat(64)}, 1, ${sellerScript}, 10000, 100000000000, 0, 'active')`);
      await db.execute(sql`INSERT INTO cove_crc_balances (network, deploy_txid, script_hex, atoms)
        VALUES ('regtest', ${deployTxid}, ${sellerScript}, 100000000000)`);
      await expect(createCrcListing(db, listing, auth, core, 750n)).rejects.toThrow("token outpoint");
      await db.execute(sql`INSERT INTO cove_crc_token_utxos (network, deploy_txid, txid, vout, script_hex, atoms, created_height, created_block_hash)
        VALUES ('regtest', ${deployTxid}, ${listing.sellerAnchorTxid}, 0, ${sellerScript}, ${listing.amountAtoms.toString()}, 10, ${"a".repeat(64)})`);
      await createCrcListing(db, listing, auth, core, 750n);
      const reserve = (id: string) => reserveCrcFill(db, {
        listingId: listing.id, network: "regtest", fillId: id,
        buyerScriptHex: buyerScript, protocolScriptHex: buyerScript,
        recipientSats: 1_000, minerFeeSats: 400,
        sellerFunding: { txid: listing.sellerAnchorTxid, vout: 0, valueSats: 10_000, scriptHex: sellerScript,
          tokenAtoms: listing.amountAtoms, tokenDeploymentTxid: deployTxid },
        buyerFunding: [{ txid: "e".repeat(64), vout: 0, valueSats: 10_000, scriptHex: buyerScript, tokenAtoms: 0n }],
      }, core);
      const firstId = randomUUID();
      const secondId = randomUUID();
      const [a, b] = await Promise.allSettled([reserve(firstId), reserve(secondId)]);
      expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
      const won = a.status === "fulfilled" ? { id: firstId, value: a.value } :
        b.status === "fulfilled" ? { id: secondId, value: b.value } : null;
      expect(won).not.toBeNull();
      const signed = bitcoin.Psbt.fromBase64(won!.value.psbtBase64, { network: bitcoin.networks.regtest });
      signed.signInput(1, buyerKey);
      await db.execute(sql`INSERT INTO cove_crc_token_utxos (network, deploy_txid, txid, vout, script_hex, atoms, created_height, created_block_hash)
        VALUES ('regtest', ${deployTxid}, ${"e".repeat(64)}, 0, ${buyerScript}, 1, 10, ${"a".repeat(64)})`);
      await expect(submitBuyerSignedCrcFill(db, "regtest", won!.id, signed.toBase64()))
        .rejects.toThrow("buyer funding carries a Cove token allocation");
      await db.execute(sql`DELETE FROM cove_crc_token_utxos WHERE network = 'regtest' AND txid = ${"e".repeat(64)} AND vout = 0`);
      await submitBuyerSignedCrcFill(db, "regtest", won!.id, signed.toBase64());
      const mainCancelAuth = signBip322P2wpkh(Buffer.alloc(32, 0x51), Buffer.from(sellerScript, "hex"), crcCancelMessage(listing));
      await expect(cancelCrcListing(db, "regtest", listing.id, mainCancelAuth))
        .rejects.toThrow("buyer-signed fill");
      const requests = await listCrcSellerFillRequests(db, "regtest", sellerScript);
      expect(requests.some((entry) => entry.fillId === won!.id)).toBe(true);
      signed.signInput(0, sellerKey);
      const accepted = await acceptSignedCrcFill(db, "regtest", won!.id, signed.toBase64(), core);
      await expect(acceptSignedCrcFill(db, "regtest", won!.id, signed.toBase64(), core)).rejects.toThrow();
      const broadcaster = {
        getBlockchainInfo: async () => ({ chain: "regtest", blocks: 100, bestBlockHash: "f".repeat(64) }),
        testMempoolAccept: async () => ({ allowed: true }),
        broadcastTransaction: async () => accepted.txid,
      } as unknown as CoreRpcProvider;
      expect(await broadcastCrcFill(db, "regtest", won!.id, broadcaster)).toBe(accepted.txid);
      expect(await broadcastCrcFill(db, "regtest", won!.id, broadcaster)).toBe(accepted.txid);
      expect(await reconcileCrcFill(db, "regtest", won!.id)).toBe("pending");
      await db.execute(sql`INSERT INTO cove_crc_events (network, txid, block_height, block_hash, tx_index, operation, status, valid, deploy_txid, amount_atoms)
        VALUES ('regtest', ${accepted.txid}, 101, ${"f".repeat(64)}, 0, 'transfer', 'applied', true, ${deployTxid}, 100000000000)`);
      expect(await reconcileCrcFill(db, "regtest", won!.id)).toBe("confirmed");
      await db.execute(sql`DELETE FROM cove_crc_events WHERE network = 'regtest' AND txid = ${accepted.txid}`);
      expect(await reconcileCrcFill(db, "regtest", won!.id)).toBe("reorged");
      const canceledListing = { ...listing, id: randomUUID(), sellerAnchorTxid: "7".repeat(64) };
      const canceledCore = { getTxout: async (txid: string) => ({
        scriptPubKeyHex: txid === canceledListing.sellerAnchorTxid ? sellerScript : buyerScript,
        valueSats: 10_000n, confirmations: 1,
      }) };
      await db.execute(sql`INSERT INTO cove_crc_token_utxos (network, deploy_txid, txid, vout, script_hex, atoms, created_height, created_block_hash)
        VALUES ('regtest', ${deployTxid}, ${canceledListing.sellerAnchorTxid}, 0, ${sellerScript}, ${listing.amountAtoms.toString()}, 10, ${"a".repeat(64)})`);
      const canceledAuth = signBip322P2wpkh(Buffer.alloc(32, 0x51), Buffer.from(sellerScript, "hex"), crcListingMessage(canceledListing));
      await createCrcListing(db, canceledListing, canceledAuth, canceledCore, 750n);
      const canceledFill = randomUUID();
      const canceledRequest = {
        listingId: canceledListing.id, network: "regtest", fillId: canceledFill,
        buyerScriptHex: buyerScript, protocolScriptHex: buyerScript,
        recipientSats: 1_000, minerFeeSats: 400,
        sellerFunding: { txid: canceledListing.sellerAnchorTxid, vout: 0, valueSats: 10_000,
          scriptHex: sellerScript, tokenAtoms: listing.amountAtoms, tokenDeploymentTxid: deployTxid },
        buyerFunding: [{ txid: "8".repeat(64), vout: 0, valueSats: 10_000,
          scriptHex: buyerScript, tokenAtoms: 0n }],
      } as const;
      const canceledReservation = await reserveCrcFill(db, canceledRequest, canceledCore);
      await db.execute(sql`UPDATE cove_crc_market_fills SET expires_at = now() - interval '1 second'
        WHERE id = ${canceledFill}`);
      const renewedFill = randomUUID();
      await reserveCrcFill(db, { ...canceledRequest, fillId: renewedFill }, canceledCore);
      const cancelAuth = signBip322P2wpkh(Buffer.alloc(32, 0x51), Buffer.from(sellerScript, "hex"), crcCancelMessage(canceledListing));
      await cancelCrcListing(db, "regtest", canceledListing.id, cancelAuth);
      await cancelCrcListing(db, "regtest", canceledListing.id, cancelAuth);
      await expect(submitBuyerSignedCrcFill(db, "regtest", canceledFill,
        canceledReservation.psbtBase64)).rejects.toThrow("no longer available");
      expect(await releaseExpiredCrcReservations(db, "regtest")).toBe(0);
    } finally {
      await db.execute(sql`DELETE FROM cove_crc_events WHERE network = 'regtest' AND deploy_txid = ${deployTxid}`);
      await db.execute(sql`DELETE FROM cove_crc_market_fills WHERE network = 'regtest' AND listing_id IN
        (SELECT id FROM cove_crc_market_listings WHERE network = 'regtest' AND deploy_txid = ${deployTxid})`);
      await db.execute(sql`DELETE FROM cove_crc_market_listings WHERE network = 'regtest' AND deploy_txid = ${deployTxid}`);
      await db.execute(sql`DELETE FROM cove_crc_token_utxos WHERE network = 'regtest' AND deploy_txid = ${deployTxid}`);
      await db.execute(sql`DELETE FROM cove_crc_balances WHERE network = 'regtest' AND deploy_txid = ${deployTxid}`);
      await db.execute(sql`DELETE FROM cove_crc_vaults WHERE network = 'regtest' AND deploy_txid = ${deployTxid}`);
      await db.execute(sql`DELETE FROM cove_crc_assets WHERE network = 'regtest' AND deploy_txid = ${deployTxid}`);
    }
  });
});
