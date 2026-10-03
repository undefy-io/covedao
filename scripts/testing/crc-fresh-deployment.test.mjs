import assert from "node:assert/strict";
import test from "node:test";
import { deploymentManifest, assertOwnedResource } from "./crc-fresh-deployment.mjs";

test("fresh deployment coordinates only isolated regtest services", () => {
  const manifest = deploymentManifest("covedao-crc-cleanup-regtest:ag3-11", "covedao-crc-guardian-regtest:ag3-11");
  assert.match(manifest.prefix, /^crc-fresh-[0-9a-f-]{36}$/);
  assert.equal(manifest.common.COVE_NETWORK, "regtest");
  assert.equal(manifest.common.COVE_CRC_WORKER_ENABLED, "true");
  assert.equal(manifest.common.COVE_CRC_TRADING_ACTIVE, "true");
  assert.match(manifest.common.COVE_DATABASE_URL, new RegExp(manifest.prefix+"-db"));
  assert.match(manifest.common.COVE_BITCOIN_RPC_URL, new RegExp(manifest.prefix+"-core"));
  assert.equal(manifest.common.COVE_V3_CANARY_ACTIVE, "false");
  assert.throws(() => assertOwnedResource(manifest, "postgres"));
  assert.throws(() => assertOwnedResource(manifest, "crc-fresh-foreign-web"));
  assert.doesNotThrow(() => assertOwnedResource(manifest, manifest.prefix + "-web"));
});

test("runtime attestation rejects drift in either service and incomplete manifests", async () => {
  const { verifyRuntimeHashes } = await import("./crc-fresh-deployment.mjs");
  const files = Object.fromEntries(["protocol/index.ts", "adapters/src/index.ts", "state/src/index.ts", "guardian/src/index.ts"].map((suffix) => ["packages/crc20-"+suffix, "ab".repeat(32)]));
  assert.equal(verifyRuntimeHashes(files, { ...files }), 4);
  const changed = { ...files, "packages/crc20-guardian/src/index.ts": "cd".repeat(32) };
  assert.throws(() => verifyRuntimeHashes(files, changed));
  assert.throws(() => verifyRuntimeHashes({}, {}));
  assert.throws(() => verifyRuntimeHashes(files, { "packages/crc20-protocol/index.ts": "ab".repeat(32) }));
});
