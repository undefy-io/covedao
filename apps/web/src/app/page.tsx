import { CrcHome } from "@/components/CrcHome";
import LegacyHome from "@/components/LegacyHome";
import { protocolSurface } from "@/lib/protocol-surface";

export default function HomePage() {
  return protocolSurface(process.env.COVE_PROTOCOL_MODE) === "crc-read-only" ? <CrcHome /> : <LegacyHome />;
}
