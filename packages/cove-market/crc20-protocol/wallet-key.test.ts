import { expect, test } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as core from "./index.js";

// Public key/address returned by the actual unfunded Xverse 2.9.3 Signet wallet.
const key = "d1f7ff2fdff88f887d3589be9d710e0b5cf1d2a565ef9750edab40587ae3f204";
const script = `5120${bitcoin.address.fromBech32("tb1p6c2ntr5n2swmpcxt2c0xp2uhguv5rwa063vum3k4ylj35llj6prq00thjv").data.toString("hex")}`;
test("wallet x-only BIP86 key normalizes to the one canonical offer key", () => {
  expect(core.canonicalOfferPublicKey(key, script)).toBe(`02${key}`);
  expect(core.canonicalOfferPublicKey(`03${key}`, script)).toBe(`02${key}`);
  expect(core.canonicalOfferPublicKey(`02${key}`, script)).toBe(`02${key}`);
});
test("wallet key normalization proves its script before message signing", () => {
  for (const [candidate, owner] of [
    [key, `0014${"a".repeat(40)}`],
    [key, `5120${"a".repeat(64)}`],
    ["f".repeat(64), script],
    [key.toUpperCase(), script],
    ["04" + key, script],
  ])
    expect(() => core.canonicalOfferPublicKey(candidate!, owner!)).toThrow();
});
