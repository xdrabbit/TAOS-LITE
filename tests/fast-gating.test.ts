// Who can reach /fast, proved against the real route handler.
//
// Same shape and the same reasoning as tests/call-gating.test.ts: "founders
// only" is a claim about three surfaces, and two of them (the grid-menu entry
// and the page gate) run in the BROWSER off a client-held Supabase session,
// so they hide /fast without defending it. Anyone can render FastShell.
//
// So the route is the fence, and this is the fence's test. It calls the
// handler with only auth mocked and asserts two things about a non-founder:
// the status is 404, and global fetch was never touched. The second is the one
// that matters — a 404 returned after paying a provider is the same bill with
// better manners.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

let caller: { id: string; email: string } | null = null;

vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async (req: Request) => {
    const header = req.headers.get("authorization") ?? "";
    return header.startsWith("Bearer ") && caller ? caller : null;
  }
}));

// Stands in for the translation provider. If this is called for a
// non-founder, the gate leaks.
//
// It answers in whichever shape the request asked for: auto mode sets
// response_format json_object and parses what comes back, so a stub that
// always returned a bare word would fail auto for the wrong reason.
const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
  const sent = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  const json = (sent.response_format as { type?: string } | undefined)?.type === "json_object";
  const content = json ? JSON.stringify({ sourceLang: "en", translation: "hola" }) : "hola";
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
});

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_KEY = process.env.OPENAI_API_KEY;
const ORIGINAL_FLAG = process.env.NEXT_PUBLIC_ENABLE_FAST;

beforeEach(async () => {
  caller = null;
  fetchSpy.mockClear();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  process.env.OPENAI_API_KEY = "sk-test";
  delete process.env.NEXT_PUBLIC_ENABLE_FAST;
  // No service-role key: lib/fast/meter.ts runs unmetered off production
  // and says so in the log, which keeps these tests about the gate and
  // the in-process cap. Billing has its own file.
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.AZURE_TRANSLATOR_KEY;
  delete process.env.AZURE_TRANSLATOR_REGION;
  const { resetFastRateLimits } = await import("@/lib/fast/rateLimit");
  resetFastRateLimits();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_KEY;
  if (ORIGINAL_FLAG === undefined) delete process.env.NEXT_PUBLIC_ENABLE_FAST;
  else process.env.NEXT_PUBLIC_ENABLE_FAST = ORIGINAL_FLAG;
  vi.resetModules();
});

function fastRequest(body: Record<string, unknown>, token?: string): NextRequest {
  return new NextRequest("https://taoslite.com/api/fast", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
}

const QUICKIE = { text: "bathroom", sourceLanguage: "en", targetLanguage: "es" };

async function post(body: Record<string, unknown>, token?: string) {
  const { POST } = await import("@/app/api/fast/route");
  return POST(fastRequest(body, token));
}

describe("POST /api/fast — the route that spends money", () => {
  it("404s a signed-out stranger without calling a provider", async () => {
    const res = await post(QUICKIE);
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("404s a signed-in customer without calling a provider", async () => {
    caller = { id: "u1", email: "stranger@example.com" };
    const res = await post(QUICKIE, "token");
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("translates for a founder", async () => {
    caller = { id: "u2", email: "xdrabbit@gmail.com" };
    const res = await post(QUICKIE, "token");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ translation: "hola", engine: "openai" });
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("opens to everyone once the public flag ships it", async () => {
    process.env.NEXT_PUBLIC_ENABLE_FAST = "1";
    caller = { id: "u3", email: "stranger@example.com" };
    const res = await post(QUICKIE, "token");
    expect(res.status).toBe(200);
  });

  it("identifies the caller before it decides anything", async () => {
    // The ordering that makes the 404 free: guardSpend (Supabase, never a
    // paid provider) runs, then the gate, and only then a key is read.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../app/api/fast/route.ts", import.meta.url), "utf8")
    );
    const guard = src.indexOf("await guardSpend(req)");
    const gate = src.indexOf("fastVisibleTo(email)");
    const translate = src.indexOf("await fastTranslate(");
    expect(guard).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(guard);
    expect(translate).toBeGreaterThan(gate);
  });
});

describe("the request the route will accept", () => {
  beforeEach(() => {
    caller = { id: "u2", email: "xdrabbit@gmail.com" };
  });

  it("refuses empty text without calling a provider", async () => {
    const res = await post({ ...QUICKIE, text: "   " }, "token");
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a quickie longer than the cap — Azure bills per character", async () => {
    const { FAST_MAX_CHARS } = await import("@/lib/fast/settle");
    const res = await post({ ...QUICKIE, text: "a".repeat(FAST_MAX_CHARS + 1) }, "token");
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a language translated into itself", async () => {
    const res = await post({ ...QUICKIE, targetLanguage: "en" }, "token");
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports which engine answered, so nobody misreads the register", async () => {
    const res = await post(QUICKIE, "token");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.engine).toBe("openai");
    expect(body.fallback).toBe("azure_not_configured");
  });

  it("echoes the direction back, so auto mode can be rendered", async () => {
    const res = await post({ ...QUICKIE, direction: "auto" }, "token");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.detectedSource).toBeTruthy();
    expect(body.targetLanguage).toBeTruthy();
  });
});
