import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { expect, test } from "vitest";
test("real Chromium loads adapters and completes actual captured native, nested and Taproot signatures", async () => {
  const root = new URL(
    "../../../artifacts/crc-core-integration/wallet-capabilities/",
    import.meta.url,
  );
  const read = (name: string) => JSON.parse(readFileSync(new URL(name, root), "utf8"));
  const connection = read("xverse-real-connect.json").connect.value.result;
  const fixtures = ["payment", "ordinals", "nested"].map((purpose) => ({
    purpose,
    saved: read(`xverse-buyer-${purpose}-plan.json`),
    response: read(`xverse-buyer-${purpose}-response.json`),
    account: (purpose === "nested"
      ? read("xverse-nested-connect.json").value.result
      : connection
    ).addresses.find(
      (a: { purpose: string }) => a.purpose === (purpose === "nested" ? "payment" : purpose),
    ),
  }));
  const bundle = await build({
    stdin: {
      contents: `import * as A from '@crclaunch/crc20-adapters';import * as C from '@crclaunch/crc20-protocol';
 const fixtures=${JSON.stringify(fixtures)};
 window.result=fixtures.map(f=>{const plan=C.decodeProtocolDto(f.saved.plan);const prepared=A.preparePlanSigning(plan,{network:'signet',walletInputs:[{index:1,...f.account}]});const final=A.completePlanSigning(prepared,f.response.value.result.psbt);return {purpose:f.purpose,exact:final.rawHex===f.response.rawTransaction};});`,
      resolveDir: new URL("..", import.meta.url).pathname,
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    target: "es2022",
  });
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", req.url === "/app.js" ? "text/javascript" : "text/html");
    res.end(
      req.url === "/app.js"
        ? bundle.outputFiles[0]!.text
        : '<script type="module" src="/app.js"></script>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server unavailable");
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page
      .waitForFunction("window.result !== undefined", undefined, { timeout: 5000 })
      .catch((error) => {
        throw new Error(errors.join("; ") || String(error));
      });
    expect(errors).toEqual([]);
    expect(await page.evaluate("window.result")).toEqual(
      fixtures.map((f) => ({ purpose: f.purpose, exact: true })),
    );
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}, 30000);
