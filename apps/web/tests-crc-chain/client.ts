/** Test-only entry: calls the same browser service for operations with no baseline form. */
import { signCrcBuildSession, type CrcBrowserBuild, type CrcBrowserReview, type CrcBrowserWallet } from "../src/lib/crc-browser-session";
const target = window as unknown as { __crcChainReview: typeof review; __COVE_TEST_WALLET__: { signPsbt(args: { psbtBase64: string; operation: string }): Promise<string> } };
async function review(built: CrcBrowserBuild, request: CrcBrowserReview, wallet: CrcBrowserWallet) {
  return signCrcBuildSession(built, request, wallet, (psbtBase64, operation) => target.__COVE_TEST_WALLET__.signPsbt({ psbtBase64, operation }));
}
target.__crcChainReview = review;
