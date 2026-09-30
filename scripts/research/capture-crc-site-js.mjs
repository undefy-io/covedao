#!/usr/bin/env node
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const requireWeb = createRequire(path.join(root, "apps/web/package.json"));
const { chromium } = requireWeb("@playwright/test");
const output = path.join(root, "artifacts/crc-garden/site-js-2026-09-30");
const routes = ["/", "/activity", "/market", "/wallet"];
const files = new Map();
const pages = [];

await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
  ...(process.env.CRC_SITE_CHROMIUM ? { executablePath: process.env.CRC_SITE_CHROMIUM } : {}),
});
try {
  const page = await browser.newPage();
  for (const route of routes) {
    const scriptUrls = new Set();
    const fetched = [];
    const onResponse = (response) => {
      const url = response.url();
      if (!url.startsWith("https://crc.garden/_next/static/") || !url.endsWith(".js")) return;
      scriptUrls.add(url);
      fetched.push(
        response.body().then(async (body) => {
          const hash = createHash("sha256").update(body).digest("hex");
          const filename = `${hash.slice(0, 16)}-${path.basename(new URL(url).pathname)}`;
          if (!files.has(url)) {
            await writeFile(path.join(output, filename), body);
            files.set(url, { url, filename, sha256: hash, bytes: body.length });
          }
        }),
      );
    };
    page.on("response", onResponse);
    const response = await page.goto(`https://crc.garden${route}`, {
      waitUntil: "load",
      timeout: 30000,
    });
    await page.waitForTimeout(1200);
    const domScripts = await page.evaluate(() =>
      Array.from(document.scripts, (script) => script.src).filter((url) => url.endsWith(".js")),
    );
    for (const url of domScripts) scriptUrls.add(url);
    await Promise.all(fetched);
    page.off("response", onResponse);
    pages.push({ route, status: response?.status() ?? null, scripts: [...scriptUrls].sort() });
  }
  const manifest = {
    capturedAt: new Date().toISOString(),
    pages,
    bundles: [...files.values()].sort((a, b) => a.url.localeCompare(b.url)),
  };
  await writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(
    JSON.stringify({
      pages: pages.length,
      bundles: files.size,
      bytes: [...files.values()].reduce((sum, file) => sum + file.bytes, 0),
      output,
    }),
  );
} finally {
  await browser.close();
}
