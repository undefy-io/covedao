import { crcMarketGet, crcMarketPost } from "@/lib/crc-market-route";
import { getCrcMutationServices } from "@/lib/crc-mutation";
import { getCrcReadServices } from "@/lib/crc-server";
import { isCrcMarketReleased } from "@/lib/crc-market-availability";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ operation: string }> };

export async function GET(req: Request, context: Context) {
  return crcMarketGet(
    req,
    (await context.params).operation,
    isCrcMarketReleased(),
    getCrcReadServices,
  );
}

export async function POST(req: Request, context: Context) {
  return crcMarketPost(req, (await context.params).operation, isCrcMarketReleased(), () => {
    const { db, provider, config, crcVaultConfig, guardianEndpoint, guardianAuthToken } =
      getCrcMutationServices();
    return {
      db,
      provider,
      network: config.network,
      feeScriptHex: crcVaultConfig.feeScriptHex,
      guardianEndpoint,
      guardianAuthToken,
    };
  });
}
