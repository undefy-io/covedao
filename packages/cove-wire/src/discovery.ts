import { COVE_PROTOCOL_ID, OP_DEPLOY, OP_MINT, OP_REDEEM, OP_TRANSFER, opName } from "./opcodes.js";
import { DATACARRIER_PAYLOAD_LIMIT } from "./opcodes.js";
import type { ParsedEnvelopeV2 } from "./codecV2.js";
import { canonicalTicker } from "./ticker.js";

/**
 * The `crc-20` DISCOVERY envelope (§D1).
 *
 * Cove's authoritative wire format is the fixed-width binary envelope at vout 0
 * (codecV2.ts). This module emits a SECOND, human-readable OP_RETURN carrying a
 * minimal `crc-20` JSON object so that third-party CRC indexers, explorers and
 * wallets can see Cove tokens without implementing the binary codec.
 *
 * AUTHORITY: the binary envelope is the only source of protocol state. The
 * discovery envelope is ADVISORY — never parsed into state, never trusted. The
 * Guardian additionally REJECTS any transaction whose discovery envelope
 * contradicts the binary one, so a lying JSON cannot even be published under a
 * Cove signature, let alone change a balance.
 *
 * RELAY: this requires two OP_RETURN outputs in one transaction. Measured
 * against real Bitcoin Core:
 *   - v28.1 rejects it, `multi-op-return` (non-standard)
 *   - v31.1 accepts, relays and mines it
 * Core 30 relaxed the datacarrier policy. Emitting a discovery envelope is
 * therefore OPT-IN, so a deployment targeting older relays can stay
 * single-envelope.
 */

/** Canonical JSON key order. Fixed so the encoding is byte-deterministic. */
const KEY_ORDER = ["p", "op", "tick", "amt"] as const;

/**
 * Deliberately ticker-keyed, with NO tokenId. A 32-byte tokenId is 64 hex
 * characters and pushes the payload to ~128B, over the 80B datacarrier limit —
 * and existing crc-20 envelopes in the wild are ticker-keyed for the same
 * reason. The authoritative binary envelope at vout 0 carries the real 32-byte
 * tokenId, so identity is never ambiguous where it matters.
 */
export interface DiscoveryEnvelope {
  /** Always `crc-20`. */
  p: string;
  /** `deploy` | `mint` | `transfer` | `redeem`. */
  op: string;
  /** Canonical ticker. */
  tick: string;
  /** Amount in atoms, decimal string. Absent on DEPLOY. */
  amt?: string;
}

export class DiscoveryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DiscoveryError";
    this.code = code;
  }
}

/** Deterministic serialization: fixed key order, no whitespace, no optional keys when absent. */
export function serializeDiscovery(env: DiscoveryEnvelope): Buffer {
  const parts: string[] = [];
  for (const k of KEY_ORDER) {
    const v = env[k];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(k)}:${JSON.stringify(v)}`);
  }
  return Buffer.from(`{${parts.join(",")}}`, "utf8");
}

/**
 * Derive the discovery envelope that corresponds to a binary envelope. This is
 * the ONLY way a discovery envelope is produced, so the two can never drift:
 * both are functions of the same parsed binary message.
 */
export function discoveryFor(binary: ParsedEnvelopeV2): DiscoveryEnvelope {
  const op = opName(binary.op);
  switch (binary.op) {
    case OP_DEPLOY:
      return { p: COVE_PROTOCOL_ID, op, tick: canonicalTicker(binary.ticker) };
    case OP_MINT:
      // Same shape as every other crc-20 mint (LEAF, BONS): no amount. The
      // amount lives in the binary envelope; the crc-20 line only announces it.
      return { p: COVE_PROTOCOL_ID, op, tick: "" };
    case OP_TRANSFER: {
      const total = binary.allocations.reduce((a, x) => a + x.amount, 0n);
      return { p: COVE_PROTOCOL_ID, op, tick: "", amt: total.toString() };
    }
    case OP_REDEEM:
      return { p: COVE_PROTOCOL_ID, op, tick: "", amt: binary.redeemAmount.toString() };
    default: {
      // Exhaustive over ParsedEnvelopeV2 — adding an opcode without handling it
      // here becomes a compile error rather than an untagged discovery envelope.
      const unreachable: never = binary;
      throw new DiscoveryError("BAD_OPCODE", `cannot derive discovery envelope: ${String(unreachable)}`);
    }
  }
}

/**
 * Encode a discovery envelope for a binary message, optionally carrying the
 * ticker (which the binary MINT/TRANSFER/REDEEM payloads omit — they reference
 * the tokenId). Throws if the result would exceed the datacarrier limit.
 */
export function encodeDiscovery(binary: ParsedEnvelopeV2, ticker?: string): Buffer {
  const env = discoveryFor(binary);
  if (ticker !== undefined && env.tick === "") env.tick = canonicalTicker(ticker);
  if (env.tick === "") delete (env as { tick?: string }).tick;
  const bytes = serializeDiscovery(env);
  if (bytes.length > DATACARRIER_PAYLOAD_LIMIT) {
    throw new DiscoveryError(
      "DISCOVERY_TOO_LARGE",
      `discovery envelope is ${bytes.length}B, limit ${DATACARRIER_PAYLOAD_LIMIT}B`,
    );
  }
  return bytes;
}

/** Parse a discovery payload. Returns null for anything that is not one — never throws on junk. */
export function decodeDiscovery(payload: Buffer): DiscoveryEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (o.p !== COVE_PROTOCOL_ID) return null;
  if (typeof o.op !== "string") return null;
  const env: DiscoveryEnvelope = { p: o.p, op: o.op, tick: typeof o.tick === "string" ? o.tick : "" };
  if (typeof o.amt === "string") env.amt = o.amt;
  if (env.tick === "") delete (env as { tick?: string }).tick;
  return env;
}

/**
 * Does this discovery payload agree with the authoritative binary envelope?
 *
 * Byte equality against the canonical re-derivation, so there is exactly one
 * acceptable discovery payload per binary message. Anything else — a different
 * amount, a different tokenId, a reordered key, injected whitespace, an extra
 * field — fails. The Guardian refuses to sign such a transaction.
 */
export function discoveryAgreesWithBinary(payload: Buffer, binary: ParsedEnvelopeV2, ticker?: string): boolean {
  let expected: Buffer;
  try {
    expected = encodeDiscovery(binary, ticker);
  } catch {
    return false;
  }
  return payload.equals(expected);
}
