import { describe, expect, it, vi } from "vitest";
import { chainFundingChecker, ordAssetLookup, type TxOutReader } from "./funding.js";

const O = { txid: "ab".repeat(32), vout: 1 };
const chain = (confirmations: number | null): TxOutReader => ({
  getTxout: async () => (confirmations === null ? null : { confirmations }),
});
const noCarrier = async () => false;
const ordReply = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("chainFundingChecker", () => {
  it("accepts a confirmed, token-free input", async () => {
    expect(
      await chainFundingChecker({ chain: chain(1), isCoveCarrier: noCarrier }).check(O),
    ).toEqual({ ok: true });
  });

  it("refuses an unconfirmed input (mempool, 0 confirmations)", async () => {
    const v = await chainFundingChecker({ chain: chain(0), isCoveCarrier: noCarrier }).check(O);
    expect(v).toMatchObject({ ok: false, code: "FUNDING_UNCONFIRMED" });
  });

  it("refuses a spent or unknown input", async () => {
    const v = await chainFundingChecker({ chain: chain(null), isCoveCarrier: noCarrier }).check(O);
    expect(v).toMatchObject({ ok: false, code: "FUNDING_UNCONFIRMED" });
  });

  it("refuses a Cove carrier of any token", async () => {
    const v = await chainFundingChecker({ chain: chain(6), isCoveCarrier: async () => true }).check(
      O,
    );
    expect(v).toMatchObject({ ok: false, code: "FUNDING_HOLDS_TOKEN" });
  });

  it("fails closed when the node cannot answer", async () => {
    const broken: TxOutReader = {
      getTxout: async () => {
        throw new Error("rpc down");
      },
    };
    const v = await chainFundingChecker({ chain: broken, isCoveCarrier: noCarrier }).check(O);
    expect(v).toMatchObject({ ok: false, code: "FUNDING_CHECK_UNAVAILABLE" });
  });

  it("fails closed when the Cove index cannot answer", async () => {
    const v = await chainFundingChecker({
      chain: chain(3),
      isCoveCarrier: async () => {
        throw new Error("db down");
      },
    }).check(O);
    expect(v).toMatchObject({ ok: false, code: "FUNDING_CHECK_UNAVAILABLE" });
  });

  it("refuses inputs holding inscriptions or runes, and fails closed when ord is down", async () => {
    const withAssets = (describeAssets: () => Promise<string | null>) =>
      chainFundingChecker({
        chain: chain(2),
        isCoveCarrier: noCarrier,
        assets: { describeAssets },
      }).check(O);
    expect(await withAssets(async () => "1 inscription(s)")).toMatchObject({
      ok: false,
      code: "FUNDING_HOLDS_TOKEN",
    });
    expect(
      await withAssets(async () => {
        throw new Error("ord down");
      }),
    ).toMatchObject({ ok: false, code: "FUNDING_CHECK_UNAVAILABLE" });
    expect(await withAssets(async () => null)).toEqual({ ok: true });
  });

  it("honours a higher confirmation floor", async () => {
    const v = await chainFundingChecker({
      chain: chain(2),
      isCoveCarrier: noCarrier,
      minConfirmations: 3,
    }).check(O);
    expect(v).toMatchObject({ ok: false, code: "FUNDING_UNCONFIRMED" });
  });

  it("refuses a confirmed input mined after the indexer cursor", async () => {
    const reader: TxOutReader = {
      getTxout: async () => ({
        confirmations: 1,
        bestBlockHash: "aa".repeat(32),
        scriptPubKeyHex: "0014" + "ab".repeat(20),
        valueSats: 1_000n,
      }),
      getBlockchainInfo: async () => ({ blocks: 101, bestBlockHash: "aa".repeat(32) }),
    };
    const checker = chainFundingChecker({ chain: reader, isCoveCarrier: noCarrier });
    expect(await checker.check(O, 100n)).toMatchObject({ ok: false, code: "FUNDING_UNCONFIRMED" });
    expect(await checker.check(O, 101n)).toEqual({ ok: true });
  });

  it("refuses a PSBT prevout that differs from Core", async () => {
    const reader: TxOutReader = {
      getTxout: async () => ({
        confirmations: 5,
        scriptPubKeyHex: "0014" + "ab".repeat(20),
        valueSats: 1_000n,
      }),
    };
    const checker = chainFundingChecker({ chain: reader, isCoveCarrier: noCarrier });
    expect(
      await checker.check(O, undefined, {
        script: Buffer.from("0014" + "ab".repeat(20), "hex"),
        valueSats: 1_001n,
      }),
    ).toMatchObject({ ok: false, code: "FUNDING_PREVOUT_MISMATCH" });
  });
});

describe("funding validation observation scope", () => {
  function reader() {
    return {
      getBlockchainInfo: vi.fn(async () => ({
        blocks: 100,
        bestBlockHash: "aa".repeat(32),
        chain: "regtest",
      })),
      getTxout: vi.fn(async () => ({
        confirmations: 6,
        bestBlockHash: "aa".repeat(32),
        valueSats: 1_000n,
        scriptPubKeyHex: "0014" + "ab".repeat(20),
      })),
    };
  }

  it("shares one height/hash per validation while rechecking every live prevout", async () => {
    const rpc = reader();
    const checker = chainFundingChecker({ chain: rpc, isCoveCarrier: noCarrier });
    const scope = checker.forValidation!();
    expect(await scope.check(O, 100n)).toEqual({ ok: true });
    expect(await scope.check({ ...O, vout: 2 }, 100n)).toEqual({ ok: true });
    expect(rpc.getBlockchainInfo).toHaveBeenCalledTimes(1);
    expect(rpc.getTxout).toHaveBeenCalledTimes(2);
    expect(await checker.forValidation!().check(O, 100n)).toEqual({ ok: true });
    expect(rpc.getBlockchainInfo).toHaveBeenCalledTimes(2);
    rpc.getTxout.mockResolvedValueOnce(null as never);
    expect(await checker.check(O, 100n)).toMatchObject({ ok: false, code: "FUNDING_UNCONFIRMED" });
    expect(rpc.getBlockchainInfo).toHaveBeenCalledTimes(3);
  });

  it.each(["mine", "same-height reorg"])(
    "fails closed if %s moves the tip between input reads",
    async () => {
      const rpc = reader();
      const carrier = vi.fn(noCarrier);
      const scope = chainFundingChecker({ chain: rpc, isCoveCarrier: carrier }).forValidation!();
      expect(await scope.check(O, 100n)).toEqual({ ok: true });
      rpc.getTxout.mockResolvedValueOnce({
        confirmations: 1,
        bestBlockHash: "bb".repeat(32),
        valueSats: 1_000n,
        scriptPubKeyHex: "0014" + "ab".repeat(20),
      });
      expect(await scope.check({ ...O, vout: 2 }, 100n)).toMatchObject({
        ok: false,
        code: "FUNDING_CHECK_UNAVAILABLE",
      });
      expect(carrier).toHaveBeenCalledTimes(1);
      expect(rpc.getBlockchainInfo).toHaveBeenCalledTimes(1);
    },
  );

  it("still rejects new confirmations beyond the indexed cursor on a stable tip", async () => {
    const rpc = reader();
    rpc.getBlockchainInfo.mockResolvedValueOnce({
      blocks: 101,
      bestBlockHash: "aa".repeat(32),
      chain: "regtest",
    });
    rpc.getTxout.mockResolvedValueOnce({
      confirmations: 1,
      bestBlockHash: "aa".repeat(32),
      valueSats: 1_000n,
      scriptPubKeyHex: "0014" + "ab".repeat(20),
    });
    const scope = chainFundingChecker({ chain: rpc, isCoveCarrier: noCarrier }).forValidation!();
    expect(await scope.check(O, 100n)).toMatchObject({ ok: false, code: "FUNDING_UNCONFIRMED" });
  });

  it.each([NaN, 0.5, -1])("fails closed on malformed height %s", async (blocks) => {
    const rpc = reader();
    rpc.getBlockchainInfo.mockResolvedValueOnce({
      blocks,
      bestBlockHash: "aa".repeat(32),
      chain: "regtest",
    });
    expect(
      await chainFundingChecker({ chain: rpc, isCoveCarrier: noCarrier }).check(O, 100n),
    ).toMatchObject({ ok: false, code: "FUNDING_CHECK_UNAVAILABLE" });
    expect(rpc.getTxout).not.toHaveBeenCalled();
  });

  it("fails closed on the wrong network or absent prevout tip identity", async () => {
    const rpc = reader();
    const checker = chainFundingChecker({
      chain: rpc,
      isCoveCarrier: noCarrier,
      expectedChain: "signet",
    });
    expect(await checker.check(O, 100n)).toMatchObject({
      ok: false,
      code: "FUNDING_CHECK_UNAVAILABLE",
    });
    expect(rpc.getTxout).not.toHaveBeenCalled();
    rpc.getTxout.mockResolvedValueOnce({
      confirmations: 6,
      bestBlockHash: "",
      valueSats: 1_000n,
      scriptPubKeyHex: "0014" + "ab".repeat(20),
    });
    expect(
      await chainFundingChecker({ chain: rpc, isCoveCarrier: noCarrier }).check(O, 100n),
    ).toMatchObject({ ok: false, code: "FUNDING_CHECK_UNAVAILABLE" });
  });
});

describe("ordAssetLookup", () => {
  it("clean output → null", async () => {
    const ord = ordAssetLookup("http://ord", {
      fetchImpl: ordReply({ indexed: true, inscriptions: [], runes: {} }),
    });
    expect(await ord.describeAssets(O)).toBeNull();
  });

  it("names inscriptions and runes (object and array rune shapes)", async () => {
    const a = ordAssetLookup("http://ord", {
      fetchImpl: ordReply({ indexed: true, inscriptions: ["x"], runes: { DOG: {} } }),
    });
    expect(await a.describeAssets(O)).toBe("1 inscription(s) and 1 rune(s)");
    const b = ordAssetLookup("http://ord", {
      fetchImpl: ordReply({ indexed: true, inscriptions: [], runes: [["DOG", {}]] }),
    });
    expect(await b.describeAssets(O)).toBe("1 rune(s)");
  });

  it("an unindexed output, a missing field or an HTTP error is an error, not clean", async () => {
    await expect(
      ordAssetLookup("http://ord", {
        fetchImpl: ordReply({ indexed: false, inscriptions: [], runes: {} }),
      }).describeAssets(O),
    ).rejects.toThrow(/not indexed/);
    await expect(
      ordAssetLookup("http://ord", {
        fetchImpl: ordReply({ indexed: true, inscriptions: [] }),
      }).describeAssets(O),
    ).rejects.toThrow(/runes/);
    await expect(
      ordAssetLookup("http://ord", { fetchImpl: ordReply({}, 500) }).describeAssets(O),
    ).rejects.toThrow(/500/);
  });
});
