import { ok } from "@/lib/api";
import { getCrcMutationServices } from "@/lib/crc-mutation";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { config, crcVaultConfig } = getCrcMutationServices();
    return ok({ tradingActive: true, network: config.network, protocolScriptHex: crcVaultConfig.feeScriptHex });
  } catch {
    return ok({ tradingActive: false });
  }
}
