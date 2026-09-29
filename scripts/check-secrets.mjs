#!/usr/bin/env node
/**
 * Scans tracked and untracked nonignored working files for leaked
 * secrets: deterministic test private keys (0x42/0x43/0x44/0x46/0x47/0x48/0x49
 * repeated 32 bytes), WIF-like base58, and .env
 * files with credentials. Test/fixture paths are exempt only where they are
 * explicitly test artifacts. Exits 1 on a hit, 0 otherwise.
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--root")) {
  console.error("Usage: check-secrets.mjs [--root repository]");
  process.exit(2);
}
const ROOT = args.length ? resolve(args[1]) : join(dirname(fileURLToPath(import.meta.url)), "..");

const TEST_KEY_HEXES = ["42", "43", "44", "46", "47", "48", "49", "51", "52", "53"];
const TEST_PRIV_RE = new RegExp(`\\b(${TEST_KEY_HEXES.map((b) => `(?:${b}){32}`).join("|")})\\b`, "i");
const WIF_RE = /\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/;
const ENV_SECRET_RE = /^\s*(?:[A-Z_]*?(?:PRIVATE_KEY|PASSWORD|SECRET|MNEMONIC|SEED|WIF))[A-Z_]*\s*=\s*\S+/m;

function isTestFile(p) {
  return /\.(test|spec)\.(ts|tsx|js|mjs)$/.test(p) || p.includes("/testing/") || p.includes("/tests/") || p.includes("/fixtures/");
}

function withoutExplicitRegtestKeys(rel, source) {
  const allowed = rel === ".github/workflows/cove-v3-product.yml"
    ? { COVE_GUARDIAN_PRIVATE_KEY_HEX: "42", COVE_RECOVERY_PRIVATE_KEY_HEX: "43", COVE_FEE_PRIVATE_KEY_HEX: "44" }
    : rel === "docker-compose.yml" ? { GUARDIAN_TEST_KEY_HEX: "42" } : null;
  if (allowed) {
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const declaration = /^(\s*)([A-Z_]+):\s*"([0-9a-f]+)"\s*$/.exec(lines[i]);
      if (!declaration || !Object.hasOwn(allowed, declaration[2]) ||
          declaration[3] !== allowed[declaration[2]].repeat(32)) continue;
      const indent = declaration[1].length;
      let start = i - 1;
      while (start >= 0 && (!lines[start].trim() || lines[start].trimStart().startsWith("#") || /^\s*/.exec(lines[start])[0].length >= indent)) start--;
      if (start < 0 || !/^(\s*)(?:env|environment):\s*$/.test(lines[start])) continue;
      let end = i + 1;
      while (end < lines.length && (!lines[end].trim() || lines[end].trimStart().startsWith("#") || /^\s*/.exec(lines[end])[0].length >= indent)) end++;
      const networks = lines.slice(start + 1, end).filter((line) => new RegExp(`^ {${indent}}COVE_NETWORK:`).test(line));
      if (networks.length === 1 && new RegExp(`^ {${indent}}COVE_NETWORK:\\s*(?:regtest|"regtest"|'regtest')\\s*$`).test(networks[0])) lines[i] = "";
    }
    return lines.join("\n");
  }
  if (rel === "package.json") {
    const expected = `pnpm build:rust && COVE_NETWORK=regtest GUARDIAN_TEST_KEY_HEX=${"42".repeat(32)} GUARDIAN_KEY_HEX= GUARDIAN_AUTH_TOKEN=local-dev COVE_DATABASE_URL=postgres://cove:cove@127.0.0.1:5432/cove COVE_BITCOIN_RPC_URL=http://127.0.0.1:18443 COVE_BITCOIN_RPC_USER=user COVE_BITCOIN_RPC_PASSWORD=pass COVE_FEE_ADDRESS= pnpm start`;
    try {
      const pkg = JSON.parse(source);
      const pattern = /("dev:regtest"\s*:\s*)("(?:\\.|[^"\\])*")/g;
      const matches = [...source.matchAll(pattern)];
      if (pkg.name !== "cove-guardian-service" || pkg.scripts?.["dev:regtest"] !== expected ||
          matches.length !== 1 || JSON.parse(matches[0][2]) !== expected) return source;
      return source.replace(pattern, (_match, property) => `${property}""`);
    } catch { return source; }
  }
  return source;
}

function fail(msg) {
  console.error(`SECRET-SCAN VIOLATION: ${msg}`);
  process.exit(1);
}

const files = [...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: ROOT, encoding: "utf8" })
  .split("\0").filter(Boolean))];

let scanned = 0;
for (const rel of files) {
  const file = join(ROOT, rel);
  if (!existsSync(file)) continue;
  const src = readFileSync(file, "utf8");
  scanned++;
  const isTest = isTestFile(rel);
  // Deterministic test private keys are only allowed in test/fixture artifacts.
  if (TEST_PRIV_RE.test(withoutExplicitRegtestKeys(rel, src)) && !isTest) {
    fail(`${rel}: deterministic test private key in a non-test file`);
  }
  // WIF private keys are never allowed anywhere in the tree.
  if (WIF_RE.test(src)) fail(`${rel}: WIF-like private key`);
  // .env files must not commit credentials (they are gitignored; presence = leak).
  if (/(?:^|\/)\.env(?:\.(?!example$|sample$)[^/]+)?$/.test(rel) && ENV_SECRET_RE.test(src)) fail(`${rel}: public .env with credentials`);
}

console.log(`secret scan OK: ${scanned} files, no matching fixture private keys/WIF/.env credentials`);
