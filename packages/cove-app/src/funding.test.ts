import { describe, expect, it } from "vitest";
import type { CoreRpcProvider } from "@crclaunch/bitcoin";
import { MAX_FUNDING_INPUTS, resolveFundingUtxos } from "./funding.js";

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
