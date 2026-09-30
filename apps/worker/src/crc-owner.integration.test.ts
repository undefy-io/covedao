import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { acquireCrcOwner } from "./crc-owner.js";

const url = process.env.CRC_TEST_DATABASE_URL;
const parsed = url ? new URL(url) : undefined;
const isolated = parsed?.hostname === "127.0.0.1" && parsed.port === "5435" && parsed.pathname === "/crc_test";

describe.skipIf(!isolated)("CRC worker ownership lock", () => {
  it("allows only one owner per network and releases on connection close", async () => {
    const network = `crc-owner-${randomUUID()}`;
    const first = await acquireCrcOwner(url!, network);
    await expect(acquireCrcOwner(url!, network)).rejects.toThrow("already owns");
    first.removeAllListeners("end"); first.removeAllListeners("error");
    await first.end();
    const second = await acquireCrcOwner(url!, network);
    second.removeAllListeners("end"); second.removeAllListeners("error");
    await second.end();
  });
});
