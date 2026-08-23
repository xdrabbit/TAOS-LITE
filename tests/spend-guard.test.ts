// The fence around money.
//
// Ship report cdf9f02a, 8/19: POST /api/tts on production answered a bare
// curl — no session, no cookie, no header — with 14KB of ElevenLabs audio.
// The endpoint was public, the provider was not free, and the card was Tom's.
// /api/translate was the same, and so was every realtime MINTING route, which
// is worse: what those return is a live OpenAI session that keeps billing
// after the response has gone.
//
// Three things are pinned here, in descending order of how badly they'd hurt:
//
//   1. A refusal costs NOTHING. Every unauthenticated test below asserts that
//      global fetch was never called — not that the status was 401. A 401
//      returned after paying ElevenLabs is the same bill with better manners,
//      and it is the failure mode a naive fix actually produces.
//   2. The /try funnel still works signed out. "Try it now, no signup" is the
//      front door (components/AtomShell.tsx); a fix that closes it to close
//      the hole has broken the product to protect it.
//   3. The sweep. A route added next month that calls a paid provider and
//      forgets the guard is the same bug wearing a different path, and no
//      test written against today's route list would catch it — so the last
//      block reads the routes off disk instead.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resetRateLimits, SIGN_IN_REQUIRED } from "@/lib/spendGuard";

// ── Who is calling ─────────────────────────────────────────────────────────
// The routes must take identity from the token and nowhere else, so this is
// the only place a test can become "signed in".
let caller: { id: string; email: string } | null = null;

vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async (req: Request) => {
    const header = req.headers.get("authorization") ?? "";
    return header.startsWith("Bearer ") && caller ? caller : null;
  }
}));

// ── The provider ───────────────────────────────────────────────────────────
// One spy standing in for every paid API. `calls` is the bill.
// Typed with its arguments so `mock.calls[0][0]` is the URL that was about to
// be paid — several assertions below read it to prove WHICH provider a request
// reached, not merely that one did.
const fetchSpy = vi.fn(
  async (_input: unknown, _init?: unknown) =>
    new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "Content-Type": "audio/mpeg" }
    })
);

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  caller = null;
  fetchSpy.mockClear();
  resetRateLimits();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.ELEVENLABS_API_KEY = "test-elevenlabs-key";
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

const { POST: ttsPost } = await import("@/app/api/tts/route");
const { POST: liveMintPost } = await import("@/app/api/live/realtime/route");
const { POST: tabletopMintPost } = await import("@/app/api/tabletop/realtime/route");
const { POST: liveTranslatePost } = await import("@/app/api/live-translate/route");
const { POST: textTranslatePost } = await import("@/app/api/text-translate/route");

interface ReqOptions {
  /** Send a Bearer token (and make `caller` a real user). */
  signedIn?: boolean;
  /** Send an Origin header, the way a browser on our own site does. */
  origin?: string | null;
  ip?: string;
}

function jsonPost(path: string, body: unknown, opts: ReqOptions = {}): NextRequest {
  const { signedIn = false, origin = null, ip = "203.0.113.7" } = opts;
  if (signedIn) caller = { id: "user-1", email: "tom@example.com" };
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": ip
  };
  if (signedIn) headers.authorization = "Bearer test-token";
  if (origin) headers.origin = origin;
  return new NextRequest(`https://taoslite.com${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
}

// ── 1. The bare curl from the ship report ──────────────────────────────────

describe("the bare curl — no session, no origin, no anything", () => {
  it("/api/tts refuses it, and does not call ElevenLabs to find out", async () => {
    const res = await ttsPost(jsonPost("/api/tts", { text: "hola" }));
    expect(res.status).toBe(401);
    // THE assertion. A 401 with a provider call behind it is still a bill.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("says the true thing about why", async () => {
    const res = await ttsPost(jsonPost("/api/tts", { text: "hola" }));
    expect((await res.json()).error).toBe(SIGN_IN_REQUIRED);
  });

  it("refuses every realtime minting route without spending", async () => {
    for (const mint of [liveMintPost, tabletopMintPost]) {
      fetchSpy.mockClear();
      const res = await mint(jsonPost("/api/mint", { target: "es", source: "en" }));
      expect(res.status).toBe(401);
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  });

  it("refuses the two text routes without spending", async () => {
    for (const route of [liveTranslatePost, textTranslatePost]) {
      fetchSpy.mockClear();
      const res = await route(jsonPost("/api/t", { text: "hola", sourceLanguage: "es", targetLanguage: "en" }));
      expect(res.status).toBe(401);
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  });

  it("an Origin header alone does not buy a realtime session", async () => {
    // The /try allowance is deliberately NOT extended to minting. Forging an
    // Origin is a one-line curl flag; a minted secret bills for minutes.
    const res = await liveMintPost(
      jsonPost("/api/live/realtime", { target: "es" }, { origin: "https://taoslite.com" })
    );
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── 2. A signed-in caller is unaffected ────────────────────────────────────

describe("signed in — the app still works", () => {
  it("/api/tts synthesizes", async () => {
    const res = await ttsPost(jsonPost("/api/tts", { text: "hola" }, { signedIn: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("api.elevenlabs.io");
  });

  it("reaches ElevenLabs — the engine a signed-out caller may not have", async () => {
    await ttsPost(jsonPost("/api/tts", { text: "hola", engine: "elevenlabs" }, { signedIn: true }));
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("api.elevenlabs.io");
  });

  it("is not rate limited — the /try budget belongs to strangers", async () => {
    // Same IP, well past the anonymous per-minute allowance.
    for (let i = 0; i < 30; i += 1) {
      const res = await ttsPost(
        jsonPost("/api/tts", { text: "hola" }, { signedIn: true, ip: "198.51.100.4" })
      );
      expect(res.status).toBe(200);
    }
  });
});

// ── 3. The /try funnel, which must not break ───────────────────────────────

describe("/try — anonymous, on the allowance", () => {
  const TRY = { origin: "https://taoslite.com" } as const;

  it("gets audio from the cheap engine, signed out, exactly as before", async () => {
    // This is the request components/AtomShell.tsx actually sends.
    const res = await ttsPost(jsonPost("/api/tts", { text: "hello", engine: "openai" }, TRY));
    expect(res.status).toBe(200);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("api.openai.com");
  });

  it("works from a preview deployment and from localhost too", async () => {
    for (const origin of [
      "https://taos-lite-git-fix-tts-auth-xdrabbits-projects.vercel.app",
      "http://localhost:3017"
    ]) {
      fetchSpy.mockClear();
      const res = await ttsPost(jsonPost("/api/tts", { text: "hi", engine: "openai" }, { origin }));
      expect(res.status).toBe(200);
    }
  });

  it("is refused from somebody else's site", async () => {
    const res = await ttsPost(
      jsonPost("/api/tts", { text: "hi", engine: "openai" }, { origin: "https://evil.example.com" })
    );
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("may NOT have ElevenLabs — the expensive engine takes an account", async () => {
    const res = await ttsPost(jsonPost("/api/tts", { text: "hi", engine: "elevenlabs" }, TRY));
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("defaulting the engine does not sneak past it either", async () => {
    // The route's default is elevenlabs. An anonymous caller who simply omits
    // the field must not get the expensive one by accident.
    const res = await ttsPost(jsonPost("/api/tts", { text: "hi" }, TRY));
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("cannot ask for a novel's worth of speech in one call", async () => {
    const res = await ttsPost(
      jsonPost("/api/tts", { text: "a".repeat(5000), engine: "openai" }, TRY)
    );
    expect(res.status).toBe(413);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("runs out: the allowance is per IP and it is small", async () => {
    let refusedAt = -1;
    for (let i = 0; i < 40; i += 1) {
      const res = await ttsPost(
        jsonPost("/api/tts", { text: "hi", engine: "openai" }, { origin: TRY.origin, ip: "192.0.2.9" })
      );
      if (res.status === 429) {
        refusedAt = i;
        break;
      }
    }
    expect(refusedAt).toBeGreaterThan(0);
    // Whatever the limit is tuned to, the provider was called only for the
    // requests that were allowed through — never for a refused one.
    expect(fetchSpy).toHaveBeenCalledTimes(refusedAt);
  });

  it("one IP burning its allowance does not lock out the next visitor", async () => {
    for (let i = 0; i < 40; i += 1) {
      await ttsPost(
        jsonPost("/api/tts", { text: "hi", engine: "openai" }, { origin: TRY.origin, ip: "192.0.2.9" })
      );
    }
    const other = await ttsPost(
      jsonPost("/api/tts", { text: "hi", engine: "openai" }, { origin: TRY.origin, ip: "192.0.2.55" })
    );
    expect(other.status).toBe(200);
  });
});

// ── 4. The behaviors auth sits ON TOP OF, not in place of ──────────────────

describe("the existing gates still gate", () => {
  it("tier 2 still answers 422 textOnly for a signed-in caller", async () => {
    // lib/languages/catalog.ts: a language no engine here can speak. The
    // shape of this refusal is what lib/tts/speech.ts reads to stay quiet.
    const res = await ttsPost(
      jsonPost("/api/tts", { text: "hi", targetLanguage: "haw" }, { signedIn: true })
    );
    expect(res.status).toBe(422);
    expect((await res.json()).textOnly).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("auth comes FIRST — a stranger learns nothing about the catalog", async () => {
    const res = await ttsPost(jsonPost("/api/tts", { text: "hi", targetLanguage: "haw" }));
    expect(res.status).toBe(401);
  });

  it("the personal-voice gate is untouched: no code, no clone", async () => {
    process.env.TAOS_PERSONAL_VOICE_CODE = "secret-code";
    await ttsPost(
      jsonPost("/api/tts", { text: "hola", sourceLanguage: "en", targetLanguage: "es" }, { signedIn: true })
    );
    const url = String(fetchSpy.mock.calls[0]?.[0]);
    const { ELEVENLABS_TOM_VOICE, ELEVENLABS_LIZ_VOICE_ENV, lizElevenLabsVoiceId } = await import(
      "@/lib/tts/voice"
    );
    process.env[ELEVENLABS_LIZ_VOICE_ENV] = "liz-voice-id-from-env";
    expect(url).not.toContain(ELEVENLABS_TOM_VOICE);
    expect(url).not.toContain(lizElevenLabsVoiceId());
    delete process.env[ELEVENLABS_LIZ_VOICE_ENV];
    delete process.env.TAOS_PERSONAL_VOICE_CODE;
  });
});

// ── 5. The sweep ───────────────────────────────────────────────────────────
// Written against the filesystem rather than a list, because the bug this
// whole file exists for was a route nobody remembered was public.

describe("every route that spends money asks who is calling", () => {
  const API_ROOT = join(process.cwd(), "app/api");

  /**
   * Signs that a route is about to pay somebody.
   *
   * Hostnames alone are not enough, and finding that out is the reason this
   * list has two halves: /api/live-translate and /api/text-translate spend on
   * every call and mention no host at all, because they go through
   * `chatCompletion` in lib/translateProvider.ts. A sweep that only grepped
   * for `api.openai.com` reported both of them as "not a money route" — the
   * precise blind spot that let the original hole sit in production. So the
   * key names and the helper names count too: a route cannot reach a paid API
   * without naming one of these somewhere.
   */
  const PAID_PROVIDERS = [
    "api.openai.com",
    "api.elevenlabs.io",
    // Azure pronunciation scoring (/api/tutor/assess).
    "cognitiveservices",
    "tts.speech.microsoft.com",
    // Spending indirectly, through a lib that holds the fetch.
    "OPENAI_API_KEY",
    "ELEVENLABS_API_KEY",
    "AZURE_SPEECH_KEY",
    "getOpenAIKey",
    "chatCompletion"
  ];

  /** Anything that establishes WHO is calling before the money is spent. */
  const GUARDS = ["guardSpend", "getUserFromRequest"];

  function routeFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...routeFiles(full));
      else if (entry.name === "route.ts") out.push(full);
    }
    return out;
  }

  const spendRoutes = routeFiles(API_ROOT)
    .map((file) => ({ file, source: readFileSync(file, "utf8") }))
    .filter(({ source }) => PAID_PROVIDERS.some((host) => source.includes(host)));

  it("finds the money routes at all (the sweep is not vacuously passing)", () => {
    expect(spendRoutes.length).toBeGreaterThanOrEqual(8);
  });

  it.each(spendRoutes.map(({ file }) => file))("%s is guarded", (file) => {
    const source = readFileSync(file, "utf8");
    // Stripe's webhook is the one legitimate exception: its caller is Stripe,
    // not a person, and it authenticates by signature instead of by session.
    if (file.includes("stripe/webhook")) {
      expect(source).toContain("constructEvent");
      return;
    }
    expect(GUARDS.some((guard) => source.includes(guard))).toBe(true);
  });
});
