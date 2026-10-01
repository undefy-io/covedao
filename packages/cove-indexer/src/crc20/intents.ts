import { createHash } from "node:crypto";
import { Transaction } from "bitcoinjs-lib";
import { and, eq, inArray } from "drizzle-orm";
import { parseCrc20Transaction, type BitcoinNetwork } from "@crclaunch/crc20-base";
import { dustThreshold } from "@crclaunch/cove-economics";
import { schema, type Database } from "@crclaunch/db";

export type TrustedCrcLaunch = Readonly<{
  launchSaltHex: string;
  vaultScriptHex: string;
  creatorScriptHex: string;
  protocolScriptHex: string;
  vaultAnchorSats: number;
}>;

export type CrcLaunchIntent = TrustedCrcLaunch & Readonly<{
  network: BitcoinNetwork;
  txid: string;
  ticker: string;
  signedRawHex: string;
  rawSha256: string;
}>;

const hex = /^(?:[0-9a-f]{2})+$/;
const saltPattern = /^[0-9a-f]{64}$/;

function exact(output: Transaction["outs"][number] | undefined, sats: number, scriptHex: string): boolean {
  return !!output && output.value === sats && output.script.toString("hex") === scriptHex;
}

export function prepareCrcLaunchIntent(network: BitcoinNetwork, signedRawHex: string, trusted: TrustedCrcLaunch): CrcLaunchIntent {
  if (!/^(mainnet|testnet|signet|regtest)$/.test(network) || !hex.test(signedRawHex)) throw new Error("invalid Cove launch network or raw transaction");
  if (!saltPattern.test(trusted.launchSaltHex) || /^0+$/.test(trusted.launchSaltHex)) throw new Error("invalid Cove launch salt");
  for (const scriptHex of [trusted.vaultScriptHex, trusted.creatorScriptHex, trusted.protocolScriptHex]) {
    if (!hex.test(scriptHex)) throw new Error("invalid Cove launch script");
  }
  if (trusted.vaultScriptHex === trusted.creatorScriptHex || trusted.vaultScriptHex === trusted.protocolScriptHex ||
    !trusted.vaultScriptHex.startsWith("5120") || trusted.vaultScriptHex.length !== 68 ||
    !Number.isSafeInteger(trusted.vaultAnchorSats) || trusted.vaultAnchorSats <= 0) {
    throw new Error("invalid Cove launch vault");
  }
  let tx: Transaction;
  try { tx = Transaction.fromHex(signedRawHex); } catch { throw new Error("invalid Cove launch transaction"); }
  if (!tx.ins.length || tx.ins.some((input) => input.script.length === 0 && input.witness.length === 0)) {
    throw new Error("Cove launch transaction has unsigned inputs");
  }
  if (tx.outs.length !== 4 && tx.outs.length !== 5) throw new Error("invalid Cove launch output count");
  const outputs = tx.outs.map((output) => ({ valueSats: output.value, scriptHex: output.script.toString("hex") }));
  const parsed = parseCrc20Transaction(outputs);
  if (parsed.status !== "valid" || parsed.envelope.kind !== "deploy" ||
    Object.keys(parsed.envelope.payload).sort().join(",") !== "cv,max,op,p,tick,type" ||
    parsed.envelope.payload.p !== "crc-20" || parsed.envelope.payload.op !== "deploy" ||
    parsed.envelope.payload.type !== "bonding" || parsed.envelope.payload.max !== "2100000000000000" ||
    parsed.envelope.payload.cv !== "cove-curve-v3" ||
    tx.outs[0]!.script.length > 260) {
    throw new Error("invalid Cove deployment marker");
  }
  if (!exact(tx.outs[1], trusted.vaultAnchorSats, trusted.vaultScriptHex) ||
    !exact(tx.outs[2], 1000, trusted.creatorScriptHex) ||
    !exact(tx.outs[3], 7000, trusted.protocolScriptHex) ||
    BigInt(trusted.vaultAnchorSats) < dustThreshold(Buffer.from(trusted.vaultScriptHex, "hex")) ||
    BigInt(1000) < dustThreshold(Buffer.from(trusted.creatorScriptHex, "hex")) ||
    BigInt(7000) < dustThreshold(Buffer.from(trusted.protocolScriptHex, "hex"))) {
    throw new Error("Cove launch outputs do not match trusted configuration");
  }
  if (tx.outs[4] && (tx.outs[4].script[0] === 0x6a || BigInt(tx.outs[4].value) < dustThreshold(tx.outs[4].script))) {
    throw new Error("invalid Cove launch change output");
  }
  const canonicalRawHex = tx.toHex();
  return {
    network, txid: tx.getId(), ticker: parsed.envelope.ticker, signedRawHex: canonicalRawHex,
    rawSha256: createHash("sha256").update(Buffer.from(canonicalRawHex, "hex")).digest("hex"),
    ...trusted,
  };
}

export async function saveAuthorizedCrcLaunchIntent(db: Database, network: BitcoinNetwork, signedRawHex: string, trusted: TrustedCrcLaunch): Promise<CrcLaunchIntent> {
  const intent = prepareCrcLaunchIntent(network, signedRawHex, trusted);
  await db.insert(schema.coveCrcLaunchIntents).values({
    ...intent, vaultAnchorSats: BigInt(intent.vaultAnchorSats),
  }).onConflictDoNothing({ target: [schema.coveCrcLaunchIntents.network, schema.coveCrcLaunchIntents.txid] });
  const [row] = await db.select().from(schema.coveCrcLaunchIntents).where(and(eq(schema.coveCrcLaunchIntents.network, network), eq(schema.coveCrcLaunchIntents.txid, intent.txid)));
  if (!row || row.rawSha256 !== intent.rawSha256 || row.launchSaltHex !== intent.launchSaltHex ||
    row.vaultScriptHex !== intent.vaultScriptHex || row.creatorScriptHex !== intent.creatorScriptHex ||
    row.protocolScriptHex !== intent.protocolScriptHex || row.vaultAnchorSats !== BigInt(intent.vaultAnchorSats)) {
    throw new Error("conflicting Cove launch intent for transaction id");
  }
  return intent;
}

export async function loadAuthorizedCrcRegistrations(db: Database, network: BitcoinNetwork, configuredProtocolScriptHex: string, txids?: readonly string[]): Promise<TrustedCrcLaunchRegistration[]> {
  if (!hex.test(configuredProtocolScriptHex)) throw new Error("invalid configured Cove protocol script");
  if (txids && txids.length === 0) return [];
  if (txids?.some((txid) => !saltPattern.test(txid))) throw new Error("invalid CRC block transaction id");
  const rows = await db.select().from(schema.coveCrcLaunchIntents).where(txids
    ? and(eq(schema.coveCrcLaunchIntents.network, network), inArray(schema.coveCrcLaunchIntents.txid, [...txids]))
    : eq(schema.coveCrcLaunchIntents.network, network));
  return rows.map((row) => {
    if (row.protocolScriptHex !== configuredProtocolScriptHex) throw new Error(`Cove launch intent ${row.txid} has wrong protocol script`);
    const intent = prepareCrcLaunchIntent(network, row.signedRawHex, {
      launchSaltHex: row.launchSaltHex, vaultScriptHex: row.vaultScriptHex,
      creatorScriptHex: row.creatorScriptHex, protocolScriptHex: row.protocolScriptHex,
      vaultAnchorSats: Number(row.vaultAnchorSats),
    });
    if (intent.txid !== row.txid || intent.rawSha256 !== row.rawSha256 || intent.ticker !== row.ticker) throw new Error("Cove launch intent row is inconsistent");
    return { network, txid: row.txid, vaultScriptHex: row.vaultScriptHex, creatorScriptHex: row.creatorScriptHex, protocolScriptHex: row.protocolScriptHex, vaultAnchorSats: Number(row.vaultAnchorSats), launchSaltHex: row.launchSaltHex, rawSha256: row.rawSha256 };
  });
}

export async function hasAuthorizedCrcLaunchIntent(db: Database, network: BitcoinNetwork): Promise<boolean> {
  const rows = await db.select({ txid: schema.coveCrcLaunchIntents.txid }).from(schema.coveCrcLaunchIntents).where(eq(schema.coveCrcLaunchIntents.network, network)).limit(1);
  return rows.length > 0;
}

export type TrustedCrcLaunchRegistration = Readonly<{ network: BitcoinNetwork; txid: string; vaultScriptHex: string; creatorScriptHex: string; protocolScriptHex: string; vaultAnchorSats: number; launchSaltHex: string; rawSha256: string }>;
