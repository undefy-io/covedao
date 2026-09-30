import { describe, expect, it } from "vitest";
import { parseCrcWorkerEnv } from "./crc-env.js";

const base = {
  COVE_CRC_WORKER_ENABLED: "true",
  COVE_NETWORK: "regtest",
  COVE_DATABASE_URL: "postgres://crc:crc@127.0.0.1:5435/crc_test",
  COVE_BITCOIN_RPC_URL: "http://127.0.0.1:18443",
};

describe("CRC worker startup environment", () => {
  it("derives activation and protocol script from the same profile as web and Guardian", () => {
    expect(parseCrcWorkerEnv(base)).toMatchObject({ enabled: true, network: "regtest", activationHeight: 101,
      protocolScriptHex: "0014cc1b07838e387deacd0e5232e1e8b49f4c29e484" });
    expect(() => parseCrcWorkerEnv({ ...base, COVE_CRC_WORKER_ENABLED: "false" })).toThrow();
    expect(() => parseCrcWorkerEnv({ ...base, COVE_CRC_PROTOCOL_SCRIPT_HEX: `5120${"11".repeat(32)}` }))
      .toThrow(/profiles.toml/);
  });

  it("fails before service startup on invalid activation or missing RPC", () => {
    expect(() => parseCrcWorkerEnv({ ...base, COVE_BITCOIN_RPC_URL: "" })).toThrow();
  });
});
