import { CrcExplore } from "@/components/CrcExplore";
import LegacyExplorePage from "@/components/legacy-pages/ExplorePage";
import { protocolSurface } from "@/lib/protocol-surface";

export default function ExplorePage() {
  return protocolSurface(process.env.COVE_PROTOCOL_MODE) === "crc-read-only"
    ? <CrcExplore /> : <LegacyExplorePage />;
}
