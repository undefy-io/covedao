import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import * as bitcoin from "bitcoinjs-lib";
import * as core from "@crclaunch/crc20-protocol";
import { completeServerWalletSigning } from "@crclaunch/crc20-adapters";
import {
  loadCrcCoreLedger,
  saveCrcRegistration,
  saveCrcEscrowAuthorization,
} from "@crclaunch/crc20-state";
import {
  broadcastRecordedTransaction,
  type CoreRpcProvider,
  type BlockchainInfo,
} from "@crclaunch/bitcoin";
import { AppError, unsignedTxDigest } from "@crclaunch/cove-app";
import type { Database } from "@crclaunch/db";
import {
  claimCrcBuildSession,
  getCrcBuildSession,
  markCrcBuildBroadcast,
  markCrcBuildReady,
  releaseCrcBuildSession,
} from "./crc-session";
import type { CrcNetwork } from "./crc-read";
import { parseCrcLaunchMetadata, saveCrcLaunchMetadata } from "./crc-metadata";
import { readyTransactionId } from "./crc-ready-transaction";
type SubmitParams = {
  db: Database;
  network: CrcNetwork;
  sessionId: string;
  signedPsbtBase64: string;
  provider: CoreRpcProvider;
  guardianEndpoint: string;
  guardianAuthToken: string;
  expectedOperation?: "deploy" | "buy" | "sell" | "transfer" | "listing" | "purchase" | "cancel";
  onTiming?: (stage: string, durationMs: number) => void;
};
async function timed<T>(params: SubmitParams, stage: string, run: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await run();
  } finally {
    params.onTiming?.(stage, performance.now() - start);
  }
}
type Session = NonNullable<Awaited<ReturnType<typeof getCrcBuildSession>>>;
function operationMatches(actual: string, expected: SubmitParams["expectedOperation"]) {
  return (
    !expected ||
    (expected === "buy" ? actual === "mint-buy" || actual === "inventory-buy" : actual === expected)
  );
}
function storedPlan(session: Session) {
  const data = session.trustedJson as Record<string, unknown>;
  const plan = core.decodeProtocolDto<core.Plan>(data.corePlan),
    config = core.decodeProtocolDto<core.Config>(data.coreConfig);
  core.validateConfig(config);
  if (!config.guardianCustody) throw new Error("registered Guardian custody required");
  if (unsignedTxDigest(bitcoin.Psbt.fromBase64(session.psbtBase64)) !== session.unsignedTxDigest)
    throw new Error("stored unsigned digest mismatch");
  return { plan, config, data };
}
async function context(params: SubmitParams, session: Session, config: core.Config) {
  const ledger = await loadCrcCoreLedger(params.db, params.network);
  if (!ledger) throw new AppError("STATE_CHANGED", "CRC index is not initialized");
  if (config.network !== core.protocolNetwork(params.network))
    throw new AppError("CLIENT_INTENT_MISMATCH", "CRC plan network mismatch");
  if (session.operation !== "deploy") {
    const asset = ledger.assets[session.deploymentTxid!];
    if (!asset || !isDeepStrictEqual(asset.config, config))
      throw new AppError("STATE_CHANGED", "CRC asset registration changed");
  }
  return { ...ledger, config };
}
async function assertNetwork(params: SubmitParams) {
  const info = await params.provider.getBlockchainInfo();
  const expected =
    params.network === "mainnet" ? "main" : params.network === "testnet" ? "test" : params.network;
  if (info.chain !== expected) throw new AppError("WRONG_NETWORK", "CRC backend network mismatch");
  return info;
}
async function assertLive(
  params: SubmitParams,
  ledger: core.Ledger,
  transaction: core.ChainTransaction,
  observation?: BlockchainInfo,
) {
  const network = observation ?? (await assertNetwork(params));
  if (ledger.tip && (await params.provider.getBlockHash(ledger.tip.height)) !== ledger.tip.hash)
    throw new AppError("STATE_CHANGED", "CRC indexed state is no longer canonical");
  for (const input of transaction.prevouts) {
    const observed = await params.provider.getTxout(input.txid, input.vout);
    if (
      !observed ||
      observed.confirmations < 1 ||
      observed.valueSats !== core.sats(input.sats) ||
      observed.scriptPubKeyHex.toLowerCase() !== input.scriptHex
    )
      throw new AppError("STATE_CHANGED", "CRC input is no longer a confirmed matching UTXO");
  }
  return network;
}
async function broadcastReady(params: SubmitParams, session: Session) {
  if (!session.signedRawHex || !session.txid) throw new Error("CRC signed transaction missing");
  const network = await assertNetwork(params);
  // A crash after broadcast can leave READY; a provider failure never proves eviction.
  const observed = await params.provider.observeTransaction(session.txid, {
    retry: false,
    signal: AbortSignal.timeout(5000),
  });
  if (observed.state !== "mempool" && observed.state !== "mined") {
    const { plan, config } = storedPlan(session);
    const ledger = await context(params, session, config);
    const transaction = { rawHex: session.signedRawHex, prevouts: plan.inputs };
    core.validateFinalTransaction(plan, transaction, ledger);
    await assertLive(params, ledger, transaction, network);
    try {
      await broadcastRecordedTransaction(
        params.provider,
        { rawTxHex: session.signedRawHex, txid: session.txid },
        params.network,
        network,
      );
    } catch (error) {
      throw new AppError(
        "BROADCAST_FAILED",
        error instanceof Error ? error.message : "CRC transaction could not be broadcast",
      );
    }
  }
  await markCrcBuildBroadcast(params.db, params.network, params.sessionId, session.txid);
  return { txid: session.txid, status: "BROADCAST" as const };
}
export function finalizeCrcPsbt(psbt: bitcoin.Psbt): bitcoin.Transaction {
  // Serialization only; submit always performs ledger-aware core verification afterward.
  for (let index = 0; index < psbt.inputCount; index++) {
    const input = psbt.data.inputs[index]!;
    if (input.finalScriptWitness || input.finalScriptSig) continue;
    if (input.tapKeySig)
      psbt.updateInput(index, {
        finalScriptWitness: Buffer.from(core.encodeWitness([input.tapKeySig]), "hex"),
      });
    else psbt.finalizeInput(index);
  }
  return psbt.extractTransaction();
}
export type CrcReadyTransaction = {
  network: CrcNetwork;
  status: "READY" | "BROADCAST";
  rawTxHex: string;
  txid: string;
};
function readyReceipt(params: SubmitParams, session: Session): CrcReadyTransaction {
  if (
    !session.signedRawHex ||
    !session.txid ||
    readyTransactionId(session.signedRawHex, session.psbtBase64) !== session.txid
  )
    throw new Error("Stored CRC transaction identity mismatch");
  return {
    network: params.network,
    status: session.status === "BROADCAST" ? "BROADCAST" : "READY",
    rawTxHex: session.signedRawHex,
    txid: session.txid,
  };
}
export async function prepareCrcSession(params: SubmitParams): Promise<CrcReadyTransaction> {
  return completeCrcSession(params, true) as Promise<CrcReadyTransaction>;
}
/** Regtest fixture relay. Public HTTP routes exclusively use preparation. */
export async function submitCrcSession(
  params: SubmitParams,
): Promise<{ txid: string; status: "BROADCAST" }> {
  return completeCrcSession(params, false) as Promise<{ txid: string; status: "BROADCAST" }>;
}
async function completeCrcSession(params: SubmitParams, clientBroadcast: boolean) {
  const session = await getCrcBuildSession(params.db, params.network, params.sessionId);
  if (!session || !operationMatches(session.operation, params.expectedOperation))
    throw new AppError("CLIENT_INTENT_MISMATCH", "Unknown CRC build session or operation");
  if (
    (session.status === "READY" || session.status === "BROADCAST") &&
    session.signedRawHex &&
    session.txid
  )
    return clientBroadcast ? readyReceipt(params, session) : broadcastReady(params, session);
  if (session.expiresAt.getTime() <= Date.now())
    throw new AppError("STATE_CHANGED", "CRC build session expired");
  if (params.signedPsbtBase64.length > 750000)
    throw new AppError("REQUEST_TOO_LARGE", "signed PSBT exceeds transport limit");
  const { plan, config, data } = storedPlan(session);
  let ledger = await context(params, session, config);
  const escrowPending =
    ["purchase", "cancel"].includes(session.operation) &&
    typeof data.offerId === "string" &&
    !!ledger.offers[data.offerId]?.escrowTerms;
  const guardianPending =
    escrowPending || ["mint-buy", "inventory-buy", "sell"].includes(session.operation);
  let verified: ReturnType<typeof completeServerWalletSigning>;
  try {
    verified = completeServerWalletSigning(
      plan,
      params.network,
      session.psbtBase64,
      params.signedPsbtBase64,
      ledger,
      guardianPending,
    );
  } catch (error) {
    throw new AppError(
      "WALLET_SIGNATURE_INVALID",
      error instanceof Error ? error.message : "CRC wallet signature is invalid",
    );
  }
  if (
    guardianPending &&
    verified.transition?.kind !==
      (
        {
          "mint-buy": "mint",
          "inventory-buy": "inventoryBuy",
          sell: "sell",
          purchase: "fill",
          cancel: "transfer",
        } as Record<string, string>
      )[session.operation]
  )
    throw new AppError("CLIENT_INTENT_MISMATCH", "CRC operation differs from core transition");
  if (["mint-buy", "inventory-buy"].includes(session.operation)) {
    const transition = verified.transition!;
    if (
      data.operation !== session.operation ||
      data.amountAtoms !== transition.amountAtoms!.toString()
    )
      throw new AppError(
        "CLIENT_INTENT_MISMATCH",
        "CRC buy receipt differs from signed transition",
      );
    const asset = ledger.assets[session.deploymentTxid!]!;
    const amounts = core.curveBuyAmounts(asset, transition.amountAtoms!);
    const mixed = amounts.inventoryBuyAtoms > 0n && amounts.newlyMintedAtoms > 0n;
    for (const field of ["inventoryBuyAtoms", "newlyMintedAtoms"] as const)
      if ((mixed || field in data) && data[field] !== amounts[field].toString())
        throw new AppError(
          "CLIENT_INTENT_MISMATCH",
          "CRC buy inventory breakdown differs from signed transition",
        );
  }
  const signedHash = createHash("sha256").update(params.signedPsbtBase64).digest("hex");
  const claim = await claimCrcBuildSession(params.db, params.network, params.sessionId, signedHash);
  if (!claim?.claimId)
    throw new AppError("STATE_CHANGED", "CRC build session is already signing or expired");
  try {
    await timed(params, "live_before_sign", () => assertLive(params, ledger, verified.transaction));
    let transaction = verified.transaction;
    if (guardianPending) {
      let response: Response;
      try {
        response = await timed(params, "guardian", () =>
          fetch(new URL("/sign/crc20", params.guardianEndpoint), {
            method: "POST",
            headers: {
              authorization: `Bearer ${params.guardianAuthToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              requestId: session.id,
              network: params.network,
              deploymentTxid: session.deploymentTxid,
              operation: escrowPending ? `escrow-${session.operation}` : session.operation,
              psbtBase64: verified.psbtBase64,
            }),
            signal: AbortSignal.timeout(30000),
          }),
        );
      } catch (error) {
        throw new AppError(
          "GUARDIAN_UNAVAILABLE",
          error instanceof Error ? error.message : "CRC Guardian unavailable",
        );
      }
      const result = (await response.json().catch(() => null)) as {
        ok?: boolean;
        signedPsbtBase64?: string;
        unsignedTxDigest?: string;
        detail?: string;
      } | null;
      if (response.status >= 500)
        throw new AppError("GUARDIAN_UNAVAILABLE", "CRC Guardian unavailable");
      if (
        !response.ok ||
        !result?.ok ||
        !result.signedPsbtBase64 ||
        result.unsignedTxDigest !== session.unsignedTxDigest
      )
        throw new AppError(
          "GUARDIAN_REJECTED",
          result?.detail ?? "CRC Guardian rejected transition",
        );
      ledger = await context(params, session, config);
      try {
        const signed = completeServerWalletSigning(
          plan,
          params.network,
          session.psbtBase64,
          result.signedPsbtBase64,
          ledger,
        );
        // The custody journal may return an earlier valid wallet signature for this
        // unsigned transaction. Reuse only its verified vault witness; retain the
        // current wallet's witness and scriptSig, then validate the merged transaction.
        const current = bitcoin.Psbt.fromBase64(verified.psbtBase64),
          custody = bitcoin.Psbt.fromBase64(signed.psbtBase64).data.inputs[0]!;
        current.updateInput(0, { finalScriptWitness: custody.finalScriptWitness });
        transaction = completeServerWalletSigning(
          plan,
          params.network,
          session.psbtBase64,
          current.toBase64(),
          ledger,
        ).transaction;
      } catch (error) {
        throw new AppError(
          "GUARDIAN_REJECTED",
          error instanceof Error ? error.message : "Invalid CRC Guardian signature",
        );
      }
    }
    ledger = await context(params, session, config);
    core.validateFinalTransaction(plan, transaction, ledger);
    const network = await timed(params, "live_before_ready", () =>
      assertLive(params, ledger, transaction),
    );
    const txid = core.parseRawTransaction(transaction.rawHex).txid;
    if (session.operation === "deploy") {
      await saveCrcRegistration(params.db, config, transaction);
      await saveCrcLaunchMetadata(
        params.db,
        params.network,
        txid,
        session.walletScriptHex,
        parseCrcLaunchMetadata(data.metadata, config.ticker),
      );
    }
    if (session.operation === "listing" && data.escrowTerms) {
      const terms = core.decodeProtocolDto<core.EscrowTerms>(data.escrowTerms);
      const output = plan.outputs[1]!;
      await saveCrcEscrowAuthorization(
        params.db,
        core.escrowOffer(terms, { txid, vout: 1, ...output }),
        transaction,
      );
    }
    await markCrcBuildReady(
      params.db,
      params.network,
      params.sessionId,
      transaction.rawHex,
      txid,
      claim.claimId,
    );
    if (clientBroadcast)
      return {
        network: params.network,
        status: "READY" as const,
        rawTxHex: transaction.rawHex,
        txid,
      };
    // Fresh submission already has a verified current transaction and live
    // fence. Persist READY before I/O, but leave observation/reconstruction to
    // the recovery path; a lost response is retried from these exact bytes.
    try {
      await timed(params, "broadcast", () =>
        broadcastRecordedTransaction(
          params.provider,
          { rawTxHex: transaction.rawHex, txid },
          params.network,
          network,
        ),
      );
    } catch (error) {
      throw new AppError(
        "BROADCAST_FAILED",
        error instanceof Error ? error.message : "CRC transaction could not be broadcast",
      );
    }
    await markCrcBuildBroadcast(params.db, params.network, params.sessionId, txid);
    return { txid, status: "BROADCAST" };
  } catch (error) {
    await releaseCrcBuildSession(params.db, params.network, params.sessionId, claim.claimId);
    throw error;
  }
}
