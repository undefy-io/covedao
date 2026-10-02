import { execFileSync } from "node:child_process";
import { Transaction, address, networks, initEccLib } from "bitcoinjs-lib";
import { expect, test } from "vitest";
import * as ecc from "tiny-secp256k1";
initEccLib(ecc);

function archive(name: string) {
  const path = new URL(`../../../artifacts/crc-garden/${name}`, import.meta.url).pathname;
  const program =
    'import sqlite3,json,sys\nc=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True)\nc.row_factory=sqlite3.Row\nprint(json.dumps({t:[dict(r) for r in c.execute("select * from "+t)] for t in sys.argv[2:]}))';
  return JSON.parse(
    execFileSync(
      "python3",
      [
        "-c",
        program,
        path,
        ...(name.startsWith("activity")
          ? ["transactions", "outputs", "events"]
          : ["parents", "prevouts"]),
      ],
      { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
    ),
  );
}

test("all 1950 Garden raw transactions reproduce txids, every exact output, marker and spendable recipient; archived parents reproduce input values", async () => {
  const { decodeTransaction, parseRawTransaction } = await import("./index.ts");
  const data = archive("activity-2026-09-30.sqlite");
  const parents = archive("parent-prevouts.sqlite");
  const byTx = new Map<string, any[]>();
  for (const row of data.outputs) byTx.set(row.txid, [...(byTx.get(row.txid) ?? []), row]);
  expect(data.transactions).toHaveLength(1950);
  expect(data.events).toHaveLength(1950);
  const raw = new Map<string, Transaction>();
  for (const parent of parents.parents) {
    const tx = Transaction.fromHex(parent.raw_hex);
    expect(tx.getId()).toBe(parent.txid);
    expect(parseRawTransaction(parent.raw_hex).txid).toBe(parent.txid);
    raw.set(parent.txid, tx);
  }
  for (const row of data.transactions) {
    const tx = Transaction.fromHex(JSON.parse(row.raw_json).hex);
    expect(tx.getId()).toBe(row.txid);
    raw.set(row.txid, tx);
  }
  let mint = 0,
    transfer = 0,
    deploy = 0,
    checkedInputs = 0,
    ordi = 0,
    btcMints = 0,
    thousandSatTransfers = 0;
  for (const row of data.transactions) {
    const tx = raw.get(row.txid)!;
    const decodedRaw = parseRawTransaction(JSON.parse(row.raw_json).hex);
    expect(decodedRaw.txid).toBe(row.txid);
    expect(decodedRaw.outputs.map((o) => o.sats)).toEqual(tx.outs.map((o) => BigInt(o.value)));
    expect(decodedRaw.outputs.map((o) => o.scriptHex)).toEqual(
      tx.outs.map((o) => o.script.toString("hex")),
    );
    const outputs = byTx.get(row.txid)!.sort((a, b) => a.vout - b.vout);
    expect(tx.outs).toHaveLength(outputs.length);
    for (const out of outputs) {
      expect(tx.outs[out.vout]!.value).toBe(out.value_sats);
      expect(tx.outs[out.vout]!.script.toString("hex")).toBe(out.script_hex);
      if (out.address)
        expect(address.fromOutputScript(tx.outs[out.vout]!.script, networks.bitcoin)).toBe(
          out.address,
        );
    }
    const decoded = decodeTransaction(outputs);
    const marker = outputs[decoded.markerVout];
    expect(decoded.markerJson).toBe(marker.op_return_text);
    expect(Buffer.from(marker.op_return_payload_hex, "hex").toString("utf8")).toBe(
      decoded.markerJson,
    );
    const event = data.events.find((e: any) => e.txid === row.txid);
    const json = JSON.parse(decoded.markerJson);
    expect(json.op).toBe(event.kind);
    expect(json.tick).toBe(event.tick);
    if (json.op === "mint") {
      mint++;
      if (event.mint_payment_asset === "BTC") {
        btcMints++;
        expect(decoded.markerVout).toBe(0);
        expect(outputs[1].value_sats).toBe(330);
        expect(BigInt(outputs[2].value_sats)).toBe(BigInt(event.mint_payment_amount_atoms));
        expect(outputs[2].address).toBe(
          "bc1phuuulh7fs5zrm48ethfyqvt860fxsaxuq643telqn06yz4u3c70spyleaf",
        );
      }
      expect(Object.keys(json)).toEqual(["p", "op", "tick"]);
      expect(decoded.amountAtoms).toBeUndefined();
    } else if (json.op === "transfer") {
      transfer++;
      if (outputs[decoded.recipientVout].value_sats === 1000) thousandSatTransfers++;
      expect(Object.keys(json)).toEqual(["p", "op", "tick", "amt"]);
      expect(decoded.amountAtoms).toBe(BigInt(event.amount_atoms));
    } else {
      deploy++;
      expect(Object.keys(json)).toEqual([
        "p",
        "op",
        "tick",
        "type",
        "max",
        "lim",
        "leaf",
        "ordi",
        "btc",
      ]);
    }
    if (json.op !== "deploy") {
      expect(decoded.recipientVout).toBe(decoded.markerVout + 1);
      if (event.mint_payment_asset === "ORDI") {
        // These eight amountless mints put payment after the marker and the
        // archive's reported beneficiary at output 2. This is not Cove's layout.
        ordi++;
        expect(outputs[2].address).toBe(event.to_address);
        expect(outputs[decoded.recipientVout].address).not.toBe(event.to_address);
      } else expect(outputs[decoded.recipientVout].address).toBe(event.to_address);
      expect(outputs[decoded.recipientVout].script_type).not.toBe("nulldata");
    }
    let inputSats = 0;
    let complete = true;
    for (const input of tx.ins) {
      const parentId = Buffer.from(input.hash).reverse().toString("hex");
      const parent = raw.get(parentId);
      if (!parent) {
        complete = false;
        continue;
      }
      const prevout = parents.prevouts.find(
        (p: any) => p.txid === parentId && p.vout === input.index,
      );
      const out = parent.outs[input.index]!;
      expect(prevout).toBeDefined();
      expect(out.value).toBe(prevout.value_sats);
      expect(out.script.toString("hex")).toBe(prevout.script_hex);
      inputSats += out.value;
      checkedInputs++;
    }
    expect(complete).toBe(true);
    expect(inputSats - tx.outs.reduce((sum, o) => sum + o.value, 0)).toBeGreaterThanOrEqual(0);
  }
  expect({ deploy, mint, transfer }).toEqual({ deploy: 1, mint: 812, transfer: 1137 });
  expect(ordi).toBe(8);
  expect(btcMints).toBe(159);
  expect(thousandSatTransfers).toBe(743);
  expect(checkedInputs).toBe(5190);
}, 120000);
