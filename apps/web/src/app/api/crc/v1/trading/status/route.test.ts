import { expect, test, vi } from "vitest";
vi.mock("@/lib/crc-mutation", () => ({ getCrcMutationServices: () => ({ config: { network: "regtest" }, crcVaultConfig: { feeScriptHex: "0014" + "11".repeat(20) } }) }));
import { GET } from "./route";
test("publishes the operator fee authority for independent launch review", async () => {
  const body = await (await GET()).json();
  expect(body.data).toEqual({ tradingActive: true, network: "regtest", protocolScriptHex: "0014" + "11".repeat(20) });
});
