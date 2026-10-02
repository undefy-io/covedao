import { expect, test, vi } from "vitest";
import { Core, aliceScript, bobScript } from "./test-support/core.js";

test("fixed-key Core fixture funding ignores generated wallet change", () => {
  const node = new Core();
  vi.spyOn(node, "rpc").mockReturnValue([
    { txid: "11".repeat(32), vout: 0, amount: 40, scriptPubKey: bobScript },
    { txid: "22".repeat(32), vout: 1, amount: 50, scriptPubKey: aliceScript },
  ]);
  expect(node.funding("alice")).toMatchObject({
    txid: "22".repeat(32),
    vout: 1,
    scriptHex: aliceScript,
  });
});
