import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import * as core from "./index.js";
const saved = core.decodeProtocolDto<{
  config: core.Config;
  deploy: { plan: core.Plan; rawHex: string; txid: string };
  mint: { plan: core.Plan; rawHex: string };
  burn: { rawHex: string };
}>(
  JSON.parse(
    readFileSync(
      new URL(
        "../../../artifacts/crc-core-integration/indexer/mined-indexer.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);
test("core emits accepted deployment and mint facts alongside identical confirmed state", () => {
  const initial = core.emptyLedger(saved.config);
  const deploy = {
    hash: "11".repeat(32),
    parentHash: "00".repeat(32),
    height: 1,
    transactions: [{ rawHex: saved.deploy.rawHex, prevouts: saved.deploy.plan.inputs }],
  };
  const options = { registeredDeployments: { [saved.deploy.txid]: saved.config } };
  const accepted = core.applyConfirmedBlockDetailed(initial, deploy, options);
  expect(accepted.ledger).toEqual(core.applyConfirmedBlock(initial, deploy, options));
  expect(accepted.events).toEqual([
    {
      txid: saved.deploy.txid,
      deployTxid: saved.deploy.txid,
      txIndex: 0,
      kind: "deploy",
      valid: true,
      amountAtoms: undefined,
      grossSats: undefined,
    },
  ]);
  expect(core.applyConfirmedBlockDetailed(accepted.ledger, deploy, options).events).toEqual([]);
  const mint = {
    ...deploy,
    hash: "22".repeat(32),
    parentHash: deploy.hash,
    height: 2,
    transactions: [{ rawHex: saved.mint.rawHex, prevouts: saved.mint.plan.inputs }],
  };
  const minted = core.applyConfirmedBlockDetailed(accepted.ledger, mint);
  expect(minted.ledger).toEqual(core.applyConfirmedBlock(accepted.ledger, mint));
  expect(minted.events[0]).toMatchObject({
    kind: "mint",
    valid: true,
    amountAtoms: 10000000000n,
    grossSats: 3n,
  });
  expect(core.applyConfirmedBlockDetailed(initial, deploy).events).toEqual([]);
  const burnTx = core.parseRawTransaction(saved.burn.rawHex);
  const burned = core.applyConfirmedBlockDetailed(minted.ledger, {
    hash: "33".repeat(32),
    parentHash: mint.hash,
    height: 3,
    transactions: [
      {
        rawHex: saved.burn.rawHex,
        prevouts: burnTx.inputs.map((input) => ({
          txid: input.txid,
          vout: input.vout,
          ...minted.ledger.allocations[core.outpoint(input)]!,
        })),
      },
    ],
  });
  expect(burned.events[0]).toMatchObject({
    kind: "burn",
    valid: false,
    amountAtoms: 10000000000n,
    grossSats: undefined,
  });
});
