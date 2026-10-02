/* global URL, WebAssembly */
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { build } from "esbuild";

// Resolve tiny-secp256k1's browser WASM import at build time. The emitted
// consumer module needs only WebAssembly and browser crypto, with no polyfills.
await build({
  entryPoints: [new URL("./index.ts", import.meta.url).pathname],
  outfile: new URL("./dist/browser.js", import.meta.url).pathname,
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  minify: true,
  plugins: [
    {
      name: "browser-wasm",
      setup(builder) {
        builder.onLoad({ filter: /\.wasm$/ }, ({ path }) => {
          const bytes = readFileSync(path);
          const module = new WebAssembly.Module(bytes);
          const names = WebAssembly.Module.exports(module).map((entry) => entry.name);
          return {
            resolveDir: dirname(path),
            loader: "js",
            contents: `import * as rand from './rand.js';import * as validate from './validate_error.js';const instance=new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(atob('${bytes.toString("base64")}'),c=>c.charCodeAt(0))),{'./rand.js':rand,'./validate_error.js':validate});${names.map((name) => `export const ${name}=instance.exports.${name};`).join("")}`,
          };
        });
      },
    },
  ],
});
