import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { sql } from "drizzle-orm";
import { CoreRpcProvider } from "@crclaunch/bitcoin";
import { createDb, saveWalletFundingSnapshot } from "@crclaunch/db";
import { V3IndexerState, V3Store } from "@crclaunch/cove-indexer/v3";
import { CHAIN_BITCOIN_REGTEST } from "@crclaunch/cove-wire";
import {
  buildDeployPsbtV3,
  GuardianV3Signer,
  LocalGuardianTransitionSigner,
  localSigningBackend,
} from "@crclaunch/cove-guardian/v3";
import { PostgresSigningJournal } from "./journal.js";
import { PostgresGuardianAudit } from "./audit.js";
import { DEV_RISK_POLICY } from "./transition-signer.js";
import { saveChainObservation, saveFeeObservation } from "./runtime-snapshot.js";
import { V3AppService } from "./service.js";
import { loadV3AppConfig } from "./config.js";

bitcoin.initEccLib(ecc as unknown as Parameters<typeof bitcoin.initEccLib>[0]);
const databaseUrl = process.env.SUBMISSION_TEST_DATABASE_URL;
const rpcUrl = process.env.COMPETITION_REGTEST_RPC_URL;
const dbAddress = databaseUrl ? new URL(databaseUrl) : undefined;
const rpcAddress = rpcUrl ? new URL(rpcUrl) : undefined;
const isolated =
  dbAddress?.hostname === "127.0.0.1" &&
  dbAddress.port === "5435" &&
  dbAddress.pathname === "/submissions_test" &&
  rpcAddress?.hostname === "127.0.0.1" &&
  rpcAddress.port === "18453";

describe.skipIf(!isolated)("1000-token redemptions on isolated Core", () => {
  it.each([
    ["native", false, 1000n],
    ["nested", false, 1000n],
    ["native", true, 1000n],
    ["nested", true, 1000n],
    ["native", false, 100000n],
  ] as const)(
    "buys and redeems with verified recipient balances (%s, partial=%s, tokens=%s)",
    async (fundingType, partial, redeemTokens) => {
      const db = createDb(databaseUrl!);
      await db.execute(
        sql`truncate cove_v3_cursor, cove_v3_tokens, cove_v3_backing_states, cove_v3_token_utxos, cove_v3_signing_journal, cove_v3_guardian_audit, cove_v3_blocks, cove_v3_events, cove_v3_undo, cove_v3_app_transactions`,
      );
      const walletName = "competition-" + randomUUID();
      async function rpc<T>(method: string, params: unknown[] = [], wallet = false): Promise<T> {
        const response = await fetch(rpcUrl! + (wallet ? `/wallet/${walletName}` : ""), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Basic " + Buffer.from("competition-test:test-only").toString("base64"),
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(10_000),
        });
        const body = (await response.json()) as { result: T; error?: { message: string } };
        if (!response.ok || body.error)
          throw new Error(`${method}: ${body.error?.message ?? response.status}`);
        return body.result;
      }
      await rpc("createwallet", [walletName]);
      const minerAddress = await rpc<string>("getnewaddress", [], true);
      await rpc("generatetoaddress", [101, minerAddress]);
      const privateKey = Buffer.alloc(32, 0x46),
        publicKey = Buffer.from(ecc.pointFromScalar(privateKey, true)!);
      const wallet = { publicKey, sign: (hash: Buffer) => Buffer.from(ecc.sign(hash, privateKey)) };
      const walletWitness = bitcoin.payments.p2wpkh({
        pubkey: publicKey,
        network: bitcoin.networks.regtest,
      });
      const payment =
        fundingType === "nested"
          ? bitcoin.payments.p2sh({ redeem: walletWitness, network: bitcoin.networks.regtest })
          : walletWitness;
      const funding: {
        txid: string;
        vout: number;
        script: Buffer;
        publicKey: Buffer;
        valueSats: bigint;
      }[] = [];
      for (let i = 0; i < 4; i++) {
        const txid = await rpc<string>("sendtoaddress", [payment.address, 0.1], true);
        const raw = await rpc<string>("getrawtransaction", [txid]);
        const tx = bitcoin.Transaction.fromHex(raw),
          vout = tx.outs.findIndex(
            (o) => o.script.equals(payment.output!) && o.value === 10_000_000,
          );
        expect(vout).toBeGreaterThanOrEqual(0);
        funding.push({ txid, vout, script: payment.output!, publicKey, valueSats: 10_000_000n });
      }
      await rpc("generatetoaddress", [1, minerAddress]);
      const provider = new CoreRpcProvider({
        url: rpcUrl!,
        user: "competition-test",
        password: "test-only",
      });
      const guardian = GuardianV3Signer.fromPrivateKey(Buffer.alloc(32, 0x42)),
        guardianXOnly = guardian.xOnlyPubkey();
      const recoveryKeyXOnly = Buffer.from(
        ecc.pointFromScalar(Buffer.alloc(32, 0x43), true)!.subarray(1),
      );
      const feeScript = bitcoin.payments.p2wpkh({
        pubkey: Buffer.from(ecc.pointFromScalar(Buffer.alloc(32, 0x44), true)!),
      }).output!;
      const creatorScript = bitcoin.payments.p2wpkh({
        pubkey: Buffer.from(ecc.pointFromScalar(Buffer.alloc(32, 0x45), true)!),
      }).output!;
      const deploy = buildDeployPsbtV3({
        network: bitcoin.networks.regtest,
        feeScript,
        identity: {
          chainIdentity: CHAIN_BITCOIN_REGTEST,
          policyVersion: 3,
          ticker: "SMALL",
          tokenNonce: Buffer.alloc(32, 0xab),
        },
        guardianXOnly,
        recoveryKeyXOnly,
        creatorScript,
        deployerInputs: [funding[0]!],
        deployerChangeScript: payment.output!,
        minerFeeSats: 1000n,
      });
      deploy.psbt.signInput(0, wallet);
      deploy.psbt.finalizeInput(0);
      await provider.broadcastTransaction(deploy.psbt.extractTransaction().toHex());
      const deployBlocks = await rpc<string[]>("generatetoaddress", [1, minerAddress]);
      const state = new V3IndexerState({
        network: "regtest",
        chainIdentity: CHAIN_BITCOIN_REGTEST,
        guardianXOnly,
        recoveryKeyXOnly,
        feeScript,
        genesisHeight: 0n,
      });
      const store = new V3Store("regtest");
      async function index(hash: string) {
        const block = await provider.getBlock(hash),
          input = {
            height: BigInt(block.height),
            hash,
            parentHash: block.previousBlockHash,
            txs: block.rawTxs,
          };
        state.applyBlock(input);
        await db.transaction(async (tx) =>
          store.persistBlock(
            tx,
            state,
            input,
            state.events.filter((e) => e.blockHash === hash),
            state.undoByHeight.get(input.height)!,
          ),
        );
        return input;
      }
      await index(deployBlocks[0]!);
      async function confirmedTransaction(txid: string) {
        const transaction = bitcoin.Transaction.fromHex(
          await rpc<string>("getrawtransaction", [txid]),
        );
        const previousOutputs = await Promise.all(
          transaction.ins.map(async (input) => {
            const previousTxid = Buffer.from(input.hash).reverse().toString("hex");
            const previous = bitcoin.Transaction.fromHex(
              await rpc<string>("getrawtransaction", [previousTxid]),
            );
            return previous.outs[input.index]!;
          }),
        );
        const sum = (outputs: typeof transaction.outs) =>
          outputs.reduce((value, output) => value + BigInt(output.value), 0n);
        const owned = (output: (typeof transaction.outs)[number]) =>
          output.script.equals(payment.output!) || output.script.equals(walletWitness.output!);
        expect(sum(previousOutputs) - sum(transaction.outs)).toBe(1000n);
        return {
          transaction,
          walletDelta: sum(transaction.outs.filter(owned)) - sum(previousOutputs.filter(owned)),
          paidTo: (script: Buffer) =>
            sum(transaction.outs.filter((output) => output.script.equals(script))),
        };
      }
      async function unspentPaidTo(txid: string, script: Buffer) {
        const transaction = bitcoin.Transaction.fromHex(
          await rpc<string>("getrawtransaction", [txid]),
        );
        let balance = 0n;
        for (const [vout, output] of transaction.outs.entries()) {
          if (!output.script.equals(script)) continue;
          const coin = await rpc<{
            confirmations: number;
            value: number;
            scriptPubKey: { hex: string };
          } | null>("gettxout", [txid, vout]);
          expect(coin).not.toBeNull();
          expect(coin!.confirmations).toBeGreaterThan(0);
          expect(coin!.scriptPubKey.hex).toBe(script.toString("hex"));
          const value = BigInt(Math.round(coin!.value * 100_000_000));
          expect(value).toBe(BigInt(output.value));
          balance += value;
        }
        return balance;
      }

      const journal = new PostgresSigningJournal(db),
        audit = new PostgresGuardianAudit(db, "COVE_V3_VAULT_PROFILE_DEV1");
      const signer = new LocalGuardianTransitionSigner(
        localSigningBackend(guardian),
        journal,
        audit,
        { ...DEV_RISK_POLICY, maxGrossSats: 1_000_000n },
      );
      const config = {
        ...loadV3AppConfig({ COVE_NETWORK: "regtest" }),
        mintLimits: {
          maxMintAtoms: 10_000_000n * 100_000_000n,
          maxGrossSats: null,
          minGrossSats: 0n,
        },
        guardianXOnly,
        recoveryKeyXOnly,
        recoveryProfile: undefined,
        feeScript,
      };

      const app = new V3AppService(db, provider, config, signer);
      await saveWalletFundingSnapshot(
        db,
        "regtest",
        payment.output!.toString("hex"),
        funding.map((coin) => ({
          txid: coin.txid,
          vout: coin.vout,
          valueSats: coin.valueSats.toString(),
          confirmations: 1,
        })),
      );
      await saveChainObservation(db, "regtest", await provider.getBlockchainInfo());
      await saveFeeObservation(
        db,
        "regtest",
        {
          floorSatPerVb: 1n,
          ceilingSatPerVb: 100n,
          estimated: false,
          tiers: [{ key: "standard", label: "Standard", blocks: 6, satPerVb: 1n }],
        },
        new Date(),
      );
      const walletFields = {
        walletScript: payment.output!.toString("hex"),
        walletPublicKey: publicKey.toString("hex"),
        ordinalsScript: walletWitness.output!.toString("hex"),
        ordinalsPublicKey: publicKey.toString("hex"),
        walletAddress: null,
      };
      const redeemAmount = redeemTokens * 100000000n;
      const mintAmount = (partial ? 2n : 1n) * redeemAmount;
      const quote = await app.quoteBackingBuy(deploy.tokenId.toString("hex"), mintAmount);
      const buy = await app.buildBackingBuy({
        ...walletFields,
        tokenId: deploy.tokenId.toString("hex"),
        amountAtoms: mintAmount,
        quoteBinding: {
          stateHash: quote.stateHash,
          backingOutpoint: quote.backingOutpoint,
          expiresAtHeight: null,
        },
        funding: [{ txid: funding[1]!.txid, vout: funding[1]!.vout }],
        minerFeeSats: 1000n,
        idempotencyKey: randomUUID(),
      });
      const buyPsbt = bitcoin.Psbt.fromBase64(buy.psbtBase64);
      buyPsbt.signInput(1, wallet);
      const bought = await app.submitBackingBuy({
        sessionId: buy.sessionId,
        signedPsbtBase64: buyPsbt.toBase64(),
      });
      await index((await rpc<string[]>("generatetoaddress", [1, minerAddress]))[0]!);
      expect(state.events.find((e) => e.txid === bought.txid)?.valid).toBe(true);
      const grossBuy = (mintAmount / 100000000000n) * 27n;
      const platformBuyFee =
        5000n + (mintAmount / 100000000000n) * 10n + (grossBuy * 750n + 9999n) / 10000n;
      const creatorBuyFee = (grossBuy + 1n) / 2n > 546n ? (grossBuy + 1n) / 2n : 546n;
      const boughtTransaction = await confirmedTransaction(bought.txid);
      expect(boughtTransaction.paidTo(feeScript)).toBe(platformBuyFee);
      expect(boughtTransaction.paidTo(creatorScript)).toBe(creatorBuyFee);
      expect(boughtTransaction.walletDelta).toBe(
        -grossBuy - platformBuyFee - creatorBuyFee - 1000n,
      );
      expect(await unspentPaidTo(bought.txid, feeScript)).toBe(platformBuyFee);
      expect(await unspentPaidTo(bought.txid, creatorScript)).toBe(creatorBuyFee);
      expect(state.backing.get(deploy.tokenId.toString("hex"))!.state.backingSats).toBe(grossBuy);

      await saveChainObservation(db, "regtest", await provider.getBlockchainInfo());
      const sellQuote = await app.quoteRedeem(deploy.tokenId.toString("hex"), redeemAmount);
      expect(sellQuote.grossSats).toBe((redeemTokens * 27n) / 1000n);
      expect(sellQuote.feeSats).toBe(1000n);
      expect(sellQuote.netSats).toBe(sellQuote.grossSats - 1000n);
      await expect(app.quoteRedeem(deploy.tokenId.toString("hex"), 99900000000n)).rejects.toThrow(
        "TOKEN_AMOUNT_INVALID",
      );
      const sale = await app.buildRedeem({
        ...walletFields,
        tokenId: deploy.tokenId.toString("hex"),
        amountAtoms: redeemAmount,
        funding: redeemTokens === 1000n ? [{ txid: funding[2]!.txid, vout: funding[2]!.vout }] : [],
        minerFeeSats: 1000n,
        idempotencyKey: randomUUID(),
      });
      const salePsbt = bitcoin.Psbt.fromBase64(sale.psbtBase64);
      expect(salePsbt.txOutputs[2]!.script.equals(payment.output!)).toBe(true);
      expect(salePsbt.txOutputs[2]!.value).toBeGreaterThan(540);
      expect(sale.intent.netSats).toBe(sellQuote.netSats);
      expect(sale.intent.walletDeltaSats).toBe(sellQuote.netSats - 1000n);
      expect(sale.intent.payoutSats !== undefined).toBe(redeemTokens === 1000n);
      for (let i = 1; i < salePsbt.inputCount; i++) salePsbt.signInput(i, wallet);
      const sold = await app.submitRedeem({
        sessionId: sale.sessionId,
        signedPsbtBase64: salePsbt.toBase64(),
      });
      const redeemedBlock = await index(
        (await rpc<string[]>("generatetoaddress", [1, minerAddress]))[0]!,
      );
      expect(state.events.find((e) => e.txid === sold.txid)).toMatchObject({
        valid: true,
        operation: "REDEEM",
      });
      const soldTransaction = await confirmedTransaction(sold.txid);
      expect(soldTransaction.paidTo(feeScript)).toBe(1000n);
      expect(soldTransaction.paidTo(creatorScript)).toBe(0n);
      expect(soldTransaction.walletDelta).toBe(sellQuote.grossSats - 1000n - 1000n);
      expect(
        (await unspentPaidTo(bought.txid, feeScript)) + (await unspentPaidTo(sold.txid, feeScript)),
      ).toBe(platformBuyFee + 1000n);
      expect(await unspentPaidTo(bought.txid, creatorScript)).toBe(creatorBuyFee);
      if (!partial) {
        expect(boughtTransaction.walletDelta + soldTransaction.walletDelta).toBe(
          -platformBuyFee - creatorBuyFee - 1000n - 2000n,
        );
      }
      const remaining = state.backing.get(deploy.tokenId.toString("hex"))!;
      expect(remaining.state.issuedPublicSupplyAtoms).toBe(partial ? 100000000000n : 0n);
      expect(remaining.state.backingSats).toBe(partial ? 27n : 0n);
      expect(remaining.btcValue).toBe(10000n + (partial ? 27n : 0n));
      const undo = state.undoByHeight.get(redeemedBlock.height)!;
      await rpc("invalidateblock", [redeemedBlock.hash]);
      state.undoBlock(redeemedBlock.height);
      await db.transaction((tx) => store.rollback(tx, undo, state.cursor));
      expect(state.backing.get(deploy.tokenId.toString("hex"))!.state.issuedPublicSupplyAtoms).toBe(
        mintAmount,
      );
    },
    60000,
  );
});
