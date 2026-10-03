import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  services: vi.fn(() => ({ config: { network: "regtest" }, provider: {}, db: {execute: vi.fn().mockResolvedValue({rows:[]})} })),
  scan: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/crc-mutation", () => ({ getCrcMutationServices: mocks.services }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/regtest-scan", () => ({ regtestScans: { scan: mocks.scan } }));
vi.mock("@/lib/api", () => ({
  ok: (data: unknown) => Response.json({ ok: true, data }),
  fail: (code: string, message: string, status: number) => Response.json({ ok: false, error: { code, message } }, { status }),
  handleError: () => new Response(null, { status: 500 }),
  readJson: (req: Request) => req.json(),
  strField: (body: Record<string, string>, key: string) => body[key],
}));
import { GET, POST } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("dev wallet scan gating", () => {
  it("returns 403 for GET and POST in production without scanning or initializing services", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("COVE_DEV_WALLET", "true");
    expect((await GET(new Request("http://localhost/api/dev/wallet"))).status).toBe(403);
    expect((await POST(new Request("http://localhost/api/dev/wallet", { method: "POST" }))).status).toBe(403);
    expect(mocks.scan).not.toHaveBeenCalled();
    expect(mocks.services).not.toHaveBeenCalled();
  });

  it("uses the shared scan scheduler and request signal for fixture balances and UTXOs", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("COVE_DEV_WALLET", "true");
    const get = new Request("http://localhost/api/dev/wallet");
    expect((await GET(get)).status).toBe(200);
    expect(mocks.scan.mock.calls[0]?.[1]).toHaveLength(3);
    expect(mocks.scan.mock.calls[0]?.[2]).toBe(get.signal);
    const post = new Request("http://localhost/api/dev/wallet", {
      method: "POST", body: JSON.stringify({ identity: "alice", action: "getUtxos" }),
    });
    expect((await POST(post)).status).toBe(200);
    expect(mocks.scan.mock.calls[1]?.[1]).toHaveLength(1);
    expect(mocks.scan.mock.calls[1]?.[2]).toBe(post.signal);
  });
});

it("publishes only public fixture key metadata needed by core browser adapters", async () => {
  vi.stubEnv("NODE_ENV", "development"); vi.stubEnv("COVE_DEV_WALLET", "true");
  const result = await (await GET(new Request("http://localhost/api/dev/wallet?identity=alice"))).json();
  expect(result.data.publicKey).toMatch(/^0[23][0-9a-f]{64}$/);
  expect(result.data.privHex).toBeUndefined();
  const list = await (await GET(new Request("http://localhost/api/dev/wallet"))).json();
  expect(list.data.identities.every((id: { publicKey?: string; privHex?: string }) => /^0[23][0-9a-f]{64}$/.test(id.publicKey ?? "") && id.privHex === undefined)).toBe(true);
});
