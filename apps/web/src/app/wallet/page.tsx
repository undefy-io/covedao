import { CrcWalletBalances } from "@/components/CrcWalletBalances";
import LegacyWalletPage from "@/components/legacy-pages/WalletPage";
import { protocolSurface } from "@/lib/protocol-surface";

export default function WalletPage() {
  return protocolSurface(process.env.COVE_PROTOCOL_MODE) === "crc-read-only"
    ? <CrcWalletBalances /> : <LegacyWalletPage />;
}
