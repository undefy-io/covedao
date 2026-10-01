import { CrcLaunchForm } from "@/components/CrcLaunchForm";
import LegacyLaunchPage from "@/components/legacy-pages/LaunchPage";
import { protocolSurface } from "@/lib/protocol-surface";

export default function LaunchPage() {
  return protocolSurface(process.env.COVE_PROTOCOL_MODE) === "crc-read-only"
    ? <CrcLaunchForm /> : <LegacyLaunchPage />;
}
