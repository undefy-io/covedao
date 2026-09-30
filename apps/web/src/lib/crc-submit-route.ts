import { fail, handleError, ok, readJson, strField } from "./api";
import { getCrcMutationServices } from "./crc-mutation";
import { checkCrcRateLimit } from "./crc-rate-limit";
import { submitCrcSession } from "./crc-submit";

export async function crcSubmitRoute(req: Request, expectedOperation: "deploy" | "buy" | "sell"): Promise<Response> {
  try {
    const limited = checkCrcRateLimit(req, true);
    if (limited) return limited;
    const { db, config, provider, guardianEndpoint, guardianAuthToken } = getCrcMutationServices();
    const body = await readJson(req);
    const sessionId = strField(body, "sessionId");
    const signedPsbtBase64 = strField(body, "signedPsbtBase64");
    if (!/^[0-9a-fA-F-]{36}$/.test(sessionId) || !signedPsbtBase64) {
      return fail("BAD_REQUEST", "A build session and signed PSBT are required", 400);
    }
    return ok(await submitCrcSession({
      db, network: config.network, provider, guardianEndpoint, guardianAuthToken,
      sessionId, signedPsbtBase64, expectedOperation,
    }));
  } catch (error) {
    return handleError(error);
  }
}
