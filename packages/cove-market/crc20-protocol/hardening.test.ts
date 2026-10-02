import { authorizeOffer } from "./test-support/signing.js";
import { test, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const a = "0014" + "11".repeat(20),
  b = "0014" + "22".repeat(20);
const config = {
  network: "regtest",
  ticker: "TEST",
  vaultScriptHex: a,
  creatorScriptHex: a,
  protocolScriptHex: b,
};
test("repeated block identity cannot conceal altered contents", async () => {
  const p = await import("./index.ts");
  const empty = p.emptyLedger(config);
  const block = { hash: "a".repeat(64), parentHash: "b".repeat(64), height: 100, transactions: [] };
  const next = p.applyBlock(empty, block);
  expect(p.applyBlock(next, block)).toBe(next);
  expect(() => p.applyBlock(next, { ...block, parentHash: "c".repeat(64) })).toThrow();
  expect(() => p.applyBlock(next, { ...block, height: 101 })).toThrow();
  expect(p.rollbackBlock(next, block.hash)).toEqual(empty);
  expect(() => p.rollbackBlock(next, "d".repeat(64))).toThrow();
});

test("registered buyer authorization and exact listing amount cannot be tampered or replayed", async () => {
  const p = await import("./index.ts");
  const key = Uint8Array.from({ length: 32 }, () => 0x61);
  // Use the public key supplied by the signature and independently derive its script in this test.
  const ecc = await import("tiny-secp256k1");
  const publicKey = ecc.pointFromScalar(key, true)!;
  const script =
    "0014" +
    createHash("ripemd160").update(createHash("sha256").update(publicKey).digest()).digest("hex");
  expect(script).toHaveLength(44);
  const input = {
    txid: "a".repeat(64),
    vout: 1,
    sats: 1000n,
    atoms: 123456789n,
    scriptHex: script,
  };
  const terms = {
    network: "regtest",
    deployTxid: "b".repeat(64),
    ticker: "TEST",
    listedInput: input,
    sellerScriptHex: script,
    priceSats: 20001n,
    expiryHeight: 120,
  };
  const offer = await authorizeOffer(terms, key);
  p.verifyOffer(offer);
  for (const change of [
    { expiryHeight: 121 },
    { priceSats: 20002n },
    { sellerScriptHex: b },
    { listedInput: { ...input, atoms: 123456788n } },
    { listedInput: { ...input, txid: "c".repeat(64) } },
    { listedInput: { ...input, sats: 999n } },
    {
      sellerWitnessHex: [offer.sellerWitnessHex[0].slice(0, -2) + "01", offer.sellerWitnessHex[1]],
    },
  ])
    expect(() => p.verifyOffer({ ...offer, ...change })).toThrow();
  const empty = p.emptyLedger(config);
  await expect(p.registerOffer(empty, offer)).rejects.toThrow();
});

test("transfer builder rejects wrong asset, unsafe numeric amounts and missing recipient without mutation", async () => {
  const { buildTransfer } = await import("./index.ts");
  const input = {
    txid: "a".repeat(64),
    vout: 1,
    sats: 1000n,
    atoms: 100000000000n,
    scriptHex: a,
    deployTxid: "b".repeat(64),
  };
  const args = {
    network: "regtest",
    deployTxid: "b".repeat(64),
    ticker: "TEST",
    input,
    funding: [{ txid: "c".repeat(64), vout: 0, sats: 10000n, scriptHex: a }],
    amountAtoms: 123456789n,
    recipientScriptHex: b,
    changeScriptHex: a,
  };
  const saved = structuredClone(args);
  for (const change of [
    { network: "mainnet" },
    { ticker: "BAD!" },
    { recipientScriptHex: "51" },
    { deployTxid: "d".repeat(64) },
    { amountAtoms: 9007199254740993n },
    { amountAtoms: 123456789 as any },
    { recipientScriptHex: "" },
  ])
    expect(() => buildTransfer({ ...args, ...change })).toThrow();
  expect(args).toEqual(saved);
});

test("runtime protocol source has no Node builtin imports, Buffer or process globals", () => {
  const root = new URL(".", import.meta.url).pathname;
  for (const file of readdirSync(root).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "vitest.config.ts",
  )) {
    const source = readFileSync(join(root, file), "utf8");
    expect(source).not.toMatch(/from ['"](?:node:|fs['"]|crypto['"]|buffer['"]|child_process['"])/);
    expect(source).not.toMatch(/\b(?:Buffer|process|require)\s*[.(]/);
  }
});

test("a listing cannot redirect its exact sale carrier to another owner", async () => {
  const { buildListing } = await import("./index.ts");
  expect(() =>
    buildListing({
      network: "regtest",
      deployTxid: "b".repeat(64),
      ticker: "TEST",
      input: { txid: "a".repeat(64), vout: 1, sats: 1000n, atoms: 100000000000n, scriptHex: a },
      funding: [{ txid: "c".repeat(64), vout: 0, sats: 10000n, scriptHex: a }],
      amountAtoms: 1n,
      priceSats: 12347n,
      sellerScriptHex: b,
    }),
  ).toThrow();
});
