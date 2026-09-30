import { describe, expect, it } from "vitest";
import { parseCrcWorkerEnv } from "./crc-env.js";

const base = {
  COVE_CRC_WORKER_ENABLED: "true",
  COVE_NETWORK: "signet",
  COVE_DATABASE_URL: "postgres://crc:crc@127.0.0.1:5435/crc_test",
  COVE_BITCOIN_RPC_URL: "https://bitcoin-signet-rpc.publicnode.com",
  COVE_CRC_ACTIVATION_HEIGHT: "100",
  COVE_CRC_PROTOCOL_SCRIPT_HEX: `5120${"11".repeat(32)}`,
};

describe("CRC worker startup environment", () => {
  it("requires explicit opt-in and a network-specific protocol script", () => {
    expect(parseCrcWorkerEnv(base)).toMatchObject({ enabled: true, network: "signet", activationHeight: 100 });
    expect(() => parseCrcWorkerEnv({ ...base, COVE_CRC_WORKER_ENABLED: "false" })).toThrow();
    expect(() => parseCrcWorkerEnv({ ...base, COVE_CRC_PROTOCOL_SCRIPT_HEX: "" })).toThrow();
  });

  it("fails before service startup on invalid activation or missing RPC", () => {
    expect(() => parseCrcWorkerEnv({ ...base, COVE_CRC_ACTIVATION_HEIGHT: "-1" })).toThrow();
    expect(() => parseCrcWorkerEnv({ ...base, COVE_BITCOIN_RPC_URL: "" })).toThrow();
  });
});
