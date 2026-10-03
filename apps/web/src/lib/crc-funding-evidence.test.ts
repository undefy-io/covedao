import { expect, test } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import { verifyFundingEvidence } from "./crc-funding-evidence";

const script = `0014${"12".repeat(20)}`;
const tx = new bitcoin.Transaction();
tx.addInput(Buffer.alloc(32, 1), 0);
tx.addOutput(Buffer.from(script, "hex"), 12345);
const candidates = [{ txid: tx.getId(), vout: 0 }];
const evidence = { version: 1, network: "signet", parents: [{ txid: tx.getId(), rawHex: tx.toHex() }] };

test("derives exact funding from raw parents without trusting confirmation or amount fields", () => {
  expect(verifyFundingEvidence(evidence, "signet", candidates, script)).toEqual([
    { ...candidates[0], sats: 12345n, scriptHex: script },
  ]);
  expect(verifyFundingEvidence(undefined, "signet", candidates, script)).toBeUndefined();
  expect(verifyFundingEvidence({ version: 1, network: "signet", parents: [] }, "signet", [], script)).toEqual([]);
});

test("rejects wrong identity, ownership, incomplete/extra/duplicate parents and untrusted fields", () => {
  for (const value of [
    null, {}, { ...evidence, version: 2 }, { ...evidence, network: "testnet" },
    { ...evidence, confirmations: 1 }, { ...evidence, parents: [] },
    { ...evidence, parents: [...evidence.parents, ...evidence.parents] },
    { ...evidence, parents: [{ txid: "aa".repeat(32), rawHex: tx.toHex() }] },
    { ...evidence, parents: [{ ...evidence.parents[0], valueSats: "999999" }] },
    { ...evidence, parents: [{ ...evidence.parents[0], rawHex: "00" }] },
    { ...evidence, parents: [{ ...evidence.parents[0], rawHex: "00".repeat(100001) }] },
  ]) expect(() => verifyFundingEvidence(value, "signet", candidates, script)).toThrow();
  expect(() => verifyFundingEvidence(evidence, "signet", candidates, `0014${"13".repeat(20)}`)).toThrow();
  expect(() => verifyFundingEvidence(evidence, "signet", [{ ...candidates[0]!, vout: 1 }], script)).toThrow();
  expect(() => verifyFundingEvidence(evidence, "signet", [], script)).toThrow();
});

test("permits multiple candidate outputs from one parent and preserves candidate order", () => {
  const parent = tx.clone(); parent.addOutput(Buffer.from(script, "hex"), 25000);
  const inputs = [{ txid: parent.getId(), vout: 1 }, { txid: parent.getId(), vout: 0 }];
  const facts = verifyFundingEvidence({ ...evidence, parents: [{ txid: parent.getId(), rawHex: parent.toHex() }] }, "signet", inputs, script)!;
  expect(facts.map(row => row.sats)).toEqual([25000n, 12345n]);
});
