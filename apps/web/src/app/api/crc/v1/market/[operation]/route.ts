import { crcMarketGet, crcMarketPost } from "@/lib/crc-market-route";
import { getCrcMutationServices } from "@/lib/crc-mutation";
import { getCrcReadServices } from "@/lib/crc-server";

export const dynamic = "force-dynamic";

const CRC_MARKET_RELEASED = false;

type Context = { params: Promise<{ operation: string }> };

export async function GET(req: Request, context: Context) {
  return crcMarketGet(req, (await context.params).operation, CRC_MARKET_RELEASED, getCrcReadServices);
}

export async function POST(req: Request, context: Context) {
  return crcMarketPost(req, (await context.params).operation, CRC_MARKET_RELEASED, () => {
    const { db, provider, config } = getCrcMutationServices();
    return { db, provider, network: config.network };
  });
}
