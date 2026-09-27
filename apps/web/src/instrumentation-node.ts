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

if (serverEnv.COVE_NETWORK === "mainnet") {
  const { config, transitionSigner } = getV3Services();
  watchGuardianAgreement(transitionSigner, config, { service: "web" });
}
