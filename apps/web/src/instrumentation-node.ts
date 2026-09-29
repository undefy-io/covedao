import { loadV3AppConfig, watchGuardianAgreement } from "@crclaunch/cove-app";
import { getV3Services } from "@/lib/v3-server";
import { serverEnv } from "@/lib/server-env";

/**
 * Node-runtime startup (imported by instrumentation.ts).
 *
 * On mainnet the web app and the Guardian must run the same profile, fee
 * address (COVE_FEE_ADDRESS) included: the server stops on a mismatch rather
 * than serve mints and redeems the Guardian or the indexer would reject.
 */
loadV3AppConfig(process.env);
if (
  process.env.NEXT_PUBLIC_COVE_NETWORK &&
  process.env.NEXT_PUBLIC_COVE_NETWORK !== serverEnv.COVE_NETWORK
) {
  throw new Error(
    "The browser build and server network differ; rebuild the image for this network",
  );
}

if (serverEnv.COVE_NETWORK === "mainnet") {
  const { config, transitionSigner } = getV3Services();
  watchGuardianAgreement(transitionSigner, config, { service: "web" });
}
