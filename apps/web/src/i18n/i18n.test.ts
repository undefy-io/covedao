import { describe, expect, it } from "vitest";
import { en } from "./en";
import { zhCN } from "./zh-CN";
import { parseLang, translate, translateError, setCurrentLang } from "./index";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("dictionaries", () => {
  it("have the same keys", () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
  });

  it("use the same placeholders in every string", () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(placeholders(zhCN[key]), key).toEqual(placeholders(en[key]));
    }
  });

  it("have no empty Chinese strings", () => {
    for (const [key, value] of Object.entries(zhCN)) expect(value.trim(), key).not.toBe("");
  });
});

describe("translate", () => {
  it("fills placeholders", () => {
    expect(translate("en", "tok.smallestMint", { n: "1,000" })).toBe("nothing — the smallest mint is 1,000 sats");
    expect(translate("zh", "tok.smallestMint", { n: "1,000" })).toBe("铸造不了——最少要 1,000 sats");
  });

  it("parses the language from a query or cookie", () => {
    expect(parseLang("zh")).toBe("zh");
    expect(parseLang("zh-CN")).toBe("zh");
    expect(parseLang("en")).toBe("en");
    expect(parseLang(undefined)).toBe("en");
    expect(parseLang("fr")).toBe("en");
  });

  it("maps a known server error code, and falls back to the server text", () => {
    setCurrentLang("zh");
    expect(translateError("INSUFFICIENT_BTC", "server words")).not.toBe("server words");
    expect(translateError("NO_SUCH_CODE", "server words")).toBe("server words");
    setCurrentLang("en");
    expect(translateError("INSUFFICIENT_BTC", "server words")).toBe("server words");
  });
});
