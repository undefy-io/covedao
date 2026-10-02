import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'vitest';

const archive = new URL('../../../artifacts/crc-garden/activity-2026-09-30.sqlite', import.meta.url).pathname;

function query(sql: string, params: string[] = []): Record<string, any>[] {
  const program = 'import json,sqlite3,sys\nconnection=sqlite3.connect(sys.argv[1])\nconnection.row_factory=sqlite3.Row\nprint(json.dumps([dict(row) for row in connection.execute(sys.argv[2],json.loads(sys.argv[3]))]))';
  return JSON.parse(execFileSync('python3', ['-c', program, archive, sql, JSON.stringify(params)], { encoding: 'utf8' }));
}

const cases = [
  {
    name: 'deploy',
    txid: '546cc042d0f396a0d8ad67b6987d9d5c09619e6962738347ca1611a1d1841b67',
    markerVout: 0,
    marker: '{"p":"crc-20","op":"deploy","tick":"LEAF","type":"bonding","max":"1000000000","lim":"2100000000","leaf":"1","ordi":"286","btc":"3333333"}',
    nextValue: 208760,
  },
  {
    name: 'BTC mint',
    txid: '17c4c6fa3a877aa42c142f4836c3cb6b10d4e588ff2150df842e2e3e3e89bde4',
    markerVout: 0,
    marker: '{"p":"crc-20","op":"mint","tick":"LEAF"}',
    nextValue: 330,
    paymentVout: 2,
    paymentValue: 30000,
  },
  {
    name: 'sale',
    txid: '532f22d0edcd848d28b81ddb6b089402860d01fda2ec1fdb9701ea13bb0a2dcd',
    markerVout: 1,
    marker: '{"p":"crc-20","op":"transfer","tick":"LEAF","amt":"6800000000000"}',
    nextValue: 1000,
    sellerValue: 434500,
  },
  {
    name: 'custom amount sale',
    txid: 'c4a840c7c4bbe0f8cce6a03cb71664be7e6b7c730f4e1e1f89d52f973a822118',
    markerVout: 1,
    marker: '{"p":"crc-20","op":"transfer","tick":"LEAF","amt":"50000000000"}',
    nextValue: 1000,
    sellerValue: 49840,
  },
];

test('the archive contains the stated deploy, mint, and transfer evidence', () => {
  assert.deepEqual(query('select kind,count(*) as count from events group by kind order by kind'), [
    { kind: 'deploy', count: 1 },
    { kind: 'mint', count: 812 },
    { kind: 'transfer', count: 1137 },
  ]);
  for (const item of cases) {
    const outputs = query('select vout,value_sats,op_return_text from outputs where txid=? order by vout', [item.txid]);
    assert.equal(outputs[item.markerVout].op_return_text, item.marker, item.name);
    assert.equal(outputs[item.markerVout].value_sats, 0, item.name);
    assert.equal(outputs[item.markerVout + 1].value_sats, item.nextValue, item.name);
    if (item.paymentVout !== undefined) assert.equal(outputs[item.paymentVout].value_sats, item.paymentValue);
    if (item.sellerValue !== undefined) assert.equal(outputs[0].value_sats, item.sellerValue);
  }
});

test('the public wire decoder preserves Garden marker bytes and recipient position', async () => {
  const { decodeTransaction } = await import('./index.ts');
  for (const item of cases) {
    const outputs = query('select vout,value_sats,script_hex,op_return_text from outputs where txid=? order by vout', [item.txid]);
    const decoded = decodeTransaction(outputs);
    assert.equal(decoded.markerVout, item.markerVout, item.name);
    assert.equal(decoded.markerJson, item.marker, item.name);
    if (item.name !== 'deploy') assert.equal(decoded.recipientVout, item.markerVout + 1, item.name);
    if (item.name === 'BTC mint') assert.equal(decoded.amountAtoms, undefined, 'Garden mint amount is absent from the marker');
  }
});

test('the listing builder creates one transaction with exact listed and remainder carriers', async () => {
  const { buildListing } = await import('./index.ts');
  const listing = buildListing({
    network: 'regtest', deployTxid: 'a'.repeat(64), ticker: 'TEST',
    input: { txid: 'b'.repeat(64), vout: 0, atoms: 200000000000n, sats: 1000, scriptHex: '0014' + '11'.repeat(20) },
    amountAtoms: 50000000000n, priceSats: 12347n,
    sellerScriptHex: '0014' + '11'.repeat(20),
  });
  assert.equal(listing.transactions.length, 1);
  assert.equal(listing.listedAtoms, 50000000000n);
  assert.equal(listing.changeAtoms, 150000000000n);
  assert.equal(listing.markerJson, '{"p":"crc-20","op":"transfer","tick":"TEST","amt":"50000000000"}');
});

test('the purchase builder creates one atomic payment and token transfer transaction', async () => {
  const { buildPurchase } = await import('./index.ts');
  const purchase = buildPurchase({
    network: 'regtest', deployTxid: 'a'.repeat(64), ticker: 'TEST',
    listedInput: { txid: 'b'.repeat(64), vout: 1, atoms: 50000000000n, sats: 1000, scriptHex: '0014' + '11'.repeat(20) },
    buyerFunding: [{ txid: 'c'.repeat(64), vout: 0, sats: 20000, scriptHex: '0014' + '22'.repeat(20) }],
    buyerScriptHex: '0014' + '22'.repeat(20),
    sellerScriptHex: '0014' + '11'.repeat(20), priceSats: 12347n,
  });
  assert.equal(purchase.transactions.length, 1);
  assert.equal(purchase.sellerPayoutSats, 12347n);
  assert.equal(purchase.buyerAtoms, 50000000000n);
  assert.equal(purchase.markerJson, '{"p":"crc-20","op":"transfer","tick":"TEST","amt":"50000000000"}');
  assert.equal(purchase.recipientVout, purchase.markerVout + 1);
});
