// [taos-fast-timing]: one body-less line per POST /api/fast, success or
// error, so the quickie engine's latency is visible (10/27: OPENAI_FAST_MODEL
// moved to gpt-4.1-mini). Never the typed text, never the translation.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { NextRequest } from "next/server";

const TYPED = "my private typed sentence";
const TRANSLATED = "mi frase privada escrita";

vi.mock("@/lib/spendGuard", () => ({
  guardSpend: async () => ({ ok: true, user: { id: "u1", email: "f@example.com" }, anonymous: false })
}));
vi.mock("@/lib/release", () => ({ fastVisibleTo: () => true }));
vi.mock("@/lib/fast/rateLimit", () => ({ checkFastRate: () => ({ allowed: true }) }));
vi.mock("@/lib/fast/meter", () => ({
  FastMeterUnavailableError: class extends Error {},
  beginFastQuickie: async () => ({ ok: true, billed: true, repeat: false, rowId: "r1" }),
  recordFastQuickie: async () => {},
  abandonFastQuickie: async () => {},
  fastRefusal: () => ({ status: 402, message: "spent" })
}));

const fastTranslate = vi.fn();
class FastEngineError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}
vi.mock("@/lib/fast/engine", () => ({
  FastEngineError,
  fastTranslate: (...a: unknown[]) => fastTranslate(...a),
  getFastModel: () => "gpt-4.1-mini"
}));

let logSpy: MockInstance<typeof console.log>;

function post() {
  return new NextRequest("https://taoslite.com/api/fast", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
    body: JSON.stringify({ text: TYPED, sourceLanguage: "en", targetLanguage: "es" })
  });
}

function lines(): string[] {
  return logSpy.mock.calls
    .map((c) => c.map(String).join(" "))
    .filter((l) => l.startsWith("[taos-fast-timing]"));
}

beforeEach(() => {
  vi.resetModules();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  fastTranslate.mockReset().mockResolvedValue({
    translation: TRANSLATED,
    detectedSource: "en",
    targetLanguage: "es",
    engine: "openai",
    fallback: "azure_not_configured"
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("[taos-fast-timing]", () => {
  it("logs one ok line with the model and timings, cold then warm", async () => {
    const { POST } = await import("@/app/api/fast/route");
    expect((await POST(post())).status).toBe(200);
    expect((await POST(post())).status).toBe(200);
    const out = lines();
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(
      /^\[taos-fast-timing\] status=ok http=200 engine=openai model=gpt-4\.1-mini guard_ms=\d+ meter_ms=\d+ translate_ms=\d+ total_ms=\d+ cold=1 err=\?$/
    );
    expect(out[1]).toContain(" cold=0 ");
  });

  it("logs an error line with the engine's status code", async () => {
    fastTranslate.mockRejectedValue(new FastEngineError("boom", 504));
    const { POST } = await import("@/app/api/fast/route");
    expect((await POST(post())).status).toBe(504);
    const [line] = lines();
    expect(line).toContain("status=error http=504");
    expect(line).toMatch(/ translate_ms=\d+ /);
    expect(line).toMatch(/ err=translate_504$/);
  });

  it("never writes the typed text or the translation to the console", async () => {
    const { POST } = await import("@/app/api/fast/route");
    await POST(post());
    const all = logSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(lines()).toHaveLength(1);
    expect(all).not.toContain(TYPED);
    expect(all).not.toContain(TRANSLATED);
  });
});
