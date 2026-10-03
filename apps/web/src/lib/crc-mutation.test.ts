import { expect, test } from "vitest";
import { assertCrcMutationEnabled } from "./crc-mutation";

test("CRC mutations require explicit trading activation", () => {
  expect(() => assertCrcMutationEnabled(false)).toThrow();
  expect(assertCrcMutationEnabled(true)).toBeUndefined();
});
