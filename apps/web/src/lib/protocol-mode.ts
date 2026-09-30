import { AppError } from "@crclaunch/cove-app";

export type ProtocolMode = "legacy" | "crc20";

export function parseProtocolMode(value: string | undefined): ProtocolMode {
  if (value === undefined || value === "legacy") return "legacy";
  if (value === "crc20") return "crc20";
  throw new Error("COVE_PROTOCOL_MODE must be legacy or crc20");
}

export function assertLegacyProtocolMode(mode: ProtocolMode): void {
  if (mode === "crc20") {
    throw new AppError("PROTOCOL_MIGRATING", "The legacy V3 API is unavailable during CRC-20 cutover");
  }
}
