import { createDb, type Database } from "@crclaunch/db";
import { serverEnv } from "./server-env";
import type { CrcNetwork } from "./crc-read";

const globalForCrc = globalThis as unknown as { __coveCrcDb?: Database };

export function getCrcReadServices(): { db: Database; network: CrcNetwork } {
  const network = serverEnv.COVE_NETWORK as CrcNetwork;
  const db = globalForCrc.__coveCrcDb ??= createDb(serverEnv.COVE_DATABASE_URL);
  return { db, network };
}
