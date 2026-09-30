import { parseProtocolMode } from "./protocol-mode";

export function protocolSurface(value: string | undefined): "legacy" | "crc-read-only" {
  return parseProtocolMode(value) === "crc20" ? "crc-read-only" : "legacy";
}
