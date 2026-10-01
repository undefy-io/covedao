import { CrcActivity } from "@/components/CrcActivity";
import LegacyActivityPage from "@/components/legacy-pages/ActivityPage";
import { protocolSurface } from "@/lib/protocol-surface";

export default function ActivityPage() {
  return protocolSurface(process.env.COVE_PROTOCOL_MODE) === "crc-read-only"
    ? <CrcActivity /> : <LegacyActivityPage />;
}
