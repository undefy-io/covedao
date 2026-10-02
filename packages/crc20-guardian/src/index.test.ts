import { expect, test } from "vitest";
import * as guardian from "./index.js";
test("Guardian fails malformed requests before state, RPC or custody access", async () => {
  const service = new guardian.CrcGuardianSigningService({
    db: {} as never,
    core: {} as never,
    custodyBackend: {} as never,
    guardianXOnly: Buffer.alloc(32),
    recoveryProfile: {} as never,
    network: "regtest",
    protocolScript: Buffer.alloc(0),
    maxMinerFeeSats: 20000n,
  });
  expect(await service.sign({ network: "regtest", operation: "market-fill" })).toMatchObject({
    ok: false,
    reason: "CRC_SIGN_REJECTED",
  });
});
