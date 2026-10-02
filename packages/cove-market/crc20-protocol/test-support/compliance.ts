import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Transaction, script } from "bitcoinjs-lib";
import type { ChainTransaction, Plan } from "../types.js";

export type CoveAction =
  | "deploy"
  | "mint"
  | "transfer"
  | "curveSell"
  | "inventoryBuy"
  | "listing"
  | "marketBuy"
  | "cancel";
interface ArchiveOutput {
  vout: number;
  value_sats: number;
  script_hex: string;
  op_return_text: string | null;
}
interface Reference {
  txid: string;
  outputs: ArchiveOutput[];
  rawHex: string;
  prevouts: { txid: string; vout: number; sats: number; scriptHex: string }[];
}
let references: Record<string, Reference> | undefined;
function archiveReferences(): Record<string, Reference> {
  if (references) return references;
  const archive = new URL(
    "../../../../artifacts/crc-garden/activity-2026-09-30.sqlite",
    import.meta.url,
  ).pathname;
  const parents = new URL(
    "../../../../artifacts/crc-garden/parent-prevouts.sqlite",
    import.meta.url,
  ).pathname;
  const program = `import sqlite3,json,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
p=sqlite3.connect('file:'+sys.argv[2]+'?mode=ro',uri=True);p.row_factory=sqlite3.Row
ids={'deploy':'546cc042d0f396a0d8ad67b6987d9d5c09619e6962738347ca1611a1d1841b67','mint':'17c4c6fa3a877aa42c142f4836c3cb6b10d4e588ff2150df842e2e3e3e89bde4','marketBuy':'532f22d0edcd848d28b81ddb6b089402860d01fda2ec1fdb9701ea13bb0a2dcd'}
ids['transfer']=c.execute("select txid from outputs where vout=0 and op_return_text like '%transfer%' order by txid limit 1").fetchone()[0]
result={}
for kind,id in ids.items():
 t=json.loads(c.execute('select raw_json from transactions where txid=?',(id,)).fetchone()[0]); prev=[]
 for i in t['vin']:
  o=p.execute('select value_sats,script_hex from prevouts where txid=? and vout=?',(i['txid'],i['vout'])).fetchone()
  assert o is not None
  prev.append({'txid':i['txid'],'vout':i['vout'],'sats':o['value_sats'],'scriptHex':o['script_hex']})
 result[kind]={'txid':id,'rawHex':t['hex'],'outputs':[dict(o) for o in c.execute('select vout,value_sats,script_hex,op_return_text from outputs where txid=? order by vout',(id,))],'prevouts':prev}
print(json.dumps(result))`;
  references = JSON.parse(
    execFileSync("python3", ["-c", program, archive, parents], { encoding: "utf8" }),
  );
  return references!;
}
const scriptFamily = (value: string) =>
  /^0014[0-9a-f]{40}$/.test(value)
    ? "P2WPKH"
    : /^5120[0-9a-f]{64}$/.test(value)
      ? "P2TR"
      : value.startsWith("6a")
        ? "OP_RETURN"
        : "other";
const opFor = (action: CoveAction) =>
  action === "deploy" ? "deploy" : action === "mint" ? "mint" : "transfer";
const referenceFor = (action: CoveAction) =>
  action === "deploy"
    ? "deploy"
    : action === "mint"
      ? "mint"
      : action === "marketBuy"
        ? "marketBuy"
        : "transfer";
const point = (txid: string, vout: number) => `${txid}:${vout}`;
const allowedRoles = new Set([
  "marker",
  "vault",
  "creatorRecord",
  "protocolFee",
  "recipient",
  "tokenChange",
  "btcChange",
  "sellerPayout",
  "payout",
  "creatorFee",
]);

/** Test-only comparison against observed Garden wire rules, not an assertion of Garden ledger acceptance. */
export function checkGardenCompliance(
  plan: Plan,
  transaction: ChainTransaction,
  action: CoveAction,
) {
  const reference = archiveReferences()[referenceFor(action)]!;
  const garden = Transaction.fromHex(reference.rawHex),
    tx = Transaction.fromHex(transaction.rawHex);
  assert.equal(garden.getId(), reference.txid, "SQLite reference txid");
  assert.equal(tx.version, 2, "Cove transaction version");
  assert.equal(tx.locktime, 0, "Cove transaction locktime");
  assert.equal(tx.ins.length, plan.inputs.length, "all planned inputs present");
  assert.equal(tx.ins.length, transaction.prevouts.length, "all actual prevouts supplied");
  assert.equal(tx.outs.length, plan.outputs.length, "all planned outputs present");
  const markerIndex = tx.outs.findIndex((o) => o.script[0] === 0x6a);
  assert.equal(tx.outs.filter((o) => o.script[0] === 0x6a).length, 1, "one marker");
  const pushed = script.decompile(tx.outs[markerIndex]!.script);
  assert.ok(
    pushed && pushed.length === 2 && Buffer.isBuffer(pushed[1]),
    "single marker payload push",
  );
  const markerJson = (pushed[1] as Buffer).toString("utf8");
  const marker = JSON.parse(markerJson),
    gardenMarker = reference.outputs.find((o) => o.op_return_text?.includes("crc-20"))!;
  const expected = JSON.parse(gardenMarker.op_return_text!);
  assert.equal(markerJson, plan.markerJson, "exact built marker bytes");
  assert.equal(markerJson, JSON.stringify(marker), "canonical JSON bytes");
  assert.deepEqual(Object.keys(marker), Object.keys(expected), "SQLite marker field order");
  assert.equal(marker.p, expected.p, "protocol identifier");
  assert.equal(marker.op, opFor(action), "operation family");
  assert.ok(
    Object.values(marker).every((v) => typeof v === "string"),
    "all marker values are strings like the archive",
  );
  assert.ok(/^[A-Za-z0-9]{1,16}$/.test(marker.tick), "asset ticker encoding");
  assert.equal(tx.outs[markerIndex]!.value, 0, "zero-value marker");
  assert.equal(markerIndex, gardenMarker.vout, "observed marker position");
  assert.equal(markerIndex, plan.markerVout);
  if (marker.op !== "deploy") {
    const recipient = tx.outs[markerIndex + 1]!;
    assert.ok(
      recipient && recipient.value > 0 && recipient.script[0] !== 0x6a,
      "spendable recipient immediately after marker",
    );
    assert.equal(plan.recipientVout, markerIndex + 1);
  }
  if (marker.op === "mint") assert.equal(marker.amt, undefined, "Garden mint has no amount");
  if (marker.op === "transfer") {
    assert.ok(/^[1-9][0-9]*$/.test(marker.amt), "canonical transfer amount");
    assert.equal(
      BigInt(marker.amt),
      plan.outputs[plan.recipientVout]!.atoms,
      "amount bound to recipient allocation",
    );
  }
  const differences: string[] = [];
  if (tx.ins.length !== garden.ins.length)
    differences.push("input count differs from archived example");
  if (tx.outs.length !== garden.outs.length)
    differences.push("Cove output count/roles differ from archived example");
  if (marker.tick !== expected.tick) differences.push("Cove asset ticker differs");
  if (markerJson !== gardenMarker.op_return_text)
    differences.push("marker values differ for this asset/amount");
  const inputs = tx.ins.map((input, index) => {
    assert.equal(input.sequence, 0xfffffffe, "Cove input sequence");
    assert.equal(input.script.length, 0, "native SegWit scriptSig");
    const txid = Buffer.from(input.hash).reverse().toString("hex"),
      actual = transaction.prevouts[index]!,
      planned = plan.inputs[index]!,
      archived = reference.prevouts[index];
    assert.equal(
      point(txid, input.index),
      point(actual.txid, actual.vout),
      "raw input references actual prevout",
    );
    assert.equal(
      point(txid, input.index),
      point(planned.txid, planned.vout),
      "raw input references quoted outpoint",
    );
    assert.equal(BigInt(actual.sats), BigInt(planned.sats), "every input BTC value");
    assert.equal(actual.scriptHex, planned.scriptHex, "every input ownership script");
    return {
      vin: index,
      sequence: input.sequence,
      scriptSigHex: input.script.toString("hex"),
      witnessItems: input.witness.length,
      archiveSequence: garden.ins[index]?.sequence ?? null,
      archiveWitnessItems: garden.ins[index]?.witness.length ?? null,
      outpoint: point(txid, input.index),
      sats: BigInt(actual.sats).toString(),
      scriptHex: actual.scriptHex,
      scriptFamily: scriptFamily(actual.scriptHex),
      archiveReference: archived ?? null,
      comparison:
        "Cove outpoint and ownership differ by asset/network; prevout identity/value checked exactly",
    };
  });
  assert.equal(
    new Set(inputs.map((i) => i.outpoint)).size,
    inputs.length,
    "unique input outpoints",
  );
  const outputs = tx.outs.map((output, index) => {
    const planned = plan.outputs[index]!,
      archived = reference.outputs[index];
    assert.ok(
      planned.role && allowedRoles.has(planned.role),
      "every output has a checked Cove role",
    );
    assert.equal(BigInt(output.value), planned.sats, "every output BTC value");
    assert.equal(output.script.toString("hex"), planned.scriptHex, "every output script");
    return {
      vout: index,
      role: planned.role,
      sats: BigInt(output.value).toString(),
      scriptHex: output.script.toString("hex"),
      scriptFamily: scriptFamily(planned.scriptHex),
      archiveReference: archived ?? null,
      valueEqualToArchive: archived ? output.value === archived.value_sats : false,
      scriptEqualToArchive: archived ? planned.scriptHex === archived.script_hex : false,
    };
  });
  const minerFee =
    transaction.prevouts.reduce((sum, i) => sum + BigInt(i.sats), 0n) -
    tx.outs.reduce((sum, o) => sum + BigInt(o.value), 0n);
  assert.equal(minerFee, plan.minerFeeSats, "sum(inputs) = sum(outputs) + miner fee");
  assert.ok(minerFee > 0n && minerFee <= 20000n, "Cove miner fee policy");
  assert.equal(
    plan.outputs.filter((o) => o.role === "protocolFee").reduce((sum, o) => sum + o.sats, 0n),
    plan.protocolFeeSats,
    "platform fee matches declared quote",
  );
  assert.equal(
    plan.outputs.filter((o) => o.role === "creatorFee").reduce((sum, o) => sum + o.sats, 0n),
    plan.creatorFeeSats,
    "creator fee matches declared quote",
  );
  differences.push(
    "registered native SegWit scripts differ from archived mainnet Taproot scripts",
    "Cove fees, backing and extra change outputs are checked against Cove plans, not inferred from Garden",
  );
  return {
    action,
    txid: tx.getId(),
    archiveReference: {
      txid: reference.txid,
      operation: expected.op,
      markerVout: gardenMarker.vout,
      inputCount: garden.ins.length,
      outputCount: garden.outs.length,
    },
    sharedWirePassed: true,
    exactGardenTransactionMatch: transaction.rawHex === reference.rawHex,
    inputs,
    outputs,
    minerFeeSats: minerFee.toString(),
    platformFeeSats: plan.protocolFeeSats.toString(),
    creatorFeeSats: plan.creatorFeeSats.toString(),
    differences,
    unprovenClaims: [
      "Garden fee policy and issuance/ownership rules",
      "Garden validator acceptance of Cove assets",
    ],
  };
}
export type ComplianceReport = ReturnType<typeof checkGardenCompliance>;
