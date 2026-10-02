import * as ecc from "tiny-secp256k1";
import { hex } from "./bytes.js";
import { taggedHash } from "./taproot.js";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { test, expect } from "vitest";
import { aliceKey, aliceScript } from "./test-support/core.js";
import { authorizeOffer } from "./test-support/signing.js";

test("production package import executes WASM and verifies external offers in Chromium", async () => {
  const offer = await authorizeOffer(
    {
      network: "regtest",
      deployTxid: "a".repeat(64),
      ticker: "TEST",
      listedInput: {
        txid: "b".repeat(64),
        vout: 1,
        atoms: 9007199254740993n,
        sats: 1000n,
        scriptHex: aliceScript,
      },
      sellerScriptHex: aliceScript,
      priceSats: 12347n,
      expiryHeight: 100,
    },
    aliceKey.privateKey!,
  );
  const internal = aliceKey.publicKey.slice(1);
  const taprootScript = `5120${hex(ecc.xOnlyPointAddTweak(internal, taggedHash("TapTweak", internal))!.xOnlyPubkey)}`;
  const taprootOffer = await authorizeOffer(
    {
      ...offer,
      listedInput: { ...offer.listedInput, scriptHex: taprootScript },
      sellerScriptHex: taprootScript,
    },
    aliceKey.privateKey!,
  );
  const json = JSON.stringify([offer, taprootOffer], (_, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  // This downstream bundle gets the package's browser condition, without a
  // WASM plugin, Node shims or imports into the authoritative source folder.
  const bundle = await build({
    stdin: {
      contents: `import * as CRC from '@crclaunch/crc20-protocol';
      const offers=${json};
      for(const offer of offers){offer.listedInput.atoms=BigInt(offer.listedInput.atoms);
      offer.listedInput.sats=BigInt(offer.listedInput.sats);offer.priceSats=BigInt(offer.priceSats);
      CRC.verifyOffer(offer);}
      const offer=offers[0];
      let rejected=false;try{CRC.verifyOffer({...offer, priceSats:offer.priceSats+1n})}catch{rejected=true}
      window.result={ atoms:CRC.parseAtoms('9007199254740993').toString(),
        backing:CRC.backingSats(200000000000n).toString(),rejected,
        signing:'authorizeOffer' in CRC || 'signNativeInput' in CRC,
        node: 'process' in globalThis || 'Buffer' in globalThis || 'require' in globalThis };`,
      resolveDir: new URL(".", import.meta.url).pathname,
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    target: "es2022",
    metafile: true,
  });
  expect(Object.keys(bundle.metafile!.inputs)).not.toContainEqual(
    expect.stringMatching(/node:|test-support|index\.ts$/),
  );
  const server = createServer((request, response) => {
    response.setHeader(
      "Content-Type",
      request.url === "/core.js" ? "text/javascript" : "text/html",
    );
    response.end(
      request.url === "/core.js"
        ? bundle.outputFiles[0]!.text
        : '<script type="module" src="/core.js"></script>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no test server address");
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.waitForFunction("window.result !== undefined");
    expect(errors).toEqual([]);
    expect(await page.evaluate("window.result")).toEqual({
      atoms: "9007199254740993",
      backing: "54",
      rejected: true,
      signing: false,
      node: false,
    });
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
