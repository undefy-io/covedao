import { CrcMarketPageContent } from "@/components/CrcMarketPageContent";
import LegacyMarketPage from "@/components/legacy-pages/MarketPage";
import { protocolSurface } from "@/lib/protocol-surface";

export default function MarketPage() {
  return protocolSurface(process.env.COVE_PROTOCOL_MODE) === "crc-read-only"
    ? <CrcMarketPageContent /> : <LegacyMarketPage />;
}
