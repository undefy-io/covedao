import { coveNetworkSettings, requireCoveNetwork, type CoveNetworkName } from "@crclaunch/config";
import { clientEnv } from "./client-env";

/**
 * The network this build serves, and its committed explorer. next.config.mjs
 * copies COVE_NETWORK into NEXT_PUBLIC_COVE_NETWORK at build time and refuses
 * to build without it, so the browser bundle and the server always agree.
 */
export const NETWORK: CoveNetworkName = requireCoveNetwork({ COVE_NETWORK: clientEnv.NEXT_PUBLIC_COVE_NETWORK });

/** Block explorer base URL, or undefined when the network has none (regtest). */
export const EXPLORER_URL: string | undefined =
  coveNetworkSettings(NETWORK, { NEXT_PUBLIC_EXPLORER_URL: clientEnv.NEXT_PUBLIC_EXPLORER_URL }).explorerUrl ?? undefined;
