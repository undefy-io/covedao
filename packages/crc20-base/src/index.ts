export type BitcoinNetwork = "mainnet" | "testnet" | "signet" | "regtest";

export type TxOutput = {
  valueSats: number;
  scriptHex: string;
};

export type Crc20Envelope =
  | { kind: "deploy"; ticker: string; markerVout: number; payload: Record<string, unknown> }
  | { kind: "mint"; ticker: string; markerVout: number; payload: Record<string, unknown> }
  | {
      kind: "transfer";
      ticker: string;
      markerVout: number;
      recipientVout: number;
      amountAtoms: string;
      payload: Record<string, unknown>;
    };

export type ParseResult =
  | { status: "none" }
  | { status: "invalid"; reason: string }
  | { status: "valid"; envelope: Crc20Envelope };

function invalid(reason: string): ParseResult {
  return { status: "invalid", reason };
}

export function crc20AssetId(network: BitcoinNetwork, deploymentTxid: string): string {
  if (!/^(mainnet|testnet|signet|regtest)$/.test(network)) throw new Error("invalid network");
  if (!/^[0-9a-f]{64}$/.test(deploymentTxid)) throw new Error("invalid deployment txid");
  return `${network}:${deploymentTxid}`;
}

function decodeSinglePush(scriptHex: string): {
  status: "none" | "invalid" | "decoded";
  text?: string;
} {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(scriptHex)) return { status: "invalid" };
  const script = Buffer.from(scriptHex, "hex");
  if (script[0] !== 0x6a) return { status: "none" };
  if (script.length < 2) return { status: "invalid" };
  let cursor = 1;
  let length = script[cursor++];
  if (length === undefined) return { status: "invalid" };
  if (length === 0x4c) {
    if (cursor >= script.length) return { status: "invalid" };
    length = script[cursor++];
  } else if (length === 0x4d) {
    if (cursor + 2 > script.length) return { status: "invalid" };
    length = script.readUInt16LE(cursor);
    cursor += 2;
  } else if (length === 0x4e) {
    if (cursor + 4 > script.length) return { status: "invalid" };
    length = script.readUInt32LE(cursor);
    cursor += 4;
  } else if (length > 0x4b) {
    return { status: "invalid" };
  }
  if (length === undefined) return { status: "invalid" };
  if (length > 4096 || cursor + length !== script.length) return { status: "invalid" };
  try {
    return {
      status: "decoded",
      text: new TextDecoder("utf-8", { fatal: true }).decode(script.subarray(cursor)),
    };
  } catch {
    return { status: "invalid" };
  }
}

function isSpendable(output: TxOutput | undefined): boolean {
  if (!output || !Number.isSafeInteger(output.valueSats) || output.valueSats <= 0) return false;
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(output.scriptHex)) return false;
  const script = Buffer.from(output.scriptHex, "hex");
  if (script[0] === 0x6a) return false;
  if (script.length === 22 && script[0] === 0 && script[1] === 0x14) return true;
  if (script.length === 34 && script[0] === 0 && script[1] === 0x20) return true;
  if (script.length === 34 && script[0] === 0x51 && script[1] === 0x20) return true;
  if (
    script.length === 25 &&
    script[0] === 0x76 &&
    script[1] === 0xa9 &&
    script[2] === 0x14 &&
    script[23] === 0x88 &&
    script[24] === 0xac
  )
    return true;
  if (script.length === 23 && script[0] === 0xa9 && script[1] === 0x14 && script[22] === 0x87)
    return true;
  return false;
}

function hasDuplicateTopLevelKey(json: string): boolean {
  const keys = new Set<string>();
  let depth = 0;
  for (let index = 0; index < json.length; index++) {
    const character = json[index];
    if (character === "{" || character === "[") {
      depth++;
    } else if (character === "}" || character === "]") {
      depth--;
    } else if (character === '"') {
      const start = index;
      index++;
      while (index < json.length) {
        if (json[index] === "\\") {
          index += 2;
          continue;
        }
        if (json[index] === '"') break;
        index++;
      }
      if (depth !== 1) continue;
      let next = index + 1;
      while (/\s/.test(json[next] ?? "")) next++;
      if (json[next] !== ":") continue;
      const key = JSON.parse(json.slice(start, index + 1)) as string;
      if (keys.has(key)) return true;
      keys.add(key);
    }
  }
  return false;
}

export function parseCrc20Transaction(
  outputs: readonly TxOutput[],
  options: { expectedTicker?: string } = {},
): ParseResult {
  let found: { payload: Record<string, unknown>; vout: number } | undefined;
  for (let vout = 0; vout < outputs.length; vout++) {
    const output = outputs[vout];
    if (!output) return invalid("missing output");
    const decoded = decodeSinglePush(output.scriptHex);
    if (decoded.status === "invalid") return invalid("malformed script or OP_RETURN encoding");
    if (decoded.status === "none") continue;
    const text = decoded.text ?? "";
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      if (text.includes("crc-20")) return invalid("malformed CRC-20 JSON");
      continue;
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) continue;
    const record = payload as Record<string, unknown>;
    if (text.includes("crc-20") && hasDuplicateTopLevelKey(text)) {
      return invalid("duplicate CRC marker field");
    }
    if (record.p !== "crc-20") continue;
    if (output.valueSats !== 0) return invalid("CRC marker must carry zero sats");
    if (found) return invalid("multiple CRC markers");
    found = { payload: record, vout };
  }
  if (!found) return { status: "none" };
  const { payload, vout } = found;
  if (typeof payload.tick !== "string" || !/^[A-Za-z0-9]{1,16}$/.test(payload.tick)) {
    return invalid("invalid ticker");
  }
  if (options.expectedTicker !== undefined && options.expectedTicker !== payload.tick) {
    return invalid("ticker mismatch");
  }
  if (payload.op === "deploy") {
    if (vout !== 0) return invalid("unsupported deploy marker placement");
    return {
      status: "valid",
      envelope: { kind: "deploy", ticker: payload.tick, markerVout: vout, payload },
    };
  }
  if (payload.op === "mint") {
    if (vout !== 0 && vout !== 2) return invalid("unsupported mint marker placement");
    if (vout === 2 && decodeSinglePush(outputs[0]?.scriptHex ?? "").status !== "decoded") {
      return invalid("unsupported mint companion layout");
    }
    return {
      status: "valid",
      envelope: { kind: "mint", ticker: payload.tick, markerVout: vout, payload },
    };
  }
  if (payload.op === "transfer") {
    if (vout !== 0 && vout !== 1) return invalid("unsupported transfer marker placement");
    if (typeof payload.amt !== "string" || !/^[1-9][0-9]*$/.test(payload.amt)) {
      return invalid("invalid transfer amount");
    }
    if (!isSpendable(outputs[vout + 1])) return invalid("missing spendable recipient output");
    return {
      status: "valid",
      envelope: {
        kind: "transfer",
        ticker: payload.tick,
        markerVout: vout,
        recipientVout: vout + 1,
        amountAtoms: payload.amt,
        payload,
      },
    };
  }
  return invalid("unsupported CRC operation");
}
