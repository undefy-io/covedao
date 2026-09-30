import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { address, networks, Transaction } from "bitcoinjs-lib";
import { describe, expect, it } from "vitest";
import { crc20AssetId, parseCrc20Transaction } from "../src/index.js";

type Fixture = {
  kind: "deploy" | "mint" | "transfer";
  txid: string;
  hex: string;
  toAddress: string | null;
  amountAtoms: string | null;
};

const fixtures = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/leaf-mainnet.json", import.meta.url)), "utf8"),
) as Fixture[];

function outputsOf(tx: Transaction) {
  return tx.outs.map((output) => ({
    valueSats: output.value,
    scriptHex: output.script.toString("hex"),
  }));
}

function marker(payload: unknown) {
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  return `6a${bytes.length < 76 ? bytes.length.toString(16).padStart(2, "0") : `4c${bytes.length.toString(16).padStart(2, "0")}`}${bytes.toString("hex")}`;
}

function markerText(text: string) {
  const bytes = Buffer.from(text, "utf8");
  return `6a${bytes.length.toString(16).padStart(2, "0")}${bytes.toString("hex")}`;
}

const recipient = { valueSats: 330, scriptHex: `5120${"11".repeat(32)}` };
const transfer = { p: "crc-20", op: "transfer", tick: "LEAF", amt: "100000000" };

describe("CRC-20 observed transaction parser", () => {
  it("classifies all 1,950 archived Bitcoin Core transactions from raw bytes", () => {
    expect(fixtures).toHaveLength(1950);
    const counts = { deploy: 0, mint: 0, transfer: 0 };
    for (const fixture of fixtures) {
      const transaction = Transaction.fromHex(fixture.hex);
      expect(transaction.getId()).toBe(fixture.txid);
      const result = parseCrc20Transaction(outputsOf(transaction));
      expect(result.status, fixture.txid).toBe("valid");
      if (result.status !== "valid") continue;
      expect(result.envelope.kind, fixture.txid).toBe(fixture.kind);
      expect(result.envelope.ticker, fixture.txid).toBe("LEAF");
      counts[fixture.kind]++;
      if (fixture.kind === "transfer") {
        expect(result.envelope.kind).toBe("transfer");
        if (result.envelope.kind !== "transfer") continue;
        expect(result.envelope.amountAtoms).toBe(fixture.amountAtoms);
        const output = transaction.outs[result.envelope.recipientVout];
        expect(output).toBeDefined();
        const script = output!.script;
        const witnessVersion = script[0] === 0 ? 0 : 1;
        expect(address.toBech32(script.subarray(2), witnessVersion, networks.bitcoin.bech32)).toBe(
          fixture.toAddress,
        );
      }
    }
    expect(counts).toEqual({ deploy: 1, mint: 812, transfer: 1137 });
  });

  it("keeps ticker-only markers separate from deployment identity", () => {
    const parsed = parseCrc20Transaction([
      { valueSats: 0, scriptHex: marker(transfer) },
      recipient,
    ]);
    expect(parsed.status).toBe("valid");
    if (parsed.status === "valid") {
      expect(parsed.envelope.kind).toBe("transfer");
      expect("assetId" in parsed.envelope).toBe(false);
    }
    const txid = "aa".repeat(32);
    expect(crc20AssetId("mainnet", txid)).toBe(`mainnet:${txid}`);
    expect(crc20AssetId("signet", txid)).toBe(`signet:${txid}`);
    expect(() => crc20AssetId("mainnet", "LEAF")).toThrow();
  });

  it("rejects duplicate CRC markers even when a separate protocol marker is allowed", () => {
    const result = parseCrc20Transaction([
      { valueSats: 0, scriptHex: marker(transfer) },
      recipient,
      { valueSats: 0, scriptHex: marker(transfer) },
      recipient,
    ]);
    expect(result.status).toBe("invalid");
  });

  it("rejects malformed JSON and unsupported OP_RETURN encodings", () => {
    const badJson = Buffer.from('{"p":"crc-20","op":"transfer",', "utf8");
    const malformed = `6a${badJson.length.toString(16).padStart(2, "0")}${badJson.toString("hex")}`;
    expect(parseCrc20Transaction([{ valueSats: 0, scriptHex: malformed }, recipient]).status).toBe(
      "invalid",
    );
    expect(
      parseCrc20Transaction([{ valueSats: 0, scriptHex: `${marker(transfer)}00` }, recipient])
        .status,
    ).toBe("invalid");
    expect(parseCrc20Transaction([{ valueSats: 0, scriptHex: "6a4cff" }, recipient]).status).toBe(
      "invalid",
    );
    expect(parseCrc20Transaction([{ valueSats: 0, scriptHex: "6a01ff" }, recipient]).status).toBe(
      "invalid",
    );
  });

  it("rejects absent or unspendable recipient output and unsupported marker placement", () => {
    const crc = { valueSats: 0, scriptHex: marker(transfer) };
    expect(parseCrc20Transaction([crc]).status).toBe("invalid");
    expect(parseCrc20Transaction([crc, { valueSats: 0, scriptHex: marker({ x: 1 }) }]).status).toBe(
      "invalid",
    );
    expect(parseCrc20Transaction([recipient, recipient, crc, recipient]).status).toBe("invalid");
    expect(
      parseCrc20Transaction([
        recipient,
        { valueSats: 0, scriptHex: marker({ p: "crc-20", op: "deploy", tick: "LEAF" }) },
      ]).status,
    ).toBe("invalid");
    expect(
      parseCrc20Transaction([
        recipient,
        { valueSats: 0, scriptHex: marker({ p: "crc-20", op: "mint", tick: "LEAF" }) },
      ]).status,
    ).toBe("invalid");
  });

  it("rejects wrong ticker, missing amount, and nondecimal transfer amount", () => {
    const inputs = [
      [{ ...transfer, tick: "" }, recipient],
      [{ p: "crc-20", op: "transfer", tick: "LEAF" }, recipient],
      [{ ...transfer, amt: "1.5" }, recipient],
      [{ ...transfer, amt: "0" }, recipient],
    ] as const;
    for (const [payload, output] of inputs) {
      expect(
        parseCrc20Transaction([{ valueSats: 0, scriptHex: marker(payload) }, output]).status,
      ).toBe("invalid");
    }
    expect(
      parseCrc20Transaction([{ valueSats: 0, scriptHex: marker(transfer) }, recipient], {
        expectedTicker: "OTHER",
      }).status,
    ).toBe("invalid");
  });

  it("rejects duplicate top-level JSON keys that could be read differently by indexers", () => {
    for (const ambiguous of [
      '{"p":"other","p":"crc-20","op":"transfer","tick":"LEAF","amt":"1"}',
      '{"p":"crc-20","p":"other","op":"transfer","tick":"LEAF","amt":"1"}',
    ]) {
      expect(
        parseCrc20Transaction([{ valueSats: 0, scriptHex: markerText(ambiguous) }, recipient])
          .status,
      ).toBe("invalid");
    }
  });
});
