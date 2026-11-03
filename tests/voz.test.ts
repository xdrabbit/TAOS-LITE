// /voz — the public "Tu voz" (2026-10-24). A stranger, on their own phone,
// no account: consent → record → hear themselves in the other language →
// share → the voice is deleted. These pin the fences an anonymous front door
// needs, on top of /demo's promise (tests/demo.test.ts):
//
//   1. flag off → every route is a 404; a bare curl → 401 (guardSpend)
//   2. no consent token → 403, and ElevenLabs is never called
//   3. one try per device per day anonymous (cookie AND IP+UA bucket), 3
//      signed in, 10 subscribed
//   4. the global anonymous day cap, the live-voice ceiling, the per-IP hour
//   5. two lines per voice, only for the voice your own consent made
//   6. the sweeper deletes `taos-voz-*` past ten minutes; /api/demo/sweep
//      covers it too
//   7. nothing is logged but `[taos-voz] event=…` lines with no text
//
// ElevenLabs and OpenAI are a fetch mock routed by URL; nothing reaches the network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async (req: Request) => {
    const auth = req.headers.get("authorization") ?? "";
    if (auth === "Bearer tom") return { id: "u-tom", email: "xdrabbit@gmail.com" };
    if (auth === "Bearer free") return { id: "u-free", email: "free@example.com" };
    if (auth === "Bearer paid") return { id: "u-paid", email: "paid@example.com" };
    return null;
  }
}));

const profiles: Record<string, { tier: string | null; subscription_status: string }> = {
  "u-free": { tier: null, subscription_status: "trialing" },
  "u-paid": { tier: "basic", subscription_status: "active" }
};
vi.mock("@/lib/supabaseAdmin", () => ({
  hasServiceRoleKey: true,
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: (_col: string, id: string) => ({
          maybeSingle: async () => ({ data: profiles[id] ?? null, error: null })
        })
      })
    })
  }
}));

const { resetRateLimits } = await import("@/lib/spendGuard");
const { resetVozState, sweepVozVoices, VOZ_COOKIE } = await import("@/lib/voz/server");
const { mintDemoToken } = await import("@/lib/demo/server");
const { VOZ_MAX_LINES, VOZ_MAX_SAMPLE_SECONDS, VOZ_TRIES_PER_DAY, VOZ_TTL_MS, vozTargetFor } = await import(
  "@/lib/voz/limits"
);
const consent = await import("@/app/api/voz/consent/route");
const clone = await import("@/app/api/voz/clone/route");
const line = await import("@/app/api/voz/line/route");
const cleanup = await import("@/app/api/voz/cleanup/route");
const share = await import("@/app/api/voz/share/route");
const demoSweep = await import("@/app/api/demo/sweep/route");

// ── The provider mock ──────────────────────────────────────────────────────

type Listed = { voice_id: string; name: string; labels?: Record<string, string>; created_at_unix?: number };
let listed: Listed[] = [];
let nextVoice = 0;

async function providers(input: unknown, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const method = init?.method ?? "GET";
  if (url.endsWith("/v1/voices/add") && method === "POST") {
    nextVoice += 1;
    return Response.json({ voice_id: `voz-${nextVoice}` });
  }
  if (url.includes("/v1/voices/") && method === "DELETE") return new Response("{}", { status: 200 });
  if (url.includes("/v2/voices")) return Response.json({ voices: listed, has_more: false });
  if (url.includes("/v1/text-to-speech/")) {
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "audio/mpeg" } });
  }
  if (url.includes("api.openai.com/v1/chat/completions")) {
    return Response.json({ choices: [{ message: { content: "Hello, how are you?" } }] });
  }
  return new Response("unexpected", { status: 500 });
}
const fetchSpy = vi.fn(providers);

function calls(match: (url: string, method: string) => boolean): string[] {
  return (fetchSpy.mock.calls as Array<[unknown, RequestInit | undefined]>)
    .filter(([u, i]) => match(String(u), i?.method ?? "GET"))
    .map(([u]) => String(u));
}
const addCalls = () => calls((u, m) => u.endsWith("/v1/voices/add") && m === "POST");
const ttsCalls = () => calls((u) => u.includes("/v1/text-to-speech/"));
const chatCalls = () => calls((u) => u.includes("/chat/completions"));

const ORIGINAL_FETCH = globalThis.fetch;
const saved = { ...process.env };
let logs: string[] = [];

beforeEach(() => {
  fetchSpy.mockClear();
  fetchSpy.mockImplementation(providers);
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  process.env.ELEVENLABS_API_KEY = "test-elevenlabs-key";
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.TAOS_VOZ_ENABLED = "1";
  process.env.TAOS_DEMO_ENABLED = "1";
  delete process.env.TAOS_VOZ_DAILY_CAP;
  delete process.env.TAOS_VOZ_MAX_LIVE;
  listed = [];
  resetVozState();
  resetRateLimits();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  process.env = { ...saved };
  vi.restoreAllMocks();
});

// ── A phone ────────────────────────────────────────────────────────────────
// Each Phone is one browser: an IP, a user agent, a cookie jar, maybe a session.

let phoneCount = 0;

class Phone {
  cookie: string | null = null;
  constructor(
    readonly who: string | null = null,
    readonly ip = `203.0.113.${++phoneCount}`,
    readonly ua = `Mozilla/5.0 (iPhone; phone ${phoneCount})`
  ) {}

  headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {
      origin: "https://taoslite.com",
      "x-forwarded-for": this.ip,
      "user-agent": this.ua,
      ...extra
    };
    if (this.who) h.authorization = `Bearer ${this.who}`;
    if (this.cookie) h.cookie = `${VOZ_COOKIE}=${this.cookie}`;
    return h;
  }

  keep(res: Response): Response {
    const set = (res as unknown as { cookies?: { get(n: string): { value: string } | undefined } }).cookies?.get(
      VOZ_COOKIE
    );
    if (set?.value) this.cookie = set.value;
    return res;
  }

  async consent(): Promise<Response> {
    return this.keep(
      await consent.POST(new NextRequest("https://taoslite.com/api/voz/consent", { method: "POST", headers: this.headers() }))
    );
  }

  async clone(consentToken: string | null, fields: { durationMs?: number; type?: string } = {}): Promise<Response> {
    const form = new FormData();
    form.append(
      "sample",
      new File([new Uint8Array(2048)], "sample.webm", { type: fields.type ?? "audio/webm" })
    );
    if (consentToken !== null) form.append("consentToken", consentToken);
    form.append("durationMs", String(fields.durationMs ?? 30_000));
    return this.keep(
      await clone.POST(
        new NextRequest("https://taoslite.com/api/voz/clone", { method: "POST", headers: this.headers(), body: form })
      )
    );
  }

  /** consent → clone, asserting both succeed. */
  async tryOnce(): Promise<{ voiceId: string; token: string; expiresAt: number }> {
    const c = await this.consent();
    expect(c.status).toBe(200);
    const { token } = (await c.json()) as { token: string };
    const res = await this.clone(token);
    expect(res.status).toBe(200);
    return (await res.json()) as { voiceId: string; token: string; expiresAt: number };
  }

  async line(voiceId: string, token: string, text = "Hola, ¿cómo estás?"): Promise<Response> {
    const form = new FormData();
    form.append("voiceId", voiceId);
    form.append("token", token);
    form.append("sourceLanguage", "es");
    form.append("targetLanguage", "en");
    form.append("text", text);
    return line.POST(
      new NextRequest("https://taoslite.com/api/voz/line", { method: "POST", headers: this.headers(), body: form })
    );
  }
}

// ── 1. The flag and the bare curl ──────────────────────────────────────────

describe("the front door", () => {
  it("is a 404 on every route with the flag off, and calls nobody", async () => {
    delete process.env.TAOS_VOZ_ENABLED;
    const phone = new Phone();
    expect((await phone.consent()).status).toBe(404);
    expect((await phone.clone("x")).status).toBe(404);
    expect((await phone.line("v", "t")).status).toBe(404);
    const beacon = (url: string, r: typeof cleanup) =>
      r.POST(new NextRequest(url, { method: "POST", body: JSON.stringify({ voiceId: "v", token: "t" }) }));
    expect((await beacon("https://taoslite.com/api/voz/cleanup", cleanup)).status).toBe(404);
    expect((await beacon("https://taoslite.com/api/voz/share", share)).status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a bare curl — no session, no origin — before anything else (guardSpend)", async () => {
    const res = await consent.POST(new NextRequest("https://taoslite.com/api/voz/consent", { method: "POST" }));
    expect(res.status).toBe(401);
    const form = new FormData();
    form.append("sample", new File([new Uint8Array(2048)], "s.webm", { type: "audio/webm" }));
    const c = await clone.POST(new NextRequest("https://taoslite.com/api/voz/clone", { method: "POST", body: form }));
    expect(c.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lets an anonymous phone on our own site through, and sets an httpOnly device cookie", async () => {
    const res = await new Phone().consent();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; triesLeft: number; tier: string };
    expect(body.tier).toBe("anonymous");
    expect(body.triesLeft).toBe(VOZ_TRIES_PER_DAY.anonymous);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${VOZ_COOKIE}=`);
    expect(setCookie.toLowerCase()).toContain("httponly");
    // Consent spends nothing.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── 2. Consent ─────────────────────────────────────────────────────────────

describe("the consent gate", () => {
  it("refuses a sample with no consent token (403) and never calls add-voice", async () => {
    const phone = new Phone();
    await phone.consent();
    const res = await phone.clone(null);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("consent");
    expect(addCalls()).toHaveLength(0);
  });

  it("refuses a forged token, and a /demo token", async () => {
    const phone = new Phone();
    const { token } = (await (await phone.consent()).json()) as { token: string };
    const [body] = token.split(".");
    expect((await phone.clone(`${body}.forged`)).status).toBe(403);
    const demo = mintDemoToken({ v: "x", u: "u-tom", e: Date.now() + 60_000 });
    expect((await phone.clone(demo)).status).toBe(403);
    expect(addCalls()).toHaveLength(0);
  });

  it("refuses a consent given on another phone — the token is bound to the device", async () => {
    const mine = new Phone();
    const { token } = (await (await mine.consent()).json()) as { token: string };
    const theirs = new Phone();
    await theirs.consent();
    expect((await theirs.clone(token)).status).toBe(403);
    expect(addCalls()).toHaveLength(0);
  });

  it("refuses a consent older than its fifteen minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const phone = new Phone();
      const { token } = (await (await phone.consent()).json()) as { token: string };
      vi.setSystemTime(Date.now() + 16 * 60_000);
      expect((await phone.clone(token)).status).toBe(403);
      expect(addCalls()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clones with a taos-voz-* name, noise removal on, and a ten-minute expiry label", async () => {
    const before = Date.now();
    const v = await new Phone().tryOnce();
    expect(v.expiresAt).toBeGreaterThanOrEqual(before + VOZ_TTL_MS);
    const [, init] = (fetchSpy.mock.calls as Array<[unknown, RequestInit]>).find(([u]) =>
      String(u).endsWith("/v1/voices/add")
    )!;
    const form = init.body as FormData;
    expect(String(form.get("name"))).toMatch(/^taos-voz-[0-9a-f]{8}$/);
    expect(form.get("remove_background_noise")).toBe("true");
    const labels = JSON.parse(String(form.get("labels"))) as { taos: string; expires: string };
    expect(labels.taos).toBe("voz");
    expect(Date.parse(labels.expires)).toBe(v.expiresAt);
    expect(logs.some((l) => l.startsWith("[taos-voz] event=clone") && l.includes("tier=anonymous"))).toBe(true);
  });

  it(`refuses a sample under 10 s or over ${VOZ_MAX_SAMPLE_SECONDS} s, and a non-audio upload`, async () => {
    for (const fields of [{ durationMs: 5_000 }, { durationMs: (VOZ_MAX_SAMPLE_SECONDS + 5) * 1000 }, { type: "image/png" }]) {
      const phone = new Phone();
      const { token } = (await (await phone.consent()).json()) as { token: string };
      expect((await phone.clone(token, fields)).status).toBeGreaterThanOrEqual(400);
    }
    expect(addCalls()).toHaveLength(0);
  });
});

// ── 3. Per day ─────────────────────────────────────────────────────────────

describe("tries per day", () => {
  it("gives an anonymous phone ONE try a day, refused at the consent tap the second time", async () => {
    const phone = new Phone();
    await phone.tryOnce();
    const again = await phone.consent();
    expect(again.status).toBe(429);
    const body = (await again.json()) as { code: string; error: string };
    expect(body.code).toBe("daily");
    expect(body.error).toContain("You've used today's free try");
    expect(addCalls()).toHaveLength(1);
  });

  it("still counts the try when the cookie is cleared — same IP and browser", async () => {
    const phone = new Phone();
    await phone.tryOnce();
    phone.cookie = null;
    expect((await phone.consent()).status).toBe(429);
  });

  it("still counts the try on another instance — the signed cookie carries it", async () => {
    const phone = new Phone();
    await phone.tryOnce();
    resetVozState(); // a cold start: this instance remembers nothing
    expect((await phone.consent()).status).toBe(429);
  });

  it("refuses a stockpiled consent token once today's try is used", async () => {
    const phone = new Phone();
    const { token: spare } = (await (await phone.consent()).json()) as { token: string };
    await phone.tryOnce();
    expect((await phone.clone(spare)).status).toBe(429);
    expect(addCalls()).toHaveLength(1);
  });

  it(`gives a signed-in free account ${VOZ_TRIES_PER_DAY.free} a day`, async () => {
    const phone = new Phone("free");
    for (let i = 0; i < VOZ_TRIES_PER_DAY.free; i += 1) await phone.tryOnce();
    const res = await phone.consent();
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe("Vuelve mañana · Come back tomorrow");
  });

  it(`gives a subscriber ${VOZ_TRIES_PER_DAY.subscriber} a day (IPs vary — the per-IP hour is its own test)`, async () => {
    for (let i = 0; i < VOZ_TRIES_PER_DAY.subscriber; i += 1) {
      await new Phone("paid").tryOnce();
    }
    const c = await new Phone("paid").consent();
    expect(c.status).toBe(429);
  });
});

// ── 4. Global ceilings ─────────────────────────────────────────────────────

describe("global ceilings", () => {
  it("stops anonymous clones at TAOS_VOZ_DAILY_CAP, politely", async () => {
    process.env.TAOS_VOZ_DAILY_CAP = "2";
    await new Phone().tryOnce();
    await new Phone().tryOnce();
    const res = await new Phone().consent();
    expect(res.status).toBe(429);
    const body = (await res.json()) as { code: string; error: string };
    expect(body).toEqual({ code: "cap", error: "Vuelve mañana · Come back tomorrow" });
    expect(logs.some((l) => l.includes("event=refused") && l.includes("reason=cap"))).toBe(true);
    // A signed-in account is not an anonymous clone.
    await new Phone("free").tryOnce();
  });

  it("refuses when TAOS_VOZ_MAX_LIVE voices are alive account-wide, without calling add-voice", async () => {
    process.env.TAOS_VOZ_MAX_LIVE = "2";
    const fresh = new Date(Date.now() + 300_000).toISOString();
    listed = [
      { voice_id: "a", name: "taos-voz-aaaa1111", labels: { taos: "voz", expires: fresh } },
      { voice_id: "b", name: "taos-voz-bbbb2222", labels: { taos: "voz", expires: fresh } },
      // Not ours to count:
      { voice_id: "d", name: "taos-demo-cccc3333", labels: { taos: "demo", expires: fresh } }
    ];
    const phone = new Phone();
    const { token } = (await (await phone.consent()).json()) as { token: string };
    const res = await phone.clone(token);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { code: string }).code).toBe("live");
    expect(addCalls()).toHaveLength(0);
  });

  it("an expired voice does not hold a slot — the ceiling sweeps first", async () => {
    process.env.TAOS_VOZ_MAX_LIVE = "1";
    listed = [{ voice_id: "old", name: "taos-voz-dddd4444", labels: { expires: new Date(Date.now() - 1000).toISOString() } }];
    await new Phone().tryOnce(); // asserts 200: the dead voice did not count
    expect(calls((u, m) => m === "DELETE" && u.endsWith("/old")).length).toBeGreaterThan(0);
  });

  it("limits clone attempts per IP per hour, whoever is signed in", async () => {
    const ip = "198.51.100.7";
    for (let i = 0; i < 5; i += 1) await new Phone("paid", ip, `ua-${i}`).tryOnce();
    const phone = new Phone("paid", ip, "ua-6");
    const { token } = (await (await phone.consent()).json()) as { token: string };
    const res = await phone.clone(token);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { code: string }).code).toBe("rate");
  });
});

// ── 5. Lines ───────────────────────────────────────────────────────────────

describe("lines", () => {
  it(`speaks ${VOZ_MAX_LINES} lines in the stranger's own voice, then refuses the next without spending`, async () => {
    const phone = new Phone();
    const v = await phone.tryOnce();
    for (let i = VOZ_MAX_LINES - 1; i >= 0; i -= 1) {
      const res = await phone.line(v.voiceId, v.token);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("audio/mpeg");
      expect(res.headers.get("X-Voz-Lines-Left")).toBe(String(i));
      expect(decodeURIComponent(res.headers.get("X-Voz-Translation") ?? "")).toBe("Hello, how are you?");
    }
    expect(ttsCalls().every((u) => u.includes(`/v1/text-to-speech/${v.voiceId}`))).toBe(true);
    fetchSpy.mockClear();
    const third = await phone.line(v.voiceId, v.token);
    expect(third.status).toBe(429);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses an arbitrary voice id, a token for a different voice, and a token from another phone", async () => {
    const phone = new Phone();
    const v = await phone.tryOnce();
    fetchSpy.mockClear();
    expect((await phone.line("liz-voice-id", "")).status).toBe(403);
    expect((await phone.line("liz-voice-id", v.token)).status).toBe(403);
    const other = new Phone();
    await other.consent();
    expect((await other.line(v.voiceId, v.token)).status).toBe(403);
    expect(ttsCalls()).toHaveLength(0);
    expect(chatCalls()).toHaveLength(0);
  });

  it("refuses a voice past its ten minutes", async () => {
    const phone = new Phone();
    const v = await phone.tryOnce();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(v.expiresAt + 1);
      expect((await phone.line(v.voiceId, v.token)).status).toBe(403);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a speech, not a sentence, before calling anybody", async () => {
    const phone = new Phone();
    const v = await phone.tryOnce();
    fetchSpy.mockClear();
    expect((await phone.line(v.voiceId, v.token, "palabra ".repeat(80))).status).toBe(413);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never logs the text or the translation", async () => {
    const phone = new Phone();
    const v = await phone.tryOnce();
    await phone.line(v.voiceId, v.token);
    expect(logs.join("\n")).not.toMatch(/Hola|Hello/);
  });

  it("starts from the phone's language: Spanish phone → English, English phone → Spanish", () => {
    expect(vozTargetFor("es")).toBe("en");
    expect(vozTargetFor("en")).toBe("es");
  });
});

// ── 6. Delete and sweep ────────────────────────────────────────────────────

describe("delete and sweep", () => {
  it("deletes on a beacon carrying the voice token — no session — and refuses without it", async () => {
    const v = await new Phone().tryOnce();
    const post = (body: unknown) =>
      cleanup.POST(new NextRequest("https://taoslite.com/api/voz/cleanup", { method: "POST", body: JSON.stringify(body) }));
    expect((await post({ voiceId: v.voiceId })).status).toBe(403);
    const res = await post({ voiceId: v.voiceId, token: v.token, reason: "unload" });
    expect(res.status).toBe(200);
    expect(calls((u, m) => m === "DELETE" && u.endsWith(`/${v.voiceId}`)).length).toBeGreaterThan(0);
    expect(logs.some((l) => l.includes("event=delete") && l.includes("reason=unload"))).toBe(true);
  });

  it("deletes taos-voz-* voices past ten minutes and strays; keeps fresh ones, /demo's, and everybody else's", async () => {
    const now = Date.now();
    listed = [
      { voice_id: "old", name: "taos-voz-aaaa1111", labels: { taos: "voz", expires: new Date(now - 1_000).toISOString() } },
      { voice_id: "fresh", name: "taos-voz-bbbb2222", labels: { taos: "voz", expires: new Date(now + 300_000).toISOString() } },
      { voice_id: "dated", name: "taos-voz-cccc3333", created_at_unix: Math.floor((now - VOZ_TTL_MS - 60_000) / 1000) },
      { voice_id: "stray", name: "taos-voz-dddd4444" },
      { voice_id: "demo", name: "taos-demo-eeee5555" },
      { voice_id: "liz", name: "lizma2", labels: {} }
    ];
    const result = await sweepVozVoices(now);
    expect(result.deleted.sort()).toEqual(["dated", "old", "stray"]);
    expect(result.kept).toBe(1);
  });

  it("GET /api/demo/sweep sweeps taos-voz-* too", async () => {
    listed = [{ voice_id: "old", name: "taos-voz-aaaa1111", labels: { expires: new Date(Date.now() - 1_000).toISOString() } }];
    const res = await demoSweep.GET(
      new NextRequest("https://taoslite.com/api/demo/sweep", { headers: { authorization: "Bearer tom" } })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { voz: { deleted: string[] } };
    expect(body.voz.deleted).toEqual(["old"]);
  });

  it("logs a share as one line with no text", async () => {
    const v = await new Phone().tryOnce();
    const res = await share.POST(
      new NextRequest("https://taoslite.com/api/voz/share", {
        method: "POST",
        body: JSON.stringify({ voiceId: v.voiceId, token: v.token, outcome: "shared" })
      })
    );
    expect(res.status).toBe(200);
    expect(logs.some((l) => l.startsWith("[taos-voz] event=share") && l.includes("outcome=shared"))).toBe(true);
  });
});
