// /demo — "Tu voz" (2026-10-24). A stranger's voice is cloned for ten
// minutes and then deleted; these pin the parts of that promise that live in
// code:
//
//   1. the gate tells "flag off" from "signed out" from "not a founder"
//   2. no consent → no ElevenLabs add-voice call, whatever else is sent
//   3. /api/tts speaks in a client-named voice ONLY for a live demo voice,
//      for the founder who made it, inside its lines and its ten minutes —
//      and a refusal never falls back to another voice
//   4. the sweeper deletes `taos-demo-*` voices past ten minutes (and strays
//      nobody can date), and keeps the ones still inside their window
//   5. the share filename
//
// ElevenLabs is a fetch mock routed by URL; nothing here reaches the network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async (req: Request) => {
    const auth = req.headers.get("authorization") ?? "";
    if (auth === "Bearer tom") return { id: "u-tom", email: "xdrabbit@gmail.com" };
    if (auth === "Bearer liz") return { id: "u-liz", email: "lizmariett@gmail.com" };
    if (auth === "Bearer stranger") return { id: "u-stranger", email: "someone@example.com" };
    return null;
  }
}));

const { demoGateState } = await import("@/lib/demo/gate");
const {
  authorizeDemoVoice,
  liveDemoVoices,
  mintDemoToken,
  resetDemoState,
  sweepDemoVoices
} = await import("@/lib/demo/server");
const { DEMO_MAX_CLONES_PER_DAY, DEMO_MAX_LINES, DEMO_TTL_MS, demoShareFileName } = await import(
  "@/lib/demo/limits"
);
const clone = await import("@/app/api/demo/clone/route");
const cleanup = await import("@/app/api/demo/cleanup/route");
const sweep = await import("@/app/api/demo/sweep/route");
const tts = await import("@/app/api/tts/route");

// ── The ElevenLabs mock ────────────────────────────────────────────────────

type Listed = { voice_id: string; name: string; labels?: Record<string, string>; created_at_unix?: number };
let listed: Listed[] = [];
let nextVoice = 0;

async function elevenLabs(input: unknown, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const method = init?.method ?? "GET";
  if (url.endsWith("/v1/voices/add") && method === "POST") {
    nextVoice += 1;
    return Response.json({ voice_id: `voice-${nextVoice}`, requires_verification: false });
  }
  if (url.includes("/v1/voices/") && method === "DELETE") return new Response("{}", { status: 200 });
  if (url.includes("/v2/voices")) return Response.json({ voices: listed, has_more: false });
  if (url.includes("/v1/text-to-speech/")) {
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "audio/mpeg" } });
  }
  return new Response("unexpected", { status: 500 });
}
const fetchSpy = vi.fn(elevenLabs);

function calls(match: (url: string, method: string) => boolean): Array<[string, RequestInit]> {
  return (fetchSpy.mock.calls as Array<[unknown, RequestInit | undefined]>)
    .map(([u, i]) => [String(u), i ?? {}] as [string, RequestInit])
    .filter(([u, i]) => match(u, i.method ?? "GET"));
}
const addCalls = () => calls((u, m) => u.endsWith("/v1/voices/add") && m === "POST");
const deleteCalls = () => calls((u, m) => u.includes("/v1/voices/") && m === "DELETE");
const ttsCalls = () => calls((u) => u.includes("/v1/text-to-speech/"));

const ORIGINAL_FETCH = globalThis.fetch;
const saved = { ...process.env };

beforeEach(() => {
  fetchSpy.mockClear();
  // Reset the implementation too, so a test that swaps it and then fails
  // cannot leak its mock into every test after it.
  fetchSpy.mockImplementation(elevenLabs);
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  process.env.ELEVENLABS_API_KEY = "test-elevenlabs-key";
  process.env.TAOS_DEMO_ENABLED = "1";
  listed = [];
  resetDemoState();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  process.env = { ...saved };
  vi.restoreAllMocks();
});

// ── Request builders ───────────────────────────────────────────────────────

function cloneRequest(
  who: string | null,
  fields: { consent?: string; durationMs?: number; removeNoise?: string; bytes?: number } = {}
): NextRequest {
  const form = new FormData();
  form.append("sample", new File([new Uint8Array(fields.bytes ?? 2048)], "sample.webm", { type: "audio/webm" }));
  if (fields.consent !== undefined) form.append("consent", fields.consent);
  form.append("durationMs", String(fields.durationMs ?? 45_000));
  if (fields.removeNoise !== undefined) form.append("removeNoise", fields.removeNoise);
  const headers: Record<string, string> = {};
  if (who) headers.authorization = `Bearer ${who}`;
  return new NextRequest("https://taoslite.com/api/demo/clone", { method: "POST", headers, body: form });
}

async function makeVoice(who = "tom"): Promise<{ voiceId: string; token: string; expiresAt: number }> {
  const res = await clone.POST(cloneRequest(who, { consent: "yes" }));
  expect(res.status).toBe(200);
  return (await res.json()) as { voiceId: string; token: string; expiresAt: number };
}

function ttsRequest(who: string | null, body: Record<string, unknown>): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json", origin: "https://taoslite.com" };
  if (who) headers.authorization = `Bearer ${who}`;
  return new NextRequest("https://taoslite.com/api/tts", {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "Hola, ¿cómo estás?", engine: "elevenlabs", sourceLanguage: "en", targetLanguage: "es", ...body })
  });
}

// ── 1. The gate ────────────────────────────────────────────────────────────

describe("the /demo gate", () => {
  const base = { enabled: true, ready: true, signedIn: true, email: "xdrabbit@gmail.com" };

  it("says 'not enabled' when the flag is off — to everybody, signed in or not", () => {
    expect(demoGateState({ ...base, enabled: false })).toBe("disabled");
    expect(demoGateState({ ...base, enabled: false, signedIn: false, email: null })).toBe("disabled");
  });

  it("offers sign-in, not a dead end, when the flag is on and nobody is signed in", () => {
    expect(demoGateState({ ...base, signedIn: false, email: null })).toBe("sign-in");
  });

  it("waits for the session before deciding", () => {
    expect(demoGateState({ ...base, ready: false, signedIn: false, email: null })).toBe("loading");
  });

  it("opens for founders and turns away everyone else", () => {
    expect(demoGateState(base)).toBe("open");
    expect(demoGateState({ ...base, email: "lizmariett@gmail.com" })).toBe("open");
    expect(demoGateState({ ...base, email: "someone@example.com" })).toBe("denied");
  });
});

// ── 2. The clone route ─────────────────────────────────────────────────────

describe("POST /api/demo/clone", () => {
  it("is a 404 with the flag off, and calls nobody", async () => {
    delete process.env.TAOS_DEMO_ENABLED;
    const res = await clone.POST(cloneRequest("tom", { consent: "yes" }));
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("wants a session (401) and a founder (404)", async () => {
    expect((await clone.POST(cloneRequest(null, { consent: "yes" }))).status).toBe(401);
    expect((await clone.POST(cloneRequest("stranger", { consent: "yes" }))).status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses without the consent flag and never calls add-voice", async () => {
    for (const consent of [undefined, "", "no", "true"]) {
      const res = await clone.POST(cloneRequest("tom", { consent }));
      expect(res.status).toBe(403);
    }
    expect(addCalls()).toHaveLength(0);
  });

  it("refuses a sample under the minimum or over the maximum", async () => {
    expect((await clone.POST(cloneRequest("tom", { consent: "yes", durationMs: 4_000 }))).status).toBe(400);
    expect((await clone.POST(cloneRequest("tom", { consent: "yes", durationMs: 200_000 }))).status).toBe(413);
    expect(addCalls()).toHaveLength(0);
  });

  it("clones with a taos-demo-* name, noise removal on, and a ten-minute expiry label", async () => {
    const before = Date.now();
    const v = await makeVoice();
    expect(v.voiceId).toBe(`voice-${nextVoice}`);
    expect(typeof v.token).toBe("string");
    expect(v.expiresAt).toBeGreaterThanOrEqual(before + DEMO_TTL_MS);

    const [url, init] = addCalls()[0];
    expect(url).toBe("https://api.elevenlabs.io/v1/voices/add");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("test-elevenlabs-key");
    const form = init.body as FormData;
    expect(String(form.get("name"))).toMatch(/^taos-demo-[0-9a-f]{8}$/);
    expect(form.get("remove_background_noise")).toBe("true");
    const labels = JSON.parse(String(form.get("labels"))) as Record<string, string>;
    expect(labels.taos).toBe("demo");
    expect(Date.parse(labels.expires)).toBe(v.expiresAt);
    expect(form.get("files")).toBeInstanceOf(Blob);
  });

  it("passes noise removal OFF when the founder unticks it", async () => {
    await clone.POST(cloneRequest("tom", { consent: "yes", removeNoise: "0" }));
    expect((addCalls()[0][1].body as FormData).get("remove_background_noise")).toBe("false");
  });

  it(`stops at ${DEMO_MAX_CLONES_PER_DAY} clones per founder per day`, async () => {
    for (let i = 0; i < DEMO_MAX_CLONES_PER_DAY; i += 1) await makeVoice();
    const res = await clone.POST(cloneRequest("tom", { consent: "yes" }));
    expect(res.status).toBe(429);
    expect(addCalls()).toHaveLength(DEMO_MAX_CLONES_PER_DAY);
    // Per founder, not shared.
    await makeVoice("liz");
  });
});

// ── 3. The voiceOverride on /api/tts ───────────────────────────────────────

describe("/api/tts voiceOverride", () => {
  it("speaks in a live demo voice for the founder who made it", async () => {
    const v = await makeVoice();
    const res = await tts.POST(ttsRequest("tom", { voiceOverride: v.voiceId, demoToken: v.token }));
    expect(res.status).toBe(200);
    expect(ttsCalls()).toHaveLength(1);
    expect(ttsCalls()[0][0]).toContain(`/v1/text-to-speech/${v.voiceId}?`);
    expect(res.headers.get("X-Demo-Lines-Left")).toBe(String(DEMO_MAX_LINES - 1));
  });

  it("refuses an arbitrary ElevenLabs voice id — no token, no voice, no fallback", async () => {
    const res = await tts.POST(ttsRequest("tom", { voiceOverride: "21m00Tcm4TlvDq8Ikw" }));
    expect(res.status).toBe(403);
    expect(ttsCalls()).toHaveLength(0);
  });

  it("refuses a real token presented for a different voice", async () => {
    const v = await makeVoice();
    const res = await tts.POST(ttsRequest("tom", { voiceOverride: "some-other-voice", demoToken: v.token }));
    expect(res.status).toBe(403);
    expect(ttsCalls()).toHaveLength(0);
  });

  it("refuses a forged token", async () => {
    const v = await makeVoice();
    const [body] = v.token.split(".");
    const res = await tts.POST(ttsRequest("tom", { voiceOverride: v.voiceId, demoToken: `${body}.forged` }));
    expect(res.status).toBe(403);
  });

  it("refuses another founder, a stranger, and an anonymous caller", async () => {
    const v = await makeVoice("tom");
    for (const who of ["liz", "stranger", null]) {
      const res = await tts.POST(
        ttsRequest(who, { voiceOverride: v.voiceId, demoToken: v.token, engine: who ? "elevenlabs" : "openai" })
      );
      expect(res.status, String(who)).toBe(403);
    }
    expect(ttsCalls()).toHaveLength(0);
  });

  it("refuses everything with the flag off", async () => {
    const v = await makeVoice();
    delete process.env.TAOS_DEMO_ENABLED;
    const res = await tts.POST(ttsRequest("tom", { voiceOverride: v.voiceId, demoToken: v.token }));
    expect(res.status).toBe(403);
    expect(ttsCalls()).toHaveLength(0);
  });

  it(`allows ${DEMO_MAX_LINES} lines and refuses the next`, async () => {
    const v = await makeVoice();
    for (let i = 0; i < DEMO_MAX_LINES; i += 1) {
      expect((await tts.POST(ttsRequest("tom", { voiceOverride: v.voiceId, demoToken: v.token }))).status).toBe(200);
    }
    expect((await tts.POST(ttsRequest("tom", { voiceOverride: v.voiceId, demoToken: v.token }))).status).toBe(403);
    expect(ttsCalls()).toHaveLength(DEMO_MAX_LINES);
  });

  it("refuses a voice past its ten minutes, and one already deleted", async () => {
    const v = await makeVoice();
    expect(
      authorizeDemoVoice({ voiceId: v.voiceId, token: v.token, userId: "u-tom", now: v.expiresAt + 1, consume: false })
    ).toEqual({ ok: false, reason: "expired" });

    const res = await cleanup.POST(
      new NextRequest("https://taoslite.com/api/demo/cleanup", {
        method: "POST",
        body: JSON.stringify({ voiceId: v.voiceId, token: v.token, reason: "done" })
      })
    );
    expect(res.status).toBe(200);
    expect((await tts.POST(ttsRequest("tom", { voiceOverride: v.voiceId, demoToken: v.token }))).status).toBe(403);
  });

  it("accepts a signed token minted on another instance (the map is per instance)", () => {
    const token = mintDemoToken({ v: "voice-elsewhere", u: "u-tom", e: Date.now() + 60_000 });
    expect(authorizeDemoVoice({ voiceId: "voice-elsewhere", token, userId: "u-tom", consume: false }).ok).toBe(true);
  });

  it("leaves the ordinary path alone: no override, no demo", async () => {
    const res = await tts.POST(ttsRequest("tom", {}));
    expect(res.status).toBe(200);
    expect(ttsCalls()[0][0]).not.toContain("voice-");
  });
});

// ── 4. Cleanup and the sweeper ─────────────────────────────────────────────

describe("cleanup", () => {
  it("deletes on a beacon carrying the signed token — no session needed", async () => {
    const v = await makeVoice();
    const res = await cleanup.POST(
      new NextRequest("https://taoslite.com/api/demo/cleanup", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ voiceId: v.voiceId, token: v.token, reason: "unload" })
      })
    );
    expect(res.status).toBe(200);
    expect(deleteCalls().map(([u]) => u)).toContain(`https://api.elevenlabs.io/v1/voices/${v.voiceId}`);
    expect(liveDemoVoices()).not.toContain(v.voiceId);
  });

  it("counts ElevenLabs' real 'already deleted' answer (400 voice_not_found) as gone", async () => {
    const v = await makeVoice();
    // The real body, from a second DELETE against the live API on 2026-10-24.
    let answered = 0;
    fetchSpy.mockImplementation(async (input: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") !== "DELETE") return elevenLabs(input, init);
      answered += 1;
      return Response.json(
        { detail: { type: "not_found", code: "voice_not_found", status: "voice_does_not_exist" } },
        { status: 400 }
      );
    });
    const res = await cleanup.POST(
      new NextRequest("https://taoslite.com/api/demo/cleanup", {
        method: "POST",
        body: JSON.stringify({ voiceId: v.voiceId, token: v.token, reason: "done" })
      })
    );
    expect(await res.json()).toEqual({ deleted: true });
    expect(answered).toBe(1);
  });

  it("refuses a voice id without its token", async () => {
    const v = await makeVoice();
    const res = await cleanup.POST(
      new NextRequest("https://taoslite.com/api/demo/cleanup", {
        method: "POST",
        body: JSON.stringify({ voiceId: v.voiceId, token: "nope" })
      })
    );
    expect(res.status).toBe(403);
    expect(deleteCalls().filter(([u]) => u.endsWith(v.voiceId))).toHaveLength(0);
  });
});

describe("the sweeper", () => {
  it("deletes taos-demo-* voices older than ten minutes and strays, keeps fresh ones and others", async () => {
    const now = Date.now();
    listed = [
      { voice_id: "old", name: "taos-demo-aaaa1111", labels: { taos: "demo", expires: new Date(now - 1_000).toISOString() } },
      { voice_id: "fresh", name: "taos-demo-bbbb2222", labels: { taos: "demo", expires: new Date(now + 300_000).toISOString() } },
      { voice_id: "dated", name: "taos-demo-cccc3333", created_at_unix: Math.floor((now - DEMO_TTL_MS - 60_000) / 1000) },
      { voice_id: "stray", name: "taos-demo-dddd4444" },
      { voice_id: "liz", name: "lizma2", labels: {} }
    ];
    const result = await sweepDemoVoices(now);
    expect(result.deleted.sort()).toEqual(["dated", "old", "stray"]);
    expect(result.kept).toBe(1);
    const deletedUrls = deleteCalls().map(([u]) => u);
    expect(deletedUrls.some((u) => u.endsWith("/fresh"))).toBe(false);
    expect(deletedUrls.some((u) => u.endsWith("/liz"))).toBe(false);
  });

  it("deletes the voices this instance remembers once their ten minutes are up", async () => {
    const v = await makeVoice();
    fetchSpy.mockClear();
    const result = await sweepDemoVoices(v.expiresAt + 1);
    expect(result.deleted).toContain(v.voiceId);
  });

  it("still deletes remembered voices when the list call fails", async () => {
    const v = await makeVoice();
    listed = null as unknown as Listed[];
    fetchSpy.mockImplementationOnce(async () => new Response("down", { status: 503 }));
    const result = await sweepDemoVoices(v.expiresAt + 1);
    expect(result.listError).not.toBeNull();
    expect(result.deleted).toContain(v.voiceId);
  });

  it("GET /api/demo/sweep is founders-only", async () => {
    const get = (who: string | null) =>
      sweep.GET(
        new NextRequest("https://taoslite.com/api/demo/sweep", {
          headers: who ? { authorization: `Bearer ${who}` } : {}
        })
      );
    expect((await get(null)).status).toBe(401);
    expect((await get("stranger")).status).toBe(404);
    expect((await get("tom")).status).toBe(200);
    delete process.env.TAOS_DEMO_ENABLED;
    expect((await get("tom")).status).toBe(404);
  });
});

// ── 5. Share ───────────────────────────────────────────────────────────────

describe("share filename", () => {
  it("is TAOS · <lang> · taoslite.com.mp3", () => {
    expect(demoShareFileName("Spanish")).toBe("TAOS · Spanish · taoslite.com.mp3");
  });
});
