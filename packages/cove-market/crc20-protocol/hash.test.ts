import { createHash } from "node:crypto";
import { expect, test } from "vitest";
test("browser hash primitives match independent SHA256/RIPEMD160 vectors", async () => {
  const { sha256, hash160, hex } = await import("./bytes.ts");
  for (const text of ["", "abc", "a".repeat(55), "b".repeat(64), "c".repeat(129), "crc-offer-v1"]) {
    const bytes = new TextEncoder().encode(text);
    expect(hex(sha256(bytes))).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(hex(hash160(bytes))).toBe(
      createHash("ripemd160").update(createHash("sha256").update(bytes).digest()).digest("hex"),
    );
  }
});
