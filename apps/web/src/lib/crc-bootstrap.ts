import { resolveMainnetProfile } from "@crclaunch/cove-mainnet";

/** Explicit test-environment bootstrap; asset registration remains core-owned. */
export function crcBootstrapConfig(raw: Record<string, string | undefined>) {
  const network = raw.COVE_NETWORK;
  if (network !== "regtest" && network !== "signet")
    throw new Error("CRC test bootstrap requires regtest or signet");
  const databaseUrl = raw.COVE_DATABASE_URL ?? raw.DATABASE_URL;
  if (!databaseUrl || !/^postgres(?:ql)?:\/\//.test(databaseUrl))
    throw new Error("CRC bootstrap requires a PostgreSQL database URL");
  const { profile, validation } = resolveMainnetProfile({
    network, testOnlyPath: raw.COVE_TEST_ONLY_PROFILE_PATH || undefined,
    feeAddress: raw.COVE_FEE_ADDRESS || undefined,
  });
  if (!validation.ok || !profile.feeScript || profile.activationHeight == null ||
      profile.activationHeight < 1n || profile.activationHeight > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("CRC bootstrap requires a valid trusted profile");
  return {
    databaseUrl, activationHeight: Number(profile.activationHeight),
    config: { network, ticker: "CRC", vaultScriptHex: profile.feeScript,
      creatorScriptHex: profile.feeScript, protocolScriptHex: profile.feeScript },
  };
}
