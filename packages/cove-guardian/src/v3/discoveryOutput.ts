import type { Buffer } from "node:buffer";
import { decodeDiscovery, discoveryAgreesWithBinary, type ParsedEnvelopeV2 } from "@crclaunch/cove-wire";

/**
 * Guardian-side handling of the advisory `crc-20` discovery envelope (§D1).
 *
 * The authoritative binary envelope lives at vout 0 and is the ONLY source of
 * protocol state. A discovery envelope, when present, is the LAST output and is
 * never read into state — but the Guardian still refuses to sign a transaction
 * whose discovery envelope contradicts the binary one, so a misleading crc-20
 * payload can never be published under a Cove signature.
 *
 * Appending it last (rather than adjacent to vout 0) keeps every existing
 * fixed-index output check unchanged; only the output-count ceiling moves.
 */

export interface DiscoveryOutputCheck {
  /** A trailing OP_RETURN carrying a crc-20 object was found. */
  present: boolean;
  /** It is byte-identical to the canonical re-derivation of the binary envelope. */
  agrees: boolean;
  /** Extra outputs the caps must allow for (1 when present, else 0). */
  allowance: number;
  /** Why it was rejected, when present but not agreeing. */
  reason?: string;
}

const OP_RETURN = 0x6a;

/** Payload of a single-push OP_RETURN script, or null if it is not one. */
export function opReturnPayload(script: Buffer): Buffer | null {
  if (script.length < 2 || script[0] !== OP_RETURN) return null;
  const len = script[1]!;
  if (len === 0x4c) {
    if (script.length < 3 || script.length !== 3 + script[2]!) return null;
    return script.subarray(3);
  }
  if (len > 0x4b || script.length !== 2 + len) return null;
  return script.subarray(2);
}

/**
 * Inspect the final output for a discovery envelope and check it against the
 * authoritative binary envelope.
 *
 * `outputs.length < 2` cannot carry one (vout 0 is the binary envelope), and a
 * trailing OP_RETURN that does not parse as a crc-20 object is NOT treated as a
 * discovery envelope — it falls through to the ordinary unexpected-output
 * checks rather than being silently accepted here.
 */
export function checkDiscoveryOutput(
  outputs: readonly { vout: number; script: Buffer; value: bigint }[],
  binary: ParsedEnvelopeV2,
  ticker?: string,
): DiscoveryOutputCheck {
  const last = outputs[outputs.length - 1];
  if (!last || outputs.length < 2) return { present: false, agrees: false, allowance: 0 };

  const payload = opReturnPayload(last.script);
  if (!payload) return { present: false, agrees: false, allowance: 0 };

  const parsed = decodeDiscovery(payload);
  if (!parsed) return { present: false, agrees: false, allowance: 0 };

  if (last.value !== 0n) {
    return {
      present: true,
      agrees: false,
      allowance: 1,
      reason: `discovery output carries ${last.value} sats; must be 0`,
    };
  }

  if (!discoveryAgreesWithBinary(payload, binary, ticker)) {
    return {
      present: true,
      agrees: false,
      allowance: 1,
      reason: `discovery envelope contradicts the binary envelope: ${payload.toString("utf8").slice(0, 96)}`,
    };
  }

  return { present: true, agrees: true, allowance: 1 };
}
