import { describe, expect, it } from "vitest";
import { crcBootstrapConfig } from "./crc-bootstrap";

describe("explicit CRC bootstrap", () => {
  it("uses the same trusted regtest profile and activation as all consumers", () => {
    const value = crcBootstrapConfig({ COVE_NETWORK: "regtest", COVE_DATABASE_URL: "postgres://local/db" });
    expect(value.activationHeight).toBe(101);
    expect(value.config).toEqual({ network: "regtest", ticker: "CRC", vaultScriptHex: "0014cc1b07838e387deacd0e5232e1e8b49f4c29e484", creatorScriptHex: "0014cc1b07838e387deacd0e5232e1e8b49f4c29e484", protocolScriptHex: "0014cc1b07838e387deacd0e5232e1e8b49f4c29e484" });
  });
  it("keeps the trusted test profile fee script despite an ambient fee address", () => {
    const value = crcBootstrapConfig({ COVE_NETWORK: "regtest", COVE_DATABASE_URL: "postgres://local/db", COVE_FEE_ADDRESS: "bcrt1qp3xsenptjjlcks035l9gq7x0z5u5e2dum5kshy" });
    expect(value.config.protocolScriptHex).toBe("0014cc1b07838e387deacd0e5232e1e8b49f4c29e484");
  });
  it("refuses mainnet, missing network/database and invalid profiles before database access", () => {
    for (const raw of [{COVE_NETWORK:"mainnet",COVE_DATABASE_URL:"postgres://local/db"},{COVE_DATABASE_URL:"postgres://local/db"},{COVE_NETWORK:"regtest"},{COVE_NETWORK:"regtest",COVE_DATABASE_URL:"postgres://local/db",COVE_TEST_ONLY_PROFILE_PATH:"/missing/crc-profile.toml"}]) expect(() => crcBootstrapConfig(raw)).toThrow();
  });
});

it("local infrastructure pins its bootstrap to the migrated regtest database", async () => {
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"));
  expect(pkg.scripts["dev:infra"]).toContain("COVE_NETWORK=regtest COVE_DATABASE_URL=postgres://cove:cove@127.0.0.1:5432/cove pnpm dev:crc-bootstrap");
  const signet = readFileSync(new URL("../../../../docker-compose.signet.yml", import.meta.url), "utf8");
  expect(signet).toContain('tsx", "src/scripts/crc-bootstrap.ts');
  expect(signet).toContain("bootstrap: { condition: service_completed_successfully }");
});
