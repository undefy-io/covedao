import { describe, expect, it } from "vitest";
import type { Database } from "@crclaunch/db";
import type { CoreRpcProvider } from "@crclaunch/bitcoin";
import {
  MAX_FUNDING_INPUTS,
  resolveFundingUtxos,
  resolveCachedFundingUtxos,
  cachedBuildFundingChecker,
} from "./funding.js";

const txid = (n: number) => n.toString(16).padStart(64, "0");

describe("funding RPC bounds", () => {
  it("rejects oversized and duplicate lists before calling Core", async () => {
    let calls = 0;
    const provider = {
      getTxout: async () => {
        calls++;
        return null;
      },
    } as unknown as CoreRpcProvider;
    await expect(
      resolveFundingUtxos(
        provider,
        Array.from({ length: MAX_FUNDING_INPUTS + 1 }, (_, n) => ({ txid: txid(n), vout: 0 })),
      ),
    ).rejects.toThrow(/at most/);
    await expect(
      resolveFundingUtxos(provider, [
        { txid: txid(1), vout: 0 },
        { txid: txid(1), vout: 0 },
      ]),
    ).rejects.toThrow(/duplicate/);
    expect(calls).toBe(0);
  });

  it("runs at most eight lookups at once and preserves input order", async () => {
    let active = 0;
    let maximum = 0;
    const provider = {
      getTxout: async () => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
        return { scriptPubKeyHex: "0014" + "ab".repeat(20), valueSats: 1000n, confirmations: 2 };
      },
    } as unknown as CoreRpcProvider;
    const inputs = Array.from({ length: 32 }, (_, n) => ({ txid: txid(n), vout: 0 }));
    const resolved = await resolveFundingUtxos(provider, inputs);
    expect(maximum).toBeLessThanOrEqual(8);
    expect(resolved.map((x) => x.txid)).toEqual(inputs.map((x) => x.txid));
  });

  it("bounds lookups shared by concurrent requests", async () => {
    let active = 0;
    let maximum = 0;
    const provider = {
      getTxout: async () => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active--;
        return { scriptPubKeyHex: "0014" + "ab".repeat(20), valueSats: 1000n, confirmations: 2 };
      },
    } as unknown as CoreRpcProvider;
    await Promise.all(
      Array.from({ length: 5 }, (_, request) =>
        resolveFundingUtxos(
          provider,
          Array.from({ length: 32 }, (_, n) => ({ txid: txid(request * 32 + n), vout: 0 })),
        ),
      ),
    );
    expect(maximum).toBeLessThanOrEqual(16);
  });
});

describe("cached build funding", () => {
  const script = "0014" + "ab".repeat(20);
  const coin = { txid: txid(1), vout: 0, valueSats: "10000", confirmations: 2 };
  const database = (payload: unknown) =>
    ({ execute: async () => ({ rows: payload ? [{ payload }] : [] }) }) as unknown as Database;
  it("takes amounts and scripts only from the server cache", async () => {
    const inputs = await resolveCachedFundingUtxos(database([coin]), "signet", script, [
      { txid: coin.txid, vout: 0, valueSats: "9999999", script: "51" } as never,
    ]);
    expect(inputs[0]?.valueSats).toBe(10000n);
    expect(inputs[0]?.script.toString("hex")).toBe(script);
    const check = cachedBuildFundingChecker(inputs);
    expect(
      await check.check(coin, undefined, { script: Buffer.from(script, "hex"), valueSats: 10000n }),
    ).toEqual({ ok: true });
    expect(
      await check.check(coin, undefined, { script: Buffer.from(script, "hex"), valueSats: 10001n }),
    ).toMatchObject({ ok: false, code: "FUNDING_PREVOUT_MISMATCH" });
    expect(
      await cachedBuildFundingChecker([{ ...inputs[0]!, confirmations: 0 }]).check(coin),
    ).toMatchObject({ ok: false, code: "FUNDING_UNCONFIRMED" });
  });
  it("requires a cached outpoint instead of accepting browser metadata", async () => {
    await expect(
      resolveCachedFundingUtxos(database(undefined), "signet", script, [coin]),
    ).rejects.toThrow(/refresh your wallet/);
    await expect(
      resolveCachedFundingUtxos(database([coin]), "signet", script, [{ txid: txid(2), vout: 0 }]),
    ).rejects.toThrow(/refresh your wallet/);
  });
});
