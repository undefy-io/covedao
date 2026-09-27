/**
 * Funding-input checks the Guardian runs before it signs a vault transition.
 *
 * A MINT or REDEEM may carry the user's own BTC inputs to pay for it. The
 * Guardian refuses any such input that is:
 *
 * - UNCONFIRMED. The vault chains: the next mint spends this one's successor
 *   vault output. If a funding input is still in the mempool, its owner can
 *   double-spend it, which drops this transition and every later transition
 *   that other users built on top of it.
 * - HOLDING TOKENS of any kind: a Cove carrier (of any token), an inscription
 *   or a rune. Spent as plain BTC, whatever it holds is destroyed.
 *
 * Every check fails closed: if a source cannot answer, the input is refused.
 */

export interface OutPointRef {
  txid: string;
  vout: number;
}

export type FundingInputCode =
  | "FUNDING_UNCONFIRMED"
  | "FUNDING_HOLDS_TOKEN"
  | "FUNDING_CHECK_UNAVAILABLE"
  | "FUNDING_PREVOUT_MISMATCH";

export type FundingInputVerdict =
  { ok: true } | { ok: false; code: FundingInputCode; detail: string };

export interface FundingInputChecker {
  check(
    outpoint: OutPointRef,
    indexedHeight?: bigint,
    expected?: { script: Buffer; valueSats: bigint },
  ): Promise<FundingInputVerdict>;
}

/** The one Core call the checker needs (`gettxout`, mempool included). */
export interface TxOutReader {
  getTxout(
    txid: string,
    vout: number,
  ): Promise<{ confirmations: number; scriptPubKeyHex?: string; valueSats?: bigint } | null>;
  getBlockchainInfo?(): Promise<{ blocks: number }>;
}

/** Names what an outpoint holds besides BTC (inscriptions, runes), or null when nothing. */
export interface AssetLookup {
  describeAssets(outpoint: OutPointRef): Promise<string | null>;
}

const refuse = (code: FundingInputCode, detail: string): FundingInputVerdict => ({
  ok: false,
  code,
  detail,
});

/**
 * The production checker: Core for confirmation, the Cove index for carriers
 * of any token, and (when given) an ord server for inscriptions and runes.
 */
export function chainFundingChecker(params: {
  chain: TxOutReader;
  /** True when the outpoint is a live Cove carrier of ANY token. */
  isCoveCarrier: (outpoint: OutPointRef) => Promise<boolean>;
  /** Inscriptions and runes. Required on mainnet (the caller enforces that). */
  assets?: AssetLookup;
  minConfirmations?: number;
}): FundingInputChecker {
  const minConf = params.minConfirmations ?? 1;
  return {
    async check(o, indexedHeight, expected) {
      const at = `${o.txid}:${o.vout}`;
      let txout: { confirmations: number; scriptPubKeyHex?: string; valueSats?: bigint } | null;
      try {
        txout = await params.chain.getTxout(o.txid, o.vout);
      } catch (e) {
        return refuse(
          "FUNDING_CHECK_UNAVAILABLE",
          `could not look up ${at}: ${(e as Error).message}`,
        );
      }
      if (!txout) return refuse("FUNDING_UNCONFIRMED", `funding input ${at} is spent or unknown`);
      if (
        expected &&
        (txout.valueSats !== expected.valueSats ||
          txout.scriptPubKeyHex?.toLowerCase() !== expected.script.toString("hex"))
      ) {
        return refuse(
          "FUNDING_PREVOUT_MISMATCH",
          `funding input ${at} does not match its real Core prevout`,
        );
      }
      if (txout.confirmations < minConf) {
        return refuse(
          "FUNDING_UNCONFIRMED",
          `funding input ${at} is unconfirmed; wait for it to confirm`,
        );
      }
      // A confirmed carrier is still unknown to the indexer until its block is
      // indexed. Do not treat it as plain BTC during that gap.
      if (indexedHeight !== undefined) {
        if (!params.chain.getBlockchainInfo)
          return refuse(
            "FUNDING_CHECK_UNAVAILABLE",
            "cannot compare funding confirmation with indexer cursor",
          );
        let coreHeight: bigint;
        try {
          coreHeight = BigInt((await params.chain.getBlockchainInfo()).blocks);
        } catch (e) {
          return refuse(
            "FUNDING_CHECK_UNAVAILABLE",
            `could not read Core height: ${(e as Error).message}`,
          );
        }
        const requiredConfirmations = coreHeight - indexedHeight + 1n;
        if (BigInt(txout.confirmations) < requiredConfirmations) {
          return refuse(
            "FUNDING_UNCONFIRMED",
            `funding input ${at} is newer than the indexed chain state`,
          );
        }
      }
      try {
        if (await params.isCoveCarrier(o))
          return refuse("FUNDING_HOLDS_TOKEN", `funding input ${at} holds Cove tokens`);
      } catch (e) {
        return refuse(
          "FUNDING_CHECK_UNAVAILABLE",
          `could not check ${at} for Cove tokens: ${(e as Error).message}`,
        );
      }
      if (params.assets) {
        let held: string | null;
        try {
          held = await params.assets.describeAssets(o);
        } catch (e) {
          return refuse(
            "FUNDING_CHECK_UNAVAILABLE",
            `could not check ${at} for inscriptions and runes: ${(e as Error).message}`,
          );
        }
        if (held) return refuse("FUNDING_HOLDS_TOKEN", `funding input ${at} holds ${held}`);
      }
      return { ok: true };
    },
  };
}

/**
 * Inscriptions and runes from an ord server's JSON API
 * (`GET /output/<txid>:<vout>` with `Accept: application/json`). An output ord
 * has not indexed, or a reply without both fields, is an error, not "clean".
 */
export function ordAssetLookup(
  baseUrl: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): AssetLookup {
  const base = baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  return {
    async describeAssets(o) {
      const res = await doFetch(`${base}/output/${o.txid}:${o.vout}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`ord replied ${res.status}`);
      const body = (await res.json()) as {
        indexed?: unknown;
        inscriptions?: unknown;
        runes?: unknown;
      };
      if (body.indexed === false) throw new Error("ord has not indexed this output yet");
      if (!Array.isArray(body.inscriptions)) throw new Error("ord reply has no inscriptions list");
      const runes = body.runes;
      const runeCount = Array.isArray(runes)
        ? runes.length
        : runes && typeof runes === "object"
          ? Object.keys(runes).length
          : -1;
      if (runeCount < 0) throw new Error("ord reply has no runes field (is ord indexing runes?)");
      const held: string[] = [];
      if (body.inscriptions.length > 0) held.push(`${body.inscriptions.length} inscription(s)`);
      if (runeCount > 0) held.push(`${runeCount} rune(s)`);
      return held.length > 0 ? held.join(" and ") : null;
    },
  };
}
