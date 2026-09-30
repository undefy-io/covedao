import { createHash } from "node:crypto";
import { broadcastRecordedTransaction, type CoreRpcProvider } from "@crclaunch/bitcoin";
import { AppError } from "@crclaunch/cove-app";
import { saveAuthorizedCrcLaunchIntent } from "@crclaunch/cove-indexer/crc20";
import { verifyCrcGuardianSignedPsbt, verifyCrcWalletSignedPsbt } from "@crclaunch/crc20-transactions";
import type { Database } from "@crclaunch/db";
import { claimCrcBuildSession, getCrcBuildSession, markCrcBuildBroadcast, markCrcBuildReady } from "./crc-session";
import type { CrcNetwork } from "./crc-read";

type SubmitParams = {
  db: Database;
  network: CrcNetwork;
  sessionId: string;
  signedPsbtBase64: string;
  provider: CoreRpcProvider;
  guardianEndpoint: string;
  guardianAuthToken: string;
  expectedOperation?: "deploy" | "buy" | "sell";
};

async function broadcastReady(params: SubmitParams, rawHex: string, txid: string) {
  try {
    await broadcastRecordedTransaction(params.provider, { rawTxHex: rawHex, txid }, params.network);
  } catch (error) {
    throw new AppError("BROADCAST_FAILED", error instanceof Error ? error.message : "CRC transaction could not be broadcast");
  }
  await markCrcBuildBroadcast(params.db, params.network, params.sessionId, txid);
  return { txid, status: "BROADCAST" as const };
}

function operationMatches(actual: string, expected: SubmitParams["expectedOperation"]): boolean {
  if (!expected) return true;
  return expected === "buy" ? actual === "mint-buy" || actual === "inventory-buy" : actual === expected;
}

async function checkLiveWalletInputs(provider: CoreRpcProvider, psbt: ReturnType<typeof verifyCrcWalletSignedPsbt>["psbt"]) {
  for (let index = 0; index < psbt.txInputs.length; index++) {
    const input = psbt.txInputs[index]!;
    const txid = Buffer.from(input.hash).reverse().toString("hex");
    const observed = await provider.getTxout(txid, input.index);
    const expected = psbt.data.inputs[index]!.witnessUtxo;
    if (!observed || !expected || observed.confirmations < 1 ||
      observed.valueSats !== BigInt(expected.value) ||
      observed.scriptPubKeyHex.toLowerCase() !== expected.script.toString("hex")) {
      throw new AppError("STATE_CHANGED", `CRC funding input ${index} is no longer a confirmed matching UTXO`);
    }
  }
}

function launchTrust(value: Record<string, unknown>) {
  const { launchSaltHex, vaultScriptHex, creatorScriptHex, protocolScriptHex, vaultAnchorSats } = value;
  if (typeof launchSaltHex !== "string" || typeof vaultScriptHex !== "string" ||
    typeof creatorScriptHex !== "string" || typeof protocolScriptHex !== "string" ||
    typeof vaultAnchorSats !== "number") throw new AppError("CLIENT_INTENT_MISMATCH", "CRC launch trust record is incomplete");
  return { launchSaltHex, vaultScriptHex, creatorScriptHex, protocolScriptHex, vaultAnchorSats };
}

export async function submitCrcSession(params: SubmitParams): Promise<{ txid: string; status: "BROADCAST" }> {
  const session = await getCrcBuildSession(params.db, params.network, params.sessionId);
  if (!session || !operationMatches(session.operation, params.expectedOperation)) {
    throw new AppError("CLIENT_INTENT_MISMATCH", "Unknown CRC build session or operation");
  }
  if (session.status === "BROADCAST" && session.txid) return { txid: session.txid, status: "BROADCAST" };
  if (session.status === "READY" && session.signedRawHex && session.txid) {
    return broadcastReady(params, session.signedRawHex, session.txid);
  }
  if (session.expiresAt.getTime() <= Date.now()) throw new AppError("STATE_CHANGED", "CRC build session expired");
  if (params.signedPsbtBase64.length > 1_000_000) throw new AppError("REQUEST_TOO_LARGE", "signed PSBT exceeds 1 MB");
  const isDeploy = session.operation === "deploy";
  let verified: ReturnType<typeof verifyCrcWalletSignedPsbt>;
  try {
    verified = verifyCrcWalletSignedPsbt(session.psbtBase64, params.signedPsbtBase64, params.network, isDeploy ? undefined : 0);
  } catch (error) {
    throw new AppError("WALLET_SIGNATURE_INVALID", error instanceof Error ? error.message : "CRC wallet signature is invalid");
  }
  if (verified.unsignedTxDigest !== session.unsignedTxDigest) {
    throw new AppError("PSBT_MUTATED", "CRC unsigned transaction digest changed");
  }
  const signedHash = createHash("sha256").update(params.signedPsbtBase64).digest("hex");
  const claimed = await claimCrcBuildSession(params.db, params.network, params.sessionId, signedHash);
  if (!claimed) throw new AppError("STATE_CHANGED", "CRC build session is already signing or expired");
  let psbt = verified.psbt;
  if (isDeploy) {
    await checkLiveWalletInputs(params.provider, psbt);
  } else {
    let response: Response;
    try {
      response = await fetch(new URL("/sign/crc20", params.guardianEndpoint), {
        method: "POST",
        headers: { authorization: `Bearer ${params.guardianAuthToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          requestId: session.id, network: params.network, deploymentTxid: session.deploymentTxid,
          operation: session.operation, psbtBase64: params.signedPsbtBase64,
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new AppError("GUARDIAN_UNAVAILABLE", error instanceof Error ? error.message : "CRC Guardian is unavailable");
    }
    const result = await response.json().catch(() => null) as null | {
      ok?: boolean; signedPsbtBase64?: string; unsignedTxDigest?: string; detail?: string;
    };
    if (!response.ok && response.status >= 500) throw new AppError("GUARDIAN_UNAVAILABLE", "CRC Guardian is unavailable");
    if (!response.ok || !result?.ok || !result.signedPsbtBase64 ||
      result.unsignedTxDigest !== session.unsignedTxDigest) {
      throw new AppError("GUARDIAN_REJECTED", result?.detail || "CRC Guardian rejected the transition");
    }
    try {
      psbt = verifyCrcGuardianSignedPsbt(params.signedPsbtBase64, result.signedPsbtBase64, params.network).psbt;
    } catch (error) {
      throw new AppError("GUARDIAN_REJECTED", error instanceof Error ? error.message : "CRC Guardian signature is invalid");
    }
  }
  psbt.finalizeAllInputs();
  const tx = psbt.extractTransaction();
  const signedRawHex = tx.toHex();
  const txid = tx.getId();
  if (isDeploy) {
    await saveAuthorizedCrcLaunchIntent(params.db, params.network, signedRawHex,
      launchTrust(session.trustedJson as Record<string, unknown>));
  }
  await markCrcBuildReady(params.db, params.network, params.sessionId, signedRawHex, txid);
  return broadcastReady(params, signedRawHex, txid);
}
