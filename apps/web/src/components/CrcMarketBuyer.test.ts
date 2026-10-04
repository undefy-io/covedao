import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { expect, test } from "vitest";

test("market marks each connected wallet's own rows and reserves review actions for other sellers", async () => {
  const bundle = await build({
    stdin: {
      resolveDir: new URL(".", import.meta.url).pathname,
      contents: `
import React from 'react';import {createRoot} from 'react-dom/client';import {CrcMarketBuyer} from './CrcMarketBuyer';
window.wallet={connected:true,network:'regtest',script:'alice-pay',ordinalsScript:'alice-token'};
window.buyCalls=[];window.connectCalls=0;
const root=createRoot(document.getElementById('root'));window.render=()=>root.render(React.createElement(CrcMarketBuyer));window.render();
`,
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    target: "es2022",
    jsx: "automatic",
    tsconfig: new URL("../../tsconfig.json", import.meta.url).pathname,
    inject: [
      new URL("../../../../packages/crc20-adapters/browser-buffer.mjs", import.meta.url).pathname,
    ],
    plugins: [
      {
        name: "market-fixtures",
        setup(builder) {
          builder.onResolve({ filter: /WalletProvider$/ }, () => ({
            path: "wallet",
            namespace: "fixture",
          }));
          builder.onResolve({ filter: /CrcHome$/ }, () => ({ path: "home", namespace: "fixture" }));
          builder.onResolve({ filter: /crc-indexed-refresh$/ }, () => ({
            path: "refresh",
            namespace: "fixture",
          }));
          builder.onResolve({ filter: /crc-market-client$/ }, () => ({
            path: "client",
            namespace: "fixture",
          }));
          builder.onResolve({ filter: /^next\/link$/ }, () => ({
            path: "link",
            namespace: "fixture",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
            contents: (
              {
                wallet: `export const useWallet=()=>({...window.wallet,connect:async()=>window.connectCalls++,signPsbt:async()=>{throw Error('Unexpected signing');}});`,
                home: `export const formatAtoms=a=>String(BigInt(a)/100000000n);export const formatVaultSats=a=>a+' sats';`,
                refresh: `export const crcIndexedRefresh={subscribe(read){void read(new AbortController().signal);return()=>{};}};`,
                link: `import React from 'react';export default ({children,...props})=>React.createElement('a',props,children);`,
                client: `export {isCrcMarketListingOwner} from ${JSON.stringify(new URL("../lib/crc-market-client.ts", import.meta.url).pathname)};
export const buyCrcMarketListing=async(row)=>{window.buyCalls.push(row.id);return {txid:'submitted'};};`,
              } as Record<string, string>
            )[path]!,
            loader: "js",
            resolveDir: new URL(".", import.meta.url).pathname,
          }));
        },
      },
    ],
  });
  const server = createServer((req, res) => {
    res.setHeader("content-type", req.url === "/bundle.js" ? "text/javascript" : "text/html");
    res.end(
      req.url === "/bundle.js"
        ? bundle.outputFiles[0]!.text
        : '<div id="root"></div><div id="your-market-listings">Seller controls</div><script type="module" src="/bundle.js"></script>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch();
  const row = (owner: string) => ({
    id: owner,
    network: "regtest",
    deployTxid: "aa".repeat(32),
    ticker: owner.toUpperCase(),
    status: "OPEN",
    sellerScriptHex: owner + "-pay",
    sellerAnchorTxid: "bb".repeat(32),
    sellerAnchorVout: 1,
    amountAtoms: "29000000000",
    priceSats: 10,
    protocolFeeSats: 1000,
    coreOffer: {
      escrowTerms: {
        sellerTokenScriptHex: owner + "-token",
        sellerAuthorityScriptHex: owner + "-pay",
      },
    },
  });
  try {
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      const page = await browser.newPage({ viewport });
      await page.route("**/api/**", (route) =>
        route.fulfill({
          json: {
            ok: true,
            data: route.request().url().includes("listings")
              ? { active: true, listings: [row("alice"), row("bob")] }
              : route.request().url().includes("/tokens?")
                ? { tokens: [] }
                : { active: true },
          },
        }),
      );
      await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
      const alice = page.getByRole("row").filter({ hasText: "$ALICE" }),
        bob = page.getByRole("row").filter({ hasText: "$BOB" });
      await alice.getByText("Your listing", { exact: true }).waitFor();
      expect(await alice.getByRole("link", { name: "Manage" }).getAttribute("href")).toBe(
        "#your-market-listings",
      );
      expect(await alice.getByRole("button", { name: "Review buy" }).count()).toBe(0);
      await bob.getByRole("button", { name: "Review buy" }).click();
      await page.getByText("Sale submitted: submitted").waitFor();
      expect(await page.evaluate("window.buyCalls")).toEqual(["bob"]);
      await page.reload();
      await alice.getByText("Your listing", { exact: true }).waitFor();
      await page.evaluate(
        `window.wallet={...window.wallet,script:'bob-pay',ordinalsScript:'bob-token'};window.render()`,
      );
      await bob.getByText("Your listing", { exact: true }).waitFor();
      expect(await alice.getByText("Your listing", { exact: true }).count()).toBe(0);
      expect(await alice.getByRole("button", { name: "Review buy" }).count()).toBe(1);
      await page.evaluate(`window.wallet={...window.wallet,connected:false};window.render()`);
      expect(await page.getByText("Your listing", { exact: true }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Review buy" }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Connect", exact: true }).count()).toBe(2);
      await page.close();
    }
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 30000);
