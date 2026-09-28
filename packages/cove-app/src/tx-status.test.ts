import { expect, it, vi } from "vitest";
import { V3AppService } from "./service.js";
import { loadV3AppConfig } from "./config.js";
import type { CoreRpcProvider } from "@crclaunch/bitcoin";
import type { Database } from "@crclaunch/db";
import type { GuardianTransitionSigner } from "@crclaunch/cove-guardian/v3";

it.each([123n, null])("uses indexed confirmation and checks RPC only for pending transactions (%s)", async (height) => {
  const where = vi.fn().mockResolvedValueOnce([{ status: height === null ? "BROADCAST" : "CONFIRMED" }])
    .mockResolvedValueOnce(height === null ? [] : [{ blockHeight: height }]);
  const db = { select: () => ({ from: () => ({ where }) }) } as unknown as Database;
  const getRawTransaction = vi.fn().mockResolvedValue("raw");
  const app = new V3AppService(db, { getRawTransaction } as unknown as CoreRpcProvider,
    loadV3AppConfig({ COVE_NETWORK: "regtest" }), {} as GuardianTransitionSigner);
  const status = await app.txStatus("ab".repeat(32));
  expect(status.confirmedHeight).toBe(height);
  expect(status.mempool).toBe(height === null);
  expect(getRawTransaction).toHaveBeenCalledTimes(height === null ? 1 : 0);
});
