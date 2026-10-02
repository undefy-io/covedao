import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { test, expect } from "vitest";
import { aliceScript } from "./test-support/core.ts";

// Exercise the installed dependencies' browser branches, without Node globals.
// tiny-secp256k1 distributes an ESM-imported WASM module; the test-only loader
// implements that import using browser WebAssembly APIs rather than fs.
test("public API bundles and executes with browser globals and no Node polyfills", async () => {
  const require = createRequire(import.meta.url);
  const fromVitest = createRequire(require.resolve("vitest"));
  const fromVite = createRequire(fromVitest.resolve("vite"));
  const { build } = fromVite("esbuild");
  const bundle = await build({
    entryPoints: [new URL("./index.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    globalName: "CRC",
    target: "es2022",
    plugins: [
      {
        name: "native-browser-wasm",
        setup(build: any) {
          build.onLoad({ filter: /\.wasm$/ }, ({ path }: { path: string }) => {
            const bytes = readFileSync(path),
              module = new WebAssembly.Module(bytes);
            const names = WebAssembly.Module.exports(module).map((e) => e.name);
            return {
              resolveDir: dirname(path),
              loader: "js",
              contents: `import * as rand from './rand.js';import * as validate from './validate_error.js';const instance=new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array([${Array.from(bytes)}])),{'./rand.js':rand,'./validate_error.js':validate});${names.map((n) => `export const ${n}=instance.exports.${n};`).join("")}`,
            };
          });
        },
      },
    ],
  });
  const context: any = {
    TextEncoder,
    TextDecoder,
    WebAssembly,
    Uint8Array,
    Uint32Array,
    DataView,
    crypto: webcrypto,
    structuredClone,
  };
  runInNewContext(bundle.outputFiles[0].text, context, { timeout: 5000 });
  expect(context.process).toBeUndefined();
  expect(context.Buffer).toBeUndefined();
  expect(context.require).toBeUndefined();
  expect(context.CRC.parseAtoms("9007199254740993")).toBe(9007199254740993n);
  expect(context.CRC.backingSats(200000000000n)).toBe(54n);
  const key = Uint8Array.from({ length: 32 }, () => 0x61);
  const terms = {
    network: "regtest",
    deployTxid: "a".repeat(64),
    ticker: "TEST",
    listedInput: { txid: "b".repeat(64), vout: 1, atoms: 1n, sats: 1000n, scriptHex: aliceScript },
    sellerScriptHex: aliceScript,
    priceSats: 12347n,
    expiryHeight: 100,
  };
  const offer = await context.CRC.authorizeOffer(terms, key);
  expect(offer.sellerWitnessHex).toHaveLength(2);
  context.CRC.verifyOffer(offer);
});
