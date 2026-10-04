/**
 * Committed, non-secret Cove V3 settings for each network. Environment
 * variables carry only secrets and per-deploy endpoints (database, Bitcoin
 * RPC, Guardian URL); everything here is the same for every deploy of a
 * network, so it lives in code where review sees it.
 *
 * Off mainnet, a few of these may be overridden from the environment for
 * local tooling (for example Mutinynet runs as "signet" with another
 * explorer). On mainnet the committed values are always used.
 *
 * Browser-safe: no Node imports, so web client components use it too.
 */

export const COVE_NETWORKS = ["regtest", "signet", "testnet", "mainnet"] as const;
export type CoveNetworkName = (typeof COVE_NETWORKS)[number];

export interface CoveNetworkSettings {
  /** Serve the V3 app (web mutations, worker). */
  v3Enabled: boolean;
  /** Worker poll interval, ms. */
  workerPollMs: number;
  /** Port the Guardian service listens on. */
  guardianPort: number;
  /** Block explorer for links, without a trailing slash. Null: no links. */
  explorerUrl: string | null;
  /** Esplora API for wallet UTXO lookups. Null: the wallet supplies UTXOs. */
  esploraUrl: string | null;
  /**
   * ord server (with runes indexed) used to refuse spending coins that hold
   * inscriptions or runes. Required on mainnet.
   */
  ordUrl: string | null;
  /**
   * Also write the crc-20 JSON OP_RETURN ({"p":"crc-20","op":"mint",...}) so
   * explorers and crc-20 tools read covs transactions like LEAF and BONS.
   * Needs Bitcoin Core 30+ relay (two OP_RETURNs). Off on regtest because the
   * CI nodes run Core 28.1; turn it on locally with COVE_V3_DISCOVERY_ENVELOPE.
   */
  discoveryEnvelope: boolean;
}

export const COVE_NETWORK_SETTINGS: Record<CoveNetworkName, CoveNetworkSettings> = {
  regtest: {
    v3Enabled: true,
    workerPollMs: 2_000,
    guardianPort: 4391,
    explorerUrl: null,
    esploraUrl: null,
    ordUrl: null,
    discoveryEnvelope: false,
  },
  signet: {
    v3Enabled: true,
    workerPollMs: 5_000,
    guardianPort: 4391,
    explorerUrl: "https://blockstream.info/signet",
    esploraUrl: "https://blockstream.info/signet/api",
    ordUrl: null,
    discoveryEnvelope: true,
  },
  testnet: {
    v3Enabled: true,
    workerPollMs: 5_000,
    guardianPort: 4391,
    explorerUrl: "https://blockstream.info/testnet",
    esploraUrl: "https://blockstream.info/testnet/api",
    ordUrl: null,
    discoveryEnvelope: true,
  },
  mainnet: {
    v3Enabled: true,
    workerPollMs: 10_000,
    guardianPort: 4391,
    explorerUrl: "https://blockstream.info",
    esploraUrl: "https://blockstream.info/api",
    ordUrl: "https://ordinals.com",
    discoveryEnvelope: true,
  },
};

export class CoveNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoveNetworkError";
  }
}

/**
 * COVE_NETWORK, required. There is no default: a service that silently fell
 * back to regtest (or to CRC_NETWORK) could start against the wrong chain.
 */
export function requireCoveNetwork(env: Record<string, string | undefined>): CoveNetworkName {
  const raw = env.COVE_NETWORK;
  if (!raw) {
    throw new CoveNetworkError(`COVE_NETWORK is required (one of ${COVE_NETWORKS.join(", ")}); there is no default`);
  }
  if (!(COVE_NETWORKS as readonly string[]).includes(raw)) {
    throw new CoveNetworkError(`COVE_NETWORK "${raw}" is not one of ${COVE_NETWORKS.join(", ")}`);
  }
  return raw as CoveNetworkName;
}

type Overridable = "explorerUrl" | "esploraUrl" | "ordUrl" | "workerPollMs" | "discoveryEnvelope";
const OVERRIDE_ENV: Record<Overridable, string> = {
  explorerUrl: "NEXT_PUBLIC_EXPLORER_URL",
  esploraUrl: "COVE_ESPLORA_URL",
  ordUrl: "COVE_ORD_URL",
  workerPollMs: "COVE_WORKER_POLL_MS",
  discoveryEnvelope: "COVE_V3_DISCOVERY_ENVELOPE",
};

/**
 * The settings for `network`. Off mainnet, the env names in OVERRIDE_ENV may
 * replace a committed value (local tooling, Mutinynet). On mainnet they are
 * ignored: mainnet runs exactly what is committed.
 */
export function coveNetworkSettings(
  network: CoveNetworkName,
  env: Record<string, string | undefined> = {},
): CoveNetworkSettings {
  const base = COVE_NETWORK_SETTINGS[network];
  if (network === "mainnet") return { ...base };
  const s = { ...base };
  const get = (k: Overridable) => {
    const v = env[OVERRIDE_ENV[k]];
    return v === undefined || v === "" ? undefined : v;
  };
  const explorer = get("explorerUrl");
  if (explorer) s.explorerUrl = explorer.replace(/\/+$/, "");
  const esplora = get("esploraUrl");
  if (esplora) s.esploraUrl = esplora.replace(/\/+$/, "");
  const ord = get("ordUrl");
  if (ord) s.ordUrl = ord;
  const poll = get("workerPollMs");
  if (poll && Number.isFinite(Number(poll)) && Number(poll) > 0) s.workerPollMs = Number(poll);
  const discovery = get("discoveryEnvelope");
  if (discovery) s.discoveryEnvelope = ["true", "1", "yes", "on"].includes(discovery.toLowerCase());
  return s;
}
