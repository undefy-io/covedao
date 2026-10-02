/* global URL */
import { build } from "esbuild";
await build({
  entryPoints: [new URL("./src/index.ts", import.meta.url).pathname],
  outfile: new URL("./dist/browser.js", import.meta.url).pathname,
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  minify: true,
  inject: [new URL("./browser-buffer.mjs", import.meta.url).pathname],
});
