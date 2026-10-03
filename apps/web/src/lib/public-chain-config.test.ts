import { expect, test } from "vitest";
import { publicChainUrl } from "../../public-chain-config.mjs";

test("accepts explicit public RPC/index URLs without publishing credentials", () => {
  expect(publicChainUrl("https://bitcoin-signet-rpc.publicnode.com")).toBe("https://bitcoin-signet-rpc.publicnode.com");
  expect(publicChainUrl("")).toBeUndefined();
  for (const url of ["https://user:secret@example.com", "https://example.com?key=secret", "https://example.com#secret", "file:///tmp/rpc", "garbage"])
    expect(() => publicChainUrl(url)).toThrow();
});
