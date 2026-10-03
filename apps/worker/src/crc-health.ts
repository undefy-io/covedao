import { readFileSync } from "node:fs";
import { crcHealthPath, crcWorkerHealthy } from "./crc-health-policy.js";
const network = process.env.COVE_NETWORK ?? "";
try {
  const observation: unknown = JSON.parse(readFileSync(crcHealthPath(process.env.COVE_DATABASE_URL || process.env.DATABASE_URL || "", network), "utf8"));
  process.exitCode = crcWorkerHealthy(observation, network, Date.now(), (pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }) ? 0 : 1;
} catch { process.exitCode = 1; }
