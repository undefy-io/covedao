import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const scanner = fileURLToPath(new URL("./check-secrets.mjs", import.meta.url));
const roots = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture(files, tracked = []) {
  const root = mkdtempSync(join(tmpdir(), "secret-scan-regression-"));
  roots.push(root);
  execFileSync("git", ["init", "--quiet", root]);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  if (tracked.length) execFileSync("git", ["add", "--", ...tracked], { cwd: root });
  return root;
}

function scan(files, tracked) {
  const result = spawnSync(process.execPath, [scanner, "--root", fixture(files, tracked)], { encoding: "utf8" });
  return { status: result.status, output: result.stdout + result.stderr };
}

for (const byte of ["42", "43", "44", "46", "47", "48", "49", "51", "52", "53"]) {
  test(`detects byte pair ${byte} repeated 32 times in an untracked production file`, () => {
    const key = byte.repeat(32);
    const result = scan({ "src/production.ts": `export const key = "${key}";` });
    assert.equal(result.status, 1);
    assert.match(result.output, /src\/production\.ts: deterministic test private key/);
    assert.equal(result.output.includes(key), false);
  });
}

test("scans tracked files too and permits deterministic keys only in test artifacts", () => {
  const key = "42".repeat(32);
  assert.equal(scan({ "src/server.ts": key }, ["src/server.ts"]).status, 1);
  assert.equal(scan({ "src/server.test.ts": key }, ["src/server.test.ts"]).status, 0);
});

function ci(network = "regtest", extra = "") {
  return `jobs:\n  integration:\n    env:\n      COVE_NETWORK: ${network}\n      COVE_GUARDIAN_PRIVATE_KEY_HEX: "${"42".repeat(32)}"\n      COVE_RECOVERY_PRIVATE_KEY_HEX: "${"43".repeat(32)}"\n      COVE_FEE_PRIVATE_KEY_HEX: "${"44".repeat(32)}"\n${extra}`;
}
const ciPath = ".github/workflows/cove-v3-product.yml";
test("permits exact CI regtest fixture declarations but refuses mainnet or duplicate networks", () => {
  assert.equal(scan({ [ciPath]: ci() }).status, 0);
  assert.equal(scan({ [ciPath]: ci("mainnet") }).status, 1);
  assert.equal(scan({ [ciPath]: ci("regtest", "      COVE_NETWORK: mainnet\n") }).status, 1);
});

test("CI allowances do not cover other fields, wrong values or other workflow files", () => {
  assert.equal(scan({ [ciPath]: ci("regtest", `      PRODUCTION_KEY: "${"42".repeat(32)}"\n`) }).status, 1);
  assert.equal(scan({ [ciPath]: ci().replace("42".repeat(32), "46".repeat(32)) }).status, 1);
  assert.equal(scan({ ".github/workflows/production.yml": ci() }).status, 1);
});

test("requires the fixture key and regtest network to belong to the same YAML environment", () => {
  const source = `services:\n  local:\n    environment:\n      COVE_NETWORK: regtest\n  production:\n    environment:\n      GUARDIAN_TEST_KEY_HEX: "${"42".repeat(32)}"\n`;
  assert.equal(scan({ "docker-compose.yml": source }).status, 1);
});

test("permits only the exact compose regtest test-key declaration", () => {
  const source = `services:\n  guardian:\n    environment:\n      COVE_NETWORK: regtest\n      GUARDIAN_TEST_KEY_HEX: "${"42".repeat(32)}"\n`;
  assert.equal(scan({ "docker-compose.yml": source }).status, 0);
  assert.equal(scan({ "docker-compose.yml": source.replace("regtest", "mainnet") }).status, 1);
  assert.equal(scan({ "docker-compose.yml": source + `      GUARDIAN_KEY_HEX: "${"42".repeat(32)}"\n` }).status, 1);
});

const command = `pnpm build:rust && COVE_NETWORK=regtest GUARDIAN_TEST_KEY_HEX=${"42".repeat(32)} GUARDIAN_KEY_HEX= GUARDIAN_AUTH_TOKEN=local-dev COVE_DATABASE_URL=postgres://cove:cove@127.0.0.1:5432/cove COVE_BITCOIN_RPC_URL=http://127.0.0.1:18443 COVE_BITCOIN_RPC_USER=user COVE_BITCOIN_RPC_PASSWORD=pass COVE_FEE_ADDRESS= pnpm start`;
test("permits the exact Guardian dev:regtest command without exempting production fields", () => {
  const json = (scripts) => JSON.stringify({ name: "cove-guardian-service", scripts });
  assert.equal(scan({ "package.json": json({ "dev:regtest": command }) }).status, 0);
  assert.equal(scan({ "package.json": json({ start: command }) }).status, 1);
  assert.equal(scan({ "package.json": json({ "dev:regtest": command.replace("regtest", "mainnet") }) }).status, 1);
  assert.equal(scan({ "package.json": json({ "dev:regtest": command, production: "42".repeat(32) }) }).status, 1);
  assert.equal(scan({ "package.json": JSON.stringify({ name: "production-service", scripts: { "dev:regtest": command } }) }).status, 1);
  assert.equal(scan({ "package.json": JSON.stringify({ name: "cove-guardian-service", production: { "dev:regtest": command } }) }).status, 1);
  assert.equal(scan({ "package.json": `{ "name": "cove-guardian-service", "scripts": { "dev:regtest": ${JSON.stringify(command)}, "dev:regtest": ${JSON.stringify(command)} } }` }).status, 1);
});

test("WIF-like keys are refused even in tests and otherwise allowed fixture files", () => {
  const wif = "5" + "A".repeat(50);
  for (const files of [{ "src/signing.test.ts": wif }, { [ciPath]: ci("regtest", `      PRIVATE_WIF: ${wif}\n`) }]) {
    const result = scan(files);
    assert.equal(result.status, 1);
    assert.match(result.output, /WIF-like private key/);
    assert.equal(result.output.includes(wif), false);
  }
});

test("untracked public env credentials are refused while ignored local files stay private", () => {
  const password = "scanner-regression-sensitive";
  const result = scan({ ".env.production": `COVE_RPC_PASSWORD=${password}\n` });
  assert.equal(result.status, 1);
  assert.match(result.output, /public \.env with credentials/);
  assert.equal(result.output.includes(password), false);
  assert.equal(scan({ ".gitignore": ".env.local\n", ".env.local": `PASSWORD=${password}` }).status, 0);
});
