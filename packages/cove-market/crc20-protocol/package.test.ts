import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import * as publicApi from "./index.js";

test("public consumer API excludes private-key signing helpers", () => {
  expect(publicApi).not.toHaveProperty("authorizeOffer");
  expect(publicApi).not.toHaveProperty("signNativeInput");
});

test("nested workspace package exposes only built core with one runtime dependency", () => {
  const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  expect(manifest.name).toBe("@crclaunch/crc20-protocol");
  expect(manifest.dependencies).toEqual({ "tiny-secp256k1": "^2.2.3" });
  expect(manifest.exports).toEqual({
    ".": {
      types: "./dist/index.d.ts",
      browser: "./dist/browser.js",
      import: "./dist/index.js",
    },
  });
  expect(readFileSync(new URL("../../../pnpm-workspace.yaml", import.meta.url), "utf8")).toContain(
    '"packages/cove-market/crc20-protocol"',
  );
});

test("public source graph is acyclic and excludes infrastructure and test signing", () => {
  const visited = new Set<string>();
  function walk(file: string, ancestors: string[]) {
    expect(ancestors, `cycle at ${file}`).not.toContain(file);
    if (visited.has(file)) return;
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    expect(source).not.toMatch(
      /privateKey|test-support|node:|@crclaunch\/|\bimport\s*\(|\brequire\s*\(/,
    );
    for (const match of source.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)) {
      const target = match[1]!;
      if (target === "tiny-secp256k1") continue;
      expect(target).toMatch(/^\.\/[^/]+\.js$/);
      // Type-only references do not create runtime cycles (wire <-> taproot).
      const line = source.slice(source.lastIndexOf("\n", match.index) + 1, match.index);
      if (!line.startsWith("import type"))
        walk(target.replace(/\.js$/, ".ts"), [...ancestors, file]);
    }
    visited.add(file);
  }
  walk("./index.ts", []);
});

test("built Node package has the same public behavior and refuses private subpath imports", async () => {
  const built = await import("@crclaunch/crc20-protocol");
  expect(Object.keys(built).sort()).toEqual(Object.keys(publicApi).sort());
  expect(built.parseAtoms("9007199254740993")).toBe(9007199254740993n);
  expect(built.markerScript('{"p":"crc-20","op":"mint","tick":"TEST"}')).toBe(
    publicApi.markerScript('{"p":"crc-20","op":"mint","tick":"TEST"}'),
  );
  const privateSubpath = "@crclaunch/crc20-protocol/test-support/signing";
  await expect(import(privateSubpath)).rejects.toThrow();
});

test("parent package test collection excludes the independent nested package", () => {
  const config = readFileSync(new URL("../vitest.config.ts", import.meta.url), "utf8");
  expect(config).toContain('include: ["src/**/*.test.ts"]');
});
