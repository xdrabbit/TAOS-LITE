// Who can reach /call, proved against the real route handlers.
//
// /call is founders-only, and "founders-only" is a claim about three
// surfaces: a nav link, a page, and two routes. The first two run in the
// BROWSER — the Supabase session lives client-side (lib/supabase.ts), so a
// server component has nothing to read — which means they hide /call without
// defending it. Anyone can render CallShell.
//
// So the routes are the fence, and this file is the fence's test. It calls
// the handlers with only auth mocked, exactly as tests/spend-guard.test.ts
// does, and asserts two things about a non-founder: the status is 404, and
// global fetch was never touched. The second is the one that matters. A 404
// returned after minting a realtime session is the same bill with better
// manners, and a minted session keeps billing after the response has gone.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

let caller: { id: string; email: string } | null = null;

vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async (req: Request) => {
    const header = req.headers.get("authorization") ?? "";
    return header.startsWith("Bearer ") && caller ? caller : null;
  }
}));

// Stands in for OpenAI. If this is called for a non-founder, the gate leaks.
const fetchSpy = vi.fn(
  async () =>
    new Response(JSON.stringify({ value: "ek_test_secret" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })
);

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_KEY = process.env.OPENAI_API_KEY;
const ORIGINAL_FLAG = process.env.NEXT_PUBLIC_ENABLE_CALL;

beforeEach(() => {
  caller = null;
  fetchSpy.mockClear();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  process.env.OPENAI_API_KEY = "sk-test";
  delete process.env.NEXT_PUBLIC_ENABLE_CALL;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_KEY;
  if (ORIGINAL_FLAG === undefined) delete process.env.NEXT_PUBLIC_ENABLE_CALL;
  else process.env.NEXT_PUBLIC_ENABLE_CALL = ORIGINAL_FLAG;
  vi.resetModules();
});

function mintRequest(body: Record<string, unknown>, token?: string): NextRequest {
  return new NextRequest("https://taoslite.com/api/call/realtime", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
}

function usageRequest(body: Record<string, unknown>, token?: string): NextRequest {
  return new NextRequest("https://taoslite.com/api/call/usage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
}

async function mintRoute() {
  return (await import("@/app/api/call/realtime/route")).POST;
}
async function usageRoute() {
  return (await import("@/app/api/call/usage/route")).POST;
}

describe("POST /api/call/realtime — the route that spends money", () => {
  it("404s a signed-out stranger without calling OpenAI", async () => {
    const POST = await mintRoute();
    const res = await POST(mintRequest({ source: "es", target: "en" }));
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("404s a signed-in customer without calling OpenAI", async () => {
    caller = { id: "u1", email: "customer@example.com" };
    const POST = await mintRoute();
    const res = await POST(mintRequest({ source: "es", target: "en" }, "tok"));
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
    // Not a hint that there is something here to come back for.
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("mints for a founder", async () => {
    caller = { id: "u2", email: "xdrabbit@gmail.com" };
    const POST = await mintRoute();
    const res = await POST(mintRequest({ source: "es", target: "en" }, "tok"));
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as { clientSecret: string; direction: unknown };
    expect(body.clientSecret).toBe("ek_test_secret");
    expect(body.direction).toEqual({ source: "es", target: "en" });
  });

  it("opens to everyone once the public flag ships it", async () => {
    process.env.NEXT_PUBLIC_ENABLE_CALL = "1";
    caller = { id: "u3", email: "customer@example.com" };
    vi.resetModules();
    const POST = await mintRoute();
    const res = await POST(mintRequest({ source: "es", target: "en" }, "tok"));
    expect(res.status).toBe(200);
  });
});

describe("the minted session carries the cost guards", () => {
  async function mintedSession(body: Record<string, unknown>) {
    caller = { id: "u2", email: "xdrabbit@gmail.com" };
    const POST = await mintRoute();
    await POST(mintRequest(body, "tok"));
    const init = (fetchSpy.mock.calls[0] as unknown[] | undefined)?.[1] as
      | RequestInit
      | undefined;
    const sent = JSON.parse(String(init?.body ?? "{}")) as {
      expires_after?: { seconds?: number };
      session?: Record<string, unknown>;
    };
    return sent;
  }

  it("caps the context the model re-reads on every response", async () => {
    // The single largest saving, and the one that is invisible on a short
    // call: uncapped, each response re-reads the whole conversation as audio
    // at $32/Mtok, and the per-response bill climbs for as long as the call
    // lasts. Measured 2026-08-27 over five turns — 209% of the audio actually
    // spoken and still rising, against 66% and flat with this cap on.
    const sent = await mintedSession({ source: "es", target: "en" });
    expect(sent.session?.truncation).toEqual({
      type: "retention_ratio",
      retention_ratio: 0.8,
      token_limits: { post_instructions: 100 }
    });
  });

  it("gives the client secret a short life", async () => {
    const sent = await mintedSession({ source: "es", target: "en" });
    expect(sent.expires_after).toEqual({ anchor: "created_at", seconds: 120 });
  });

  it("asks for TEXT by default, so the app's own voices do the speaking", async () => {
    // Model-spoken audio is $64/Mtok and the biggest line item on a call.
    // Clone mode asks for text and sends it to /api/tts instead, which is
    // both cheaper and Liz's actual voice (lib/tts/voice.ts).
    const sent = await mintedSession({ source: "es", target: "en" });
    expect(sent.session?.output_modalities).toEqual(["text"]);
    expect((sent.session?.audio as Record<string, unknown>)?.output).toBeUndefined();
  });

  it("asks for AUDIO only when the caller chose the fastest voice", async () => {
    const sent = await mintedSession({ source: "es", target: "en", mode: "instant" });
    expect(sent.session?.output_modalities).toEqual(["audio"]);
    expect((sent.session?.audio as Record<string, unknown>)?.output).toBeTruthy();
  });

  it("filters the input before VAD sees it, so a passing bus is not a turn", async () => {
    // A segment VAD never commits is a segment never billed and never
    // transcribed — noise reduction is a cost guard as much as a quality one.
    const sent = await mintedSession({ source: "es", target: "en" });
    const audioIn = (sent.session?.audio as { input?: Record<string, unknown> })?.input;
    expect(audioIn?.noise_reduction).toEqual({ type: "near_field" });
  });
});

describe("the interpreting direction comes from the catalog, not from en/es", () => {
  async function instructionsFor(body: Record<string, unknown>): Promise<string> {
    caller = { id: "u2", email: "xdrabbit@gmail.com" };
    const POST = await mintRoute();
    await POST(mintRequest(body, "tok"));
    const init = (fetchSpy.mock.calls[0] as unknown[] | undefined)?.[1] as
      | RequestInit
      | undefined;
    const sent = JSON.parse(String(init?.body ?? "{}")) as {
      session?: { instructions?: string };
    };
    return sent.session?.instructions ?? "";
  }

  it("builds an Italian prompt for a trip on [en, it]", async () => {
    // THE bug that blacked /call out: a hardcoded "en" | "es" target meant a
    // pair of [en, it] got interpreted into Spanish, confidently, with no
    // error anywhere. A named language in the prompt is the whole fix.
    const instructions = await instructionsFor({ source: "it", target: "en" });
    expect(instructions).toContain("Italian");
    expect(instructions).toContain("OUTPUT LANGUAGE: English");
    expect(instructions).not.toContain("Spanish");
  });

  it("handles a pair with neither launch language in it", async () => {
    const instructions = await instructionsFor({ source: "ja", target: "pt" });
    expect(instructions).toContain("OUTPUT LANGUAGE: Portuguese");
    expect(instructions).toContain("Japanese");
  });

  it("never lets an unknown code reach the prompt", async () => {
    // An interpreter told to output "xx" writes whatever it likes.
    const instructions = await instructionsFor({ source: "xx", target: "zz" });
    expect(instructions).not.toContain("xx");
    expect(instructions).not.toContain("zz");
    expect(instructions).toContain("OUTPUT LANGUAGE: English");
  });

  it("refuses to interpret a language into itself", async () => {
    // The doubled-side rule (lib/translate/pair.ts). The client skips the
    // session entirely in this case; this is the backstop, and it must not
    // produce "translate English into English".
    const instructions = await instructionsFor({ source: "en", target: "en" });
    expect(instructions).toContain("OUTPUT LANGUAGE: English");
    expect(instructions).toContain("Spanish");
  });
});

describe("POST /api/call/usage — the log line, and who may write it", () => {
  it("404s a non-founder", async () => {
    caller = { id: "u1", email: "customer@example.com" };
    const POST = await usageRoute();
    const res = await POST(usageRequest({ room: "AB123", seconds: 60 }, "tok"));
    expect(res.status).toBe(404);
  });

  it("writes one greppable line for a founder", async () => {
    caller = { id: "u2", email: "xdrabbit@gmail.com" };
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const POST = await usageRoute();
    const res = await POST(
      usageRequest(
        {
          room: "AB123",
          mode: "clone",
          direction: "es->en",
          seconds: 600,
          spend: {
            responses: 48,
            audioInTokens: 1584,
            textInTokens: 15840,
            textOutTokens: 960,
            transcribedSeconds: 240,
            ttsCharacters: 3400,
            ttsEngine: "elevenlabs"
          }
        },
        "tok"
      )
    );
    expect(res.status).toBe(204);
    const line = info.mock.calls[0]?.[0] as string;
    expect(line).toContain("[taos-call-cost]");
    expect(line).toContain("room=AB123");
    expect(line).toContain("usd=");
    expect(line).toContain("usd_per_min=");
    info.mockRestore();
  });

  it("cannot be made to log a second line, or an invented one", async () => {
    // This ends up in a log Tom reads as fact. A newline in the room code
    // would let a caller forge a whole extra call record next to a real one.
    caller = { id: "u2", email: "xdrabbit@gmail.com" };
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const POST = await usageRoute();
    await POST(
      usageRequest(
        {
          room: "AB\n[taos-call-cost] usd=0.0001 room=FAKE",
          seconds: -5,
          spend: { responses: 1e12, ttsCharacters: -400 }
        },
        "tok"
      )
    );
    const line = info.mock.calls[0]?.[0] as string;
    expect(line.split("\n")).toHaveLength(1);
    expect(line).not.toContain("FAKE");
    expect(line).toContain("seconds=0");
    expect(line).toContain("tts_chars=0");
    info.mockRestore();
  });
});
