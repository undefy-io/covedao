import * as core from "@crclaunch/crc20-protocol";

export type FundingOutpoint = { txid: string; vout: number };
export type CrcFundingEvidence = { version: 1; network: string; parents: { txid: string; rawHex: string }[] };
export const MAX_FUNDING_PARENT_HEX = 200_000;
class InvalidEvidence extends Error {
  readonly code = "FUNDING_INPUT_INVALID";
  constructor() { super("Invalid wallet funding evidence"); this.name = "AppError"; }
}
function invalid(): never { throw new InvalidEvidence(); }
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid();
  return value as Record<string, unknown>;
}

/** Immutable candidate facts only. This never proves confirmation or present unspent status. */
export function verifyFundingEvidence(
  value: unknown, network: string, candidates: readonly FundingOutpoint[], walletScriptHex: string,
): core.Input[] | undefined {
  if (value === undefined) return undefined;
  try {
    if (candidates.length > 40 || new Set(candidates.map(core.outpoint)).size !== candidates.length) invalid();
    const envelope = exact(value, ["version", "network", "parents"]);
    if (envelope.version !== 1 || envelope.network !== network || !Array.isArray(envelope.parents) || envelope.parents.length > 40) invalid();
    const expected = new Set(candidates.map(row => row.txid));
    const parents = new Map<string, ReturnType<typeof core.parseRawTransaction>>();
    let characters = 0;
    for (const item of envelope.parents) {
      const parent = exact(item, ["txid", "rawHex"]);
      if (typeof parent.txid !== "string" || !/^[0-9a-f]{64}$/.test(parent.txid) ||
        !expected.has(parent.txid) || parents.has(parent.txid) || typeof parent.rawHex !== "string" ||
        !parent.rawHex.length || parent.rawHex.length > MAX_FUNDING_PARENT_HEX) invalid();
      characters += parent.rawHex.length;
      if (characters > MAX_FUNDING_PARENT_HEX) invalid();
      const parsed = core.parseRawTransaction(parent.rawHex);
      if (parsed.txid !== parent.txid) invalid();
      parents.set(parent.txid, parsed);
    }
    if (parents.size !== expected.size) invalid();
    return candidates.map(input => {
      if (!Number.isSafeInteger(input.vout) || input.vout < 0) invalid();
      const output = parents.get(input.txid)?.outputs[input.vout];
      if (!output || output.scriptHex !== walletScriptHex) invalid();
      return { ...input, sats: core.sats(output.sats), scriptHex: output.scriptHex };
    });
  } catch { return invalid(); }
}
