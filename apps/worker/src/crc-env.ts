import { bool, cleanEnv, makeValidator, str, url } from "envalid";
import type { CrcRawBlock } from "@crclaunch/cove-indexer/crc20";

type BitcoinNetwork = CrcRawBlock["network"];

const activation = makeValidator((value: string) => {
  const height = Number(value);
  if (!Number.isSafeInteger(height) || height < 0 || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("invalid CRC activation height");
  return height;
});
const poll = makeValidator((value: string) => {
  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || ms < 1000 || ms > 60_000) throw new Error("invalid CRC poll interval");
  return ms;
});
const rate = makeValidator((value: string) => {
  const requests = Number(value);
  if (!Number.isSafeInteger(requests) || requests < 3 || requests > 300) throw new Error("invalid RPC budget");
  return requests;
});
const script = makeValidator((value: string) => {
  if (!/^(?:0014[0-9a-f]{40}|0020[0-9a-f]{64}|5120[0-9a-f]{64}|76a914[0-9a-f]{40}88ac|a914[0-9a-f]{40}87)$/.test(value)) throw new Error("invalid CRC protocol script");
  return value;
});

export type CrcWorkerEnv = {
  enabled: true;
  network: BitcoinNetwork;
  databaseUrl: string;
  rpcUrl: string;
  rpcApiKey?: string;
  rpcUser?: string;
  rpcPassword?: string;
  activationHeight: number;
  protocolScriptHex: string;
  pollMs: number;
  rpcRequestsPerSecond: number;
};

export function parseCrcWorkerEnv(raw: Record<string, string | undefined>): CrcWorkerEnv {
  const env = cleanEnv({
    COVE_CRC_WORKER_ENABLED: raw.COVE_CRC_WORKER_ENABLED,
    COVE_NETWORK: raw.COVE_NETWORK,
    COVE_DATABASE_URL: raw.COVE_DATABASE_URL ?? raw.DATABASE_URL,
    COVE_BITCOIN_RPC_URL: raw.COVE_BITCOIN_RPC_URL,
    COVE_BITCOIN_RPC_API_KEY: raw.COVE_BITCOIN_RPC_API_KEY,
    COVE_BITCOIN_RPC_USER: raw.COVE_BITCOIN_RPC_USER,
    COVE_BITCOIN_RPC_PASSWORD: raw.COVE_BITCOIN_RPC_PASSWORD,
    COVE_CRC_ACTIVATION_HEIGHT: raw.COVE_CRC_ACTIVATION_HEIGHT,
    COVE_CRC_PROTOCOL_SCRIPT_HEX: raw.COVE_CRC_PROTOCOL_SCRIPT_HEX,
    COVE_CRC_POLL_MS: raw.COVE_CRC_POLL_MS,
    COVE_RPC_REQUESTS_PER_SECOND: raw.COVE_RPC_REQUESTS_PER_SECOND,
  }, {
    COVE_CRC_WORKER_ENABLED: bool(),
    COVE_NETWORK: str({ choices: ["mainnet", "testnet", "signet", "regtest"] }),
    COVE_DATABASE_URL: url(),
    COVE_BITCOIN_RPC_URL: url(),
    COVE_BITCOIN_RPC_API_KEY: str({ default: undefined }),
    COVE_BITCOIN_RPC_USER: str({ default: undefined }),
    COVE_BITCOIN_RPC_PASSWORD: str({ default: undefined }),
    COVE_CRC_ACTIVATION_HEIGHT: activation(),
    COVE_CRC_PROTOCOL_SCRIPT_HEX: script(),
    COVE_CRC_POLL_MS: poll({ default: 15_000 }),
    COVE_RPC_REQUESTS_PER_SECOND: rate({ default: 3 }),
  }, { reporter: ({ errors }) => { if (Object.keys(errors).length) throw new Error(`Invalid CRC worker environment: ${Object.keys(errors).join(", ")}`); } });
  if (!env.COVE_CRC_WORKER_ENABLED) throw new Error("COVE_CRC_WORKER_ENABLED=true is required for the CRC worker entrypoint");
  if (!!env.COVE_BITCOIN_RPC_USER !== !!env.COVE_BITCOIN_RPC_PASSWORD) throw new Error("both Bitcoin RPC username and password are required together");
  return {
    enabled: true, network: env.COVE_NETWORK as BitcoinNetwork, databaseUrl: env.COVE_DATABASE_URL,
    rpcUrl: env.COVE_BITCOIN_RPC_URL, rpcApiKey: env.COVE_BITCOIN_RPC_API_KEY,
    rpcUser: env.COVE_BITCOIN_RPC_USER, rpcPassword: env.COVE_BITCOIN_RPC_PASSWORD,
    activationHeight: env.COVE_CRC_ACTIVATION_HEIGHT, protocolScriptHex: env.COVE_CRC_PROTOCOL_SCRIPT_HEX,
    pollMs: env.COVE_CRC_POLL_MS, rpcRequestsPerSecond: env.COVE_RPC_REQUESTS_PER_SECOND,
  };
}
