import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(root, "packages/cove-indexer/package.json"));
const { config: loadEnv } = require("dotenv");
const bitcoin = require("bitcoinjs-lib");
const ecc = require("tiny-secp256k1");
loadEnv({ path: resolve(root, ".env.signet.local") });

function publicKey(name) {
  const value = process.env[name];
  if (!value || !/^[0-9a-f]{64}$/i.test(value)) throw new Error(`${name} must be a 32-byte hex key`);
  const key = ecc.pointFromScalar(Buffer.from(value, "hex"), true);
  if (!key) throw new Error(`${name} is not a valid Bitcoin key`);
  return Buffer.from(key);
}

const height = Number(process.env.COVE_ACTIVATION_HEIGHT);
if (!Number.isSafeInteger(height) || height < 1) throw new Error("COVE_ACTIVATION_HEIGHT must be a positive integer");
const guardian = publicKey("COVE_GUARDIAN_PRIVATE_KEY_HEX");
const recovery = publicKey("COVE_RECOVERY_PRIVATE_KEY_HEX");
const fee = publicKey("COVE_FEE_PRIVATE_KEY_HEX");
if (guardian.subarray(1).equals(recovery.subarray(1))) throw new Error("Guardian and recovery keys must differ");
const feeScript = bitcoin.payments.p2wpkh({ pubkey: fee, network: bitcoin.networks.testnet }).output;
if (!feeScript) throw new Error("fee key has no SegWit script");

const source = readFileSync(resolve(root, "packages/cove-mainnet/profiles.toml"), "utf8");
if (source.includes("[networks.signet]")) throw new Error("signet profile is already bundled");
const signet = `\n[networks.signet]
activationHeight = ${height}
guardianXOnly = "${guardian.subarray(1).toString("hex")}"
feeScript = "${feeScript.toString("hex")}"
buyFeeBps = 100
redeemFeeBps = 100
p2pFeeBps = 50

[networks.signet.recovery]
threshold = 1
pubkeys = ["${recovery.subarray(1).toString("hex")}"]
csvBlocks = 2016

[networks.signet.canary]
allowedWalletScripts = ["0014bd92088bb7e82d611a9b94fbb74a0908152b784f"]
allowedTokenIds = ["fb960b7e43b92b0a9213cf8d0a4534fb8f5776728499af70bf1c3cc8e6d19469"]
maxBackingSats = "1000000000"
maxSingleBuySats = "200000"
maxSingleRedeemPayoutSats = "50000000"
maxP2pSettlementSats = "10000000"
maxMintAtoms = "2100000000000000"
minMintGrossSats = "5000"
`;
const directory = resolve(root, ".local");
mkdirSync(directory, { recursive: true });
writeFileSync(resolve(directory, "signet-crc-profile.toml"), source.trimEnd() + "\n" + signet, { mode: 0o600 });
console.log("Wrote local signet CRC profile with public parameters only");
