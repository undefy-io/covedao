import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { sql } from "drizzle-orm";
import { CoreRpcProvider } from "@crclaunch/bitcoin";
import {
  createDb,
  schema,
  claimObservationWorker,
  prepareSubmission,
  claimSubmission,
  saveSignedSubmission,
  dueSubmissions,
} from "@crclaunch/db";
import { V3IndexerState, V3Store, loadCanonicalViewSnapshot } from "@crclaunch/cove-indexer/v3";
import { CHAIN_BITCOIN_REGTEST } from "@crclaunch/cove-wire";
import {
  buildDeployPsbtV3,
  buildMintPsbtV3,
  GuardianV3Signer,
  LocalGuardianTransitionSigner,
  localSigningBackend,
  chainFundingChecker,
} from "@crclaunch/cove-guardian/v3";
import { PostgresSigningJournal } from "./journal.js";
import { PostgresGuardianAudit } from "./audit.js";
import { DEV_RISK_POLICY } from "./transition-signer.js";
import { indexedBackingConflict } from "./backing-conflict.js";
import { PendingObservationWorker } from "./pending-observations.js";
import { saveChainObservation } from "./runtime-snapshot.js";
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

describe.skipIf(!isolated)("competing vault spends on isolated Bitcoin Core and PostgreSQL", () => {
  it.each(["native", "nested"])(
    "follows competing %s funding, its winner and reorg while retaining retries",
    async (fundingType) => {
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
      const deploy = buildDeployPsbtV3({
        network: bitcoin.networks.regtest,
        feeScript,
        identity: {
          chainIdentity: CHAIN_BITCOIN_REGTEST,
          policyVersion: 3,
          ticker: "RACE",
          tokenNonce: Buffer.alloc(32, 0xab),
        },
        guardianXOnly,
        recoveryKeyXOnly,
        creatorScript: walletWitness.output!,
        deployerInputs: [funding[0]!],
        deployerChangeScript: payment.output!,
        minerFeeSats: 1000n,
      });
      deploy.psbt.signInput(0, wallet);
      deploy.psbt.finalizeInput(0);
      const deployTxid = await provider.broadcastTransaction(
        deploy.psbt.extractTransaction().toHex(),
      );
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
      const view = loadCanonicalViewSnapshot({ state });
      const journal = new PostgresSigningJournal(db),
        audit = new PostgresGuardianAudit(db, "COVE_V3_VAULT_PROFILE_DEV1");
      const signer = new LocalGuardianTransitionSigner(
        localSigningBackend(guardian),
        journal,
        audit,
        { ...DEV_RISK_POLICY, maxGrossSats: 1_000_000n },
      );
      const fundingChecker = chainFundingChecker({
        chain: provider,
        isCoveCarrier: async (outpoint) => state.getTokenUtxo(outpoint) !== null,
      });
      const makeMint = (
        coin: (typeof funding)[number],
        amount = 1_000_000n * 100_000_000n,
        minerFeeSats = 1000n,
        prevState = deploy.s0,
        backing = { txid: deployTxid, script: deploy.vault.scriptPubKey },
      ) => {
        const mint = buildMintPsbtV3({
          network: bitcoin.networks.regtest,
          tokenId: deploy.tokenId,
          prevState,
          prevBacking: { ...backing, vout: 1, valueSats: 10_000n + prevState.backingSats },
          mintAmountAtoms: amount,
          guardianXOnly,
          recoveryKeyXOnly,
          buyerInputs: [coin],
          buyerCarrierScript: walletWitness.output!,
          buyerChangeScript: payment.output!,
          creatorScript: walletWitness.output!,
          feeScript,
          minerFeeSats,
        });
        mint.psbt.signInput(1, wallet);
        mint.psbt.finalizeInput(1);
        return mint;
      };
      const a = makeMint(funding[1]!),
        b = makeMint(funding[2]!, 2_000_000n * 100_000_000n, 10_000n);
      const request = {
        view,
        maxMinerFeeSats: 20_000n,
        network: "regtest" as const,
        recoveryKeyXOnly,
        feeScript,
        fundingChecker,
      };
      const aSignature = await signer.signMint({ ...request, psbt: a.psbt });
      if (!aSignature.ok) throw new Error(`${aSignature.reason}: ${aSignature.detail}`);
      const bSignature = await signer.signMint({ ...request, psbt: b.psbt });
      if (!bSignature.ok) throw new Error(`${bSignature.reason}: ${bSignature.detail}`);
      const aTx = a.psbt.extractTransaction(),
        bTx = b.psbt.extractTransaction();
      const signedIdentity =
        await db.execute(sql`select signing_result->>'txid' as txid from cove_v3_signing_journal
      where network='regtest' and unsigned_tx_digest=${bitcoin.Transaction.fromBuffer(a.psbt.data.globalMap.unsignedTx.toBuffer()).getId()}`);
      expect(signedIdentity.rows[0]?.txid).toBe(aTx.getId());
      const sourceId = randomUUID();
      await db.insert(schema.coveV3AppTransactions).values({
        id: sourceId,
        network: "regtest",
        operation: "BACKING_BUY",
        tokenId: deploy.tokenId.toString("hex"),
        walletScript: payment.output!.toString("hex"),
        backingTxid: deployTxid,
        backingVout: 1,
        unsignedTxDigest: bitcoin.Transaction.fromBuffer(
          a.psbt.data.globalMap.unsignedTx.toBuffer(),
        ).getId(),
        status: "BUILT",
        idempotencyKey: randomUUID(),
      });
      const prepared = await prepareSubmission(db, {
        network: "regtest",
        sourceKind: "APP",
        sourceId,
        operation: "BACKING_BUY",
        tokenId: deploy.tokenId.toString("hex"),
        backingTxid: deployTxid,
        backingVout: 1,
        unsignedTxDigest: bitcoin.Transaction.fromBuffer(
          a.psbt.data.globalMap.unsignedTx.toBuffer(),
        ).getId(),
        walletPsbtBase64: a.psbt.toBase64(),
      });
      const readyA = await saveSignedSubmission(db, await claimSubmission(db, prepared.id), {
        rawTxHex: aTx.toHex(),
        txid: aTx.getId(),
      });
      await db.execute(
        sql`update cove_v3_submissions set lease_token = null, lease_until = null, next_attempt_at = clock_timestamp() where id = ${readyA.id}`,
      );
      expect((await provider.testMempoolAccept(aTx.toHex())).allowed).toBe(true);
      expect((await provider.testMempoolAccept(bTx.toHex())).allowed).toBe(true);
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
      const epoch = await claimObservationWorker(db, "regtest");
      const projections = new PendingObservationWorker(db, provider, config, epoch);
      const app = new V3AppService(db, provider, config, signer);
      const follow = app as unknown as {
        followPendingBacking(
          id: string,
          backing: unknown,
        ): Promise<{ input: { txid: string }; state: typeof deploy.s0 }>;
      };
      await db.insert(schema.coveV3AppTransactions).values(
        Array.from({ length: 100 }, (_, i) => ({
          network: "regtest",
          operation: "BACKING_BUY",
          tokenId: deploy.tokenId.toString("hex"),
          walletScript: payment.output!.toString("hex"),
          backingTxid: deployTxid,
          backingVout: 1,
          txid: i.toString(16).padStart(64, "0"),
          status: "BROADCAST",
          idempotencyKey: randomUUID(),
        })),
      );
      const compare = async (expectedTxid: string) => {
        for (let current = expectedTxid; current !== deployTxid;) {
          const accepted = bitcoin.Transaction.fromHex(await provider.getRawTransaction(current));
          const parent = Buffer.from(accepted.ins[0]!.hash).reverse().toString("hex");
          await db.insert(schema.coveV3AppTransactions).values({
            network: "regtest",
            operation: "BACKING_BUY",
            tokenId: deploy.tokenId.toString("hex"),
            walletScript: payment.output!.toString("hex"),
            backingTxid: parent,
            backingVout: accepted.ins[0]!.index,
            txid: current,
            status: "BROADCAST",
            idempotencyKey: randomUUID(),
          });
          current = parent;
        }
        await saveChainObservation(db, "regtest", await provider.getBlockchainInfo());
        expect((await projections.refresh()).published).toBe(1);
        const observed = await app.quoteBackingBuy(
          deploy.tokenId.toString("hex"),
          1_000_000n * 100_000_000n,
        );
        const legacy = await follow.followPendingBacking(deploy.tokenId.toString("hex"), {
          state: deploy.s0,
          input: {
            txid: deployTxid,
            vout: 1,
            script: deploy.vault.scriptPubKey,
            valueSats: 10_000n,
          },
        });
        expect(observed.backingOutpoint.txid).toBe(expectedTxid);
        expect(observed.supplyBeforeAtoms).toBe(legacy.state.issuedPublicSupplyAtoms);
        expect(observed.backingBeforeSats).toBe(legacy.state.backingSats);
        const fallbackApp = new V3AppService(
          db,
          new Proxy(provider, {
            get: (target, property) =>
              property === "getMempoolSpender"
                ? async () => undefined
                : property === "isTransactionInMempool"
                  ? () => {
                      throw new Error("per-competitor RPC forbidden");
                    }
                  : typeof Reflect.get(target, property) === "function"
                    ? Reflect.get(target, property).bind(target)
                    : Reflect.get(target, property),
          }),
          config,
          signer,
        ) as unknown as typeof follow;
        expect(
          (
            await fallbackApp.followPendingBacking(deploy.tokenId.toString("hex"), {
              state: deploy.s0,
              input: {
                txid: deployTxid,
                vout: 1,
                script: deploy.vault.scriptPubKey,
                valueSats: 10_000n,
              },
            })
          ).input.txid,
        ).toBe(expectedTxid);
        const noRpc = new V3AppService(
          db,
          new Proxy({} as CoreRpcProvider, {
            get: () => () => {
              throw new Error("PUBLIC_RPC_FORBIDDEN");
            },
          }),
          config,
          signer,
        );
        expect(
          (await noRpc.quoteBackingBuy(deploy.tokenId.toString("hex"), 1_000_000n * 100_000_000n))
            .stateHash,
        ).toBe(observed.stateHash);
        const routeQuote = await noRpc.quoteBackingBuy(deploy.tokenId.toString("hex"), 1_000_000n * 100_000_000n);
        const routes = await noRpc.getBuyRoutes(deploy.tokenId.toString("hex"), routeQuote.amountAtoms);
        expect(routes.find((route) => route.kind === "backing")?.totalCostSats)
          .toBe(routeQuote.grossSats + routeQuote.feeSats + routeQuote.creatorFeeSats);
        await noRpc.quoteBuyForSats(deploy.tokenId.toString("hex"), 100_000n);
        if (legacy.state.issuedPublicSupplyAtoms > 0n)
          await noRpc.quoteRedeem(deploy.tokenId.toString("hex"), 1_000_000n * 100_000_000n);
        expect((await noRpc.txStatus("aa".repeat(32))).state).toBe("unknown");
        const fallbackProvider = new Proxy(provider, {
          get: (target, property) =>
            property === "getMempoolSpenders"
              ? async () => undefined
              : typeof Reflect.get(target, property) === "function"
                ? Reflect.get(target, property).bind(target)
                : Reflect.get(target, property),
        });
        const fallback = new PendingObservationWorker(db, fallbackProvider, config, epoch);
        expect((await fallback.refresh()).published).toBe(1);
        expect(
          (await noRpc.quoteBackingBuy(deploy.tokenId.toString("hex"), 1_000_000n * 100_000_000n))
            .stateHash,
        ).toBe(observed.stateHash);
      };
      await provider.broadcastTransaction(aTx.toHex());
      await compare(aTx.getId());
      expect(await provider.getTxout(deployTxid, 1)).toBeNull();
      expect(await provider.getTxout(deployTxid, 1, false)).not.toBeNull();
      const pendingState = state.clone();
      pendingState.applyBlock({
        height: state.cursor.height + 1n,
        hash: "aa".repeat(32),
        parentHash: state.cursor.blockHash,
        txs: [aTx.toHex()],
      });
      const child = makeMint(funding[3]!, undefined, undefined, a.nextState, {
        txid: aTx.getId(),
        script: a.nextVault.scriptPubKey,
      });
      expect(
        (
          await signer.signMint({
            ...request,
            view: {
              ...loadCanonicalViewSnapshot({ state: pendingState }),
              cursorHeight: view.cursorHeight,
            },
            psbt: child.psbt,
          })
        ).ok,
      ).toBe(true);
      const childTx = child.psbt.extractTransaction();
      await provider.broadcastTransaction(childTx.toHex());
      await compare(childTx.getId());
      const fundingReplacement = new bitcoin.Psbt({ network: bitcoin.networks.regtest });
      fundingReplacement.addInput({
        hash: funding[1]!.txid,
        index: funding[1]!.vout,
        sequence: 0xfffffffd,
        witnessUtxo: { script: funding[1]!.script, value: Number(funding[1]!.valueSats) },
      });
      if (fundingType === "nested")
        fundingReplacement.updateInput(0, { redeemScript: walletWitness.output! });
      fundingReplacement.addOutput({ script: payment.output!, value: 9_900_000 });
      fundingReplacement.signInput(0, wallet);
      fundingReplacement.finalizeInput(0);
      await provider.broadcastTransaction(fundingReplacement.extractTransaction().toHex());
      expect(await provider.isTransactionInMempool(aTx.getId())).toBe(false);
      expect(await provider.isTransactionInMempool(childTx.getId())).toBe(false);
      await compare(deployTxid);
      await provider.broadcastTransaction(bTx.toHex());
      expect(await provider.isTransactionInMempool(aTx.getId())).toBe(false);
      expect(await provider.isTransactionInMempool(childTx.getId())).toBe(false);
      expect(await provider.getMempoolSpender(deployTxid, 1)).toBe(bTx.getId());
      for (const [txid, backingTxid] of [
        [aTx.getId(), deployTxid],
        [bTx.getId(), deployTxid],
        [childTx.getId(), aTx.getId()],
      ]) {
        await db.insert(schema.coveV3AppTransactions).values({
          network: "regtest",
          operation: "BACKING_BUY",
          tokenId: deploy.tokenId.toString("hex"),
          walletScript: payment.output!.toString("hex"),
          backingTxid,
          backingVout: 1,
          txid,
          status: "BROADCAST",
          idempotencyKey: randomUUID(),
        });
      }
      await compare(bTx.getId());
      const tip = await follow.followPendingBacking(deploy.tokenId.toString("hex"), {
        state: deploy.s0,
        input: { txid: deployTxid, vout: 1, script: deploy.vault.scriptPubKey, valueSats: 10_000n },
      });
      expect(tip.input.txid).toBe(bTx.getId());
      expect(tip.state).toEqual(b.nextState);
      const bBlocks = await rpc<string[]>("generatetoaddress", [1, minerAddress]);
      const bBlock = await index(bBlocks[0]!);
      expect(await indexedBackingConflict(db, "regtest", aTx.getId())).toBe(true);
      expect(await indexedBackingConflict(db, "regtest", childTx.getId())).toBe(true);
      await app.reconcileSubmissionConflicts();
      expect((await dueSubmissions(db, "regtest", 10)).some((job) => job.id === readyA.id)).toBe(
        false,
      );
      const preserved = await db.execute(
        sql`select raw_tx_hex, conflicted from cove_v3_submissions where id = ${readyA.id}`,
      );
      expect(preserved.rows[0]?.raw_tx_hex).toBe(aTx.toHex());
      expect(preserved.rows[0]?.conflicted).toBe(true);
      expect(await indexedBackingConflict(db, "regtest", bTx.getId())).toBe(false);
      expect(await app.txStatus(aTx.getId())).toMatchObject({
        state: "conflicted",
        mempool: false,
      });
      expect(await app.txStatus(bTx.getId())).toMatchObject({ state: "confirmed" });
      expect((await provider.testMempoolAccept(aTx.toHex())).allowed).toBe(false);
      const undo = state.undoByHeight.get(bBlock.height)!;
      await rpc("invalidateblock", [bBlock.hash]);
      state.undoBlock(bBlock.height);
      await db.transaction(async (tx) => store.rollback(tx, undo, state.cursor));
      expect(await indexedBackingConflict(db, "regtest", aTx.getId())).toBe(false);
      expect(await indexedBackingConflict(db, "regtest", childTx.getId())).toBe(false);
      await app.reconcileSubmissionConflicts();
      expect((await dueSubmissions(db, "regtest", 10)).some((job) => job.id === readyA.id)).toBe(
        true,
      );
      const otherBlock = await rpc<{ hash: string }>("generateblock", [
        minerAddress,
        [aTx.toHex()],
      ]);
      await index(otherBlock.hash);
      expect(await indexedBackingConflict(db, "regtest", aTx.getId())).toBe(false);
      expect(await indexedBackingConflict(db, "regtest", bTx.getId())).toBe(true);
      expect(await indexedBackingConflict(db, "regtest", childTx.getId())).toBe(false);
      expect(await app.txStatus(aTx.getId())).toMatchObject({ state: "confirmed" });
      await provider.broadcastTransaction(childTx.toHex());
      expect(await provider.isTransactionInMempool(childTx.getId())).toBe(true);
    },
    60_000,
  );
});
