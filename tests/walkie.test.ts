// Taokie — the push-to-talk translation walkie (founders-only P0 spike,
// 2026-11-01). These pin the decisions the spike was built on:
//
//   1. the gate: flag off → every route 404s; stranger → 404; founder → in
//   2. the turn cap: 30s by default, clamped, and the home ramp scaled to it
//   3. busy-lock: one voice on the channel, as a table
//   4. partner-language targeting: the turn translates INTO targetLanguage,
//      refuses a same-language pair, and the row says so
//   5. retention: 30 days stamped at insert; the sweep removes objects
//      BEFORE rows
//   6. the timing line carries no text, no email, no user agent
//   7. the room alphabet is /call's, and the Spanish strings are marked
//
// OpenAI is a fetch mock routed by URL; /api/tts is mocked at the module;
// nothing reaches the network or a database.
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async (req: Request) => {
    const auth = req.headers.get("authorization") ?? "";
    if (auth === "Bearer tom") return { id: "u-tom", email: "xdrabbit@gmail.com" };
    if (auth === "Bearer liz") return { id: "u-liz", email: "lizmariett@gmail.com" };
    if (auth === "Bearer stranger") return { id: "u-stranger", email: "someone@example.com" };
    return null;
  }
}));

vi.mock("@vercel/functions", () => ({ waitUntil: (p: Promise<unknown>) => p }));

// ── A recording Supabase admin ─────────────────────────────────────────────
// Every call is written down in order; a handler per table decides the
// answer. Order is the point for the sweep: objects first, rows second.
interface Op {
  kind: "table" | "storage";
  name: string;
  method: string;
  args: unknown[];
}
const ops: Op[] = [];
let tableAnswer: (table: string, chain: Op[]) => { data: unknown; error: unknown } = () => ({
  data: null,
  error: null
});

function builder(table: string): unknown {
  const chain: Op[] = [];
  const b: Record<string, unknown> = {};
  const methods = ["insert", "select", "eq", "gt", "gte", "lte", "is", "in", "order", "limit", "update", "delete", "single", "maybeSingle"];
  for (const m of methods) {
    b[m] = (...args: unknown[]) => {
      const op = { kind: "table" as const, name: table, method: m, args };
      ops.push(op);
      chain.push(op);
      return b;
    };
  }
  b.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
    try {
      resolve(tableAnswer(table, chain));
    } catch (e) {
      reject(e);
    }
  };
  return b;
}

const storageAnswer = {
  upload: { error: null as unknown },
  remove: { data: [] as unknown[] | null, error: null as unknown },
  sign: { data: { signedUrl: "https://signed.example/x" } as unknown, error: null as unknown }
};

vi.mock("@/lib/supabaseAdmin", () => ({
  hasServiceRoleKey: true,
  supabaseAdmin: {
    from: (table: string) => builder(table),
    storage: {
      from: (bucket: string) => ({
        upload: async (...args: unknown[]) => {
          ops.push({ kind: "storage", name: bucket, method: "upload", args });
          return storageAnswer.upload;
        },
        remove: async (...args: unknown[]) => {
          ops.push({ kind: "storage", name: bucket, method: "remove", args });
          return storageAnswer.remove;
        },
        createSignedUrl: async (...args: unknown[]) => {
          ops.push({ kind: "storage", name: bucket, method: "createSignedUrl", args });
          return storageAnswer.sign;
        }
      })
    }
  }
}));

const ttsCalls: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = [];
vi.mock("@/app/api/tts/route", () => ({
  POST: async (req: Request) => {
    const body = (await req.json()) as Record<string, unknown>;
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    ttsCalls.push({ body, headers });
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { "Content-Type": "audio/mpeg", "X-TTS-Engine": "elevenlabs" }
    });
  }
}));

const flag = await import("@/lib/walkie/flag");
const state = await import("@/lib/walkie/state");
const timing = await import("@/lib/walkie/timing");
const roomMod = await import("@/lib/walkie/room");
const store = await import("@/lib/walkie/store");
const recorder = await import("@/lib/translate/recorder");
const turn = await import("@/app/api/walkie/turn/route");
const messages = await import("@/app/api/walkie/messages/route");
const ack = await import("@/app/api/walkie/ack/route");
const settings = await import("@/app/api/walkie/settings/route");
const sweep = await import("@/app/api/walkie/sweep/route");

const TRANSCRIPT = "Pero es seguro, ya pagué la cuenta de la casa";
const TRANSLATION = "But it's insurance, I already paid the house bill";

// ── The OpenAI mock ────────────────────────────────────────────────────────
const openai: Array<{ url: string; body: unknown }> = [];
function installFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/v1/audio/transcriptions")) {
        openai.push({ url, body: init?.body });
        return new Response(JSON.stringify({ text: TRANSCRIPT }), { status: 200 });
      }
      if (url.includes("/v1/chat/completions")) {
        const body = JSON.parse(String(init?.body)) as unknown;
        openai.push({ url, body });
        return new Response(JSON.stringify({ choices: [{ message: { content: TRANSLATION } }] }), {
          status: 200
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    })
  );
}

function turnRequest(opts: {
  auth?: string;
  room?: string;
  source?: string;
  target?: string;
  voiceKey?: string;
  recMs?: number;
}): NextRequest {
  const form = new FormData();
  form.append("audio", new File([new Uint8Array(2000)], "audio.webm", { type: "audio/webm" }));
  form.append("room", opts.room ?? "ABCDE");
  form.append("sourceLanguage", opts.source ?? "es");
  form.append("targetLanguage", opts.target ?? "en");
  form.append("engine", "elevenlabs");
  form.append("rec_ms", String(opts.recMs ?? 4200));
  form.append("released_at", String(Date.now()));
  form.append("busy_blocked", "2");
  form.append("cancelled", "0");
  const headers: Record<string, string> = { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" };
  if (opts.auth) headers.authorization = `Bearer ${opts.auth}`;
  if (opts.voiceKey) headers["x-taos-voice-key"] = opts.voiceKey;
  return new NextRequest("https://taos.test/api/walkie/turn", { method: "POST", headers, body: form });
}

function json(path: string, auth: string | undefined, body?: unknown, method = "POST"): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) headers.authorization = `Bearer ${auth}`;
  return new NextRequest(`https://taos.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

const logs: string[] = [];

beforeEach(() => {
  process.env.TAOS_WALKIE_ENABLED = "1";
  process.env.OPENAI_API_KEY = "sk-test";
  delete process.env.TAOS_WALKIE_RETENTION_DAYS;
  delete process.env.TAOS_WALKIE_MAX_TURN_MS;
  delete process.env.CRON_SECRET;
  ops.length = 0;
  openai.length = 0;
  ttsCalls.length = 0;
  logs.length = 0;
  storageAnswer.upload = { error: null };
  storageAnswer.remove = { data: [], error: null };
  installFetch();
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  // The row the turn route inserts comes back as inserted.
  tableAnswer = (table, chain) => {
    const insert = chain.find((c) => c.method === "insert");
    if (table === store.WALKIE_TABLE && insert) {
      const row = insert.args[0] as Record<string, unknown>;
      return { data: { id: "11111111-2222-4333-8444-555555555555", delivered_at: null, played_at: null, ...row }, error: null };
    }
    return { data: null, error: null };
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── 1. The gate ────────────────────────────────────────────────────────────
describe("the gate", () => {
  it("is off unless TAOS_WALKIE_ENABLED is explicitly on", () => {
    delete process.env.TAOS_WALKIE_ENABLED;
    expect(flag.walkieEnabled()).toBe(false); // what production ships
    expect(flag.walkieEnabled("")).toBe(false);
    expect(flag.walkieEnabled("0")).toBe(false);
    expect(flag.walkieEnabled("yes")).toBe(false);
    expect(flag.walkieEnabled("1")).toBe(true);
    expect(flag.walkieEnabled(" TRUE ")).toBe(true);
  });

  it("is founders only, both halves required", () => {
    expect(flag.walkieVisibleTo("xdrabbit@gmail.com", true)).toBe(true);
    expect(flag.walkieVisibleTo("lizmariett@gmail.com", true)).toBe(true);
    expect(flag.walkieVisibleTo("xdrabbit@gmail.com", false)).toBe(false);
    expect(flag.walkieVisibleTo("someone@example.com", true)).toBe(false);
    expect(flag.walkieVisibleTo(null, true)).toBe(false);
  });

  it("tells flag-off from signed-out from not-a-founder on the screen", () => {
    const base = { ready: true, signedIn: true, email: "xdrabbit@gmail.com" };
    expect(flag.walkieGateState({ ...base, enabled: false })).toBe("disabled");
    expect(flag.walkieGateState({ ...base, enabled: true, ready: false })).toBe("loading");
    expect(flag.walkieGateState({ ...base, enabled: true, signedIn: false, email: null })).toBe("sign-in");
    expect(flag.walkieGateState({ ...base, enabled: true, email: "someone@example.com" })).toBe("denied");
    expect(flag.walkieGateState({ ...base, enabled: true })).toBe("open");
  });

  it("every /api/walkie route reads the gate (a new route cannot forget it)", () => {
    const dir = new URL("../app/api/walkie/", import.meta.url);
    const files = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => `${e.name}/route.ts`);
    expect(files).toContain("turn/route.ts");
    for (const file of files) {
      const src = readFileSync(new URL(file, dir), "utf8");
      expect(src, file).toMatch(/guardWalkie|walkieEnabled/);
    }
    // The money route goes through guardSpend (inside guardWalkie), first.
    const guard = readFileSync(new URL("../lib/walkie/guard.ts", import.meta.url), "utf8");
    expect(guard).toContain("guardSpend");
    expect(guard.indexOf("walkieEnabled()")).toBeLessThan(guard.indexOf("guardSpend(req)"));
  });

  it("answers 404 everywhere with the flag off — before any provider is called", async () => {
    process.env.TAOS_WALKIE_ENABLED = "";
    expect((await turn.POST(turnRequest({ auth: "tom" }))).status).toBe(404);
    expect((await messages.GET(json("/api/walkie/messages?room=ABCDE", "tom", undefined, "GET"))).status).toBe(404);
    expect((await ack.POST(json("/api/walkie/ack", "tom", { id: "x", kind: "played" }))).status).toBe(404);
    expect((await settings.GET(json("/api/walkie/settings", "tom", undefined, "GET"))).status).toBe(404);
    expect((await sweep.GET(json("/api/walkie/sweep", "tom", undefined, "GET"))).status).toBe(404);
    expect(openai).toHaveLength(0);
    expect(ttsCalls).toHaveLength(0);
    expect(ops).toHaveLength(0);
  });

  it("turns a bare curl away with 401 and a signed-in stranger with 404", async () => {
    expect((await turn.POST(turnRequest({}))).status).toBe(401);
    expect((await turn.POST(turnRequest({ auth: "stranger" }))).status).toBe(404);
    expect(openai).toHaveLength(0);
    expect(ops).toHaveLength(0);
  });
});

// ── 2. The turn cap ────────────────────────────────────────────────────────
describe("the turn cap", () => {
  it("is 30 seconds by default and bounded either way", () => {
    expect(flag.walkieMaxTurnMs(undefined)).toBe(30_000);
    expect(flag.walkieMaxTurnMs("")).toBe(30_000);
    expect(flag.walkieMaxTurnMs("abc")).toBe(30_000);
    expect(flag.walkieMaxTurnMs("45000")).toBe(45_000);
    expect(flag.walkieMaxTurnMs("1")).toBe(5_000);
    expect(flag.walkieMaxTurnMs("9999999")).toBe(300_000);
  });

  it("scales the home screen's wrap-up ramp to the cap without changing home's", () => {
    // Home: five minutes, T-30s / T-10s exactly as before the extraction.
    expect(recorder.rampWindows(300_000)).toEqual({ early: 30_000, fast: 10_000 });
    // Taokie: 30 seconds — a third and a ninth, so the glow still means "wrap up".
    expect(recorder.rampWindows(30_000)).toEqual({ early: 10_000, fast: 3_333 });
    const w = recorder.rampWindows(30_000);
    expect(recorder.pulsePeriod(9_000, w)).toBe(2400);
    expect(recorder.pulsePeriod(0, w)).toBe(recorder.PULSE_FAST_MS);
    expect(recorder.pulsePeriod(w.fast, w)).toBeCloseTo(recorder.PULSE_SLOW_MS, 5);
    expect(recorder.rampStyle(1_000, 1, w, false).transform).toBe("scale(1.08)");
    expect(recorder.rampStyle(1_000, 1, w, true).transform).toBe("");
  });

  it("the shell arms a hard stop at the cap and treats pointercancel as a send", () => {
    const src = readFileSync(new URL("../components/walkie/WalkieShell.tsx", import.meta.url), "utf8");
    expect(src).toContain('window.setTimeout(() => endTurn("cap"), maxTurnMs)');
    expect(src).toContain("onPointerCancel={onTapCancel}");
    expect(src).toContain('endTurn("cancel")');
    // Tap-to-toggle (Tom, 2026-11-01): pointerdown only. No click, no
    // pointerup, no capture, no long press — nothing for iOS's long-press cue
    // to attach to.
    expect(src).toContain("onPointerDown={onTap}");
    expect(src).not.toMatch(/onClick=\{onTap|onPointerUp=|onLostPointerCapture=|setPointerCapture/);
    for (const rule of ["WebkitTouchCallout", "userSelect", "touchAction"]) expect(src).toContain(rule);
    // The home recorder, not a new mic.
    expect(src).toContain('from "@/lib/translate/recorder"');
    expect(src).toContain("new MediaRecorder(stream, opts)");
    const home = readFileSync(new URL("../components/TranslatorShell.tsx", import.meta.url), "utf8");
    expect(home).toContain('from "@/lib/translate/recorder"');
  });
});

// ── 3. Busy-lock ───────────────────────────────────────────────────────────
describe("busy-lock: one voice on the channel", () => {
  const open = { onAir: true, joined: true, partnerHolding: false, sending: false };
  it("lets a hold start only when nobody else has the channel", () => {
    expect(state.holdRefusal(open)).toBeNull();
    expect(state.canHold(open)).toBe(true);
  });
  it("locks the button while the partner holds", () => {
    expect(state.holdRefusal({ ...open, partnerHolding: true })).toBe("partner-holding");
  });
  it("waits while this phone's own turn is still sending", () => {
    expect(state.holdRefusal({ ...open, sending: true })).toBe("sending");
  });
  it("refuses before 'go on air' and before the channel is joined", () => {
    expect(state.holdRefusal({ ...open, onAir: false })).toBe("not-on-air");
    expect(state.holdRefusal({ ...open, joined: false })).toBe("no-channel");
  });
  it("the shell counts a refused press and plays the busy chirp instead of recording", () => {
    const src = readFileSync(new URL("../components/walkie/WalkieShell.tsx", import.meta.url), "utf8");
    const refused = src.indexOf("if (refusal) {");
    expect(refused).toBeGreaterThan(0);
    const block = src.slice(refused, src.indexOf("void startRecording()", refused));
    expect(block).toContain("busyBlockedRef.current += 1");
    expect(block).toContain("chirpsRef.current?.busy()");
    expect(block).toContain("return;");
  });
});

// ── 4. Partner-language targeting ──────────────────────────────────────────
describe("the turn translates into the PARTNER's language", () => {
  it("transcribes in the sender's language and translates into targetLanguage", async () => {
    const res = await turn.POST(turnRequest({ auth: "liz", source: "es", target: "en", voiceKey: "shh" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: Record<string, unknown> };
    expect(body.message.source_lang).toBe("es");
    expect(body.message.target_lang).toBe("en");
    expect(body.message.original_text).toBe(TRANSCRIPT);
    expect(body.message.translation_text).toBe(TRANSLATION);
    expect(body.message.speech_url).toBe("https://signed.example/x");

    const chat = openai.find((c) => c.url.includes("chat/completions"))?.body as {
      messages: Array<{ role: string; content: string }>;
      temperature: number;
    };
    expect(chat.temperature).toBe(0.2);
    expect(chat.messages[0].content).toContain("Spanish");
    expect(chat.messages[0].content).toContain("English");
    expect(chat.messages[1].content).toBe(TRANSCRIPT);

    // The voice follows the speaker: /api/tts gets the sender's direction
    // and the sender's own personal-voice header, surface "walkie".
    expect(ttsCalls).toHaveLength(1);
    expect(ttsCalls[0].body).toMatchObject({ text: TRANSLATION, sourceLanguage: "es", targetLanguage: "en" });
    expect(ttsCalls[0].headers["x-taos-voice-key"]).toBe("shh");
    expect(ttsCalls[0].headers["x-taos-surface"]).toBe("walkie");
    expect(ttsCalls[0].headers.authorization).toBe("Bearer liz");
  });

  it("refuses a pair where the partner's language is the sender's", async () => {
    const res = await turn.POST(turnRequest({ auth: "tom", source: "en", target: "en" }));
    expect(res.status).toBe(400);
    expect(openai).toHaveLength(0);
  });

  it("refuses a code that could not have come from the generator", async () => {
    const res = await turn.POST(turnRequest({ auth: "tom", room: "hello world" }));
    expect(res.status).toBe(400);
    expect(openai).toHaveLength(0);
  });

  it("counts the turn like a home turn — one row in the sender's history", async () => {
    await turn.POST(turnRequest({ auth: "liz", source: "es", target: "en" }));
    const history = ops.find((o) => o.kind === "table" && o.name === "taos_lite_translations" && o.method === "insert");
    expect(history).toBeDefined();
    expect(history?.args[0]).toMatchObject({
      user_id: "u-liz",
      source_lang: "es",
      target_lang: "en",
      tone: "detailed",
      engine: "walkie",
      original_text: TRANSCRIPT,
      translation_text: TRANSLATION
    });
  });

  it("the shell sends the partner's presence language as the target, else the pair's other side", () => {
    const src = readFileSync(new URL("../components/walkie/WalkieShell.tsx", import.meta.url), "utf8");
    expect(src).toContain("const partnerLang = partnerRef.current?.lang;");
    expect(src).toContain("partnerLang && partnerLang !== source ? partnerLang : theirsRef.current");
    expect(src).toContain('form.append("sourceLanguage", source)');
    expect(src).toContain('form.append("targetLanguage", target)');
  });
});

// ── 5. Retention ───────────────────────────────────────────────────────────
describe("retention: 30 days, then gone", () => {
  it("is 30 days by default and never more than a year", () => {
    expect(flag.walkieRetentionDays(undefined)).toBe(30);
    expect(flag.walkieRetentionDays("0")).toBe(30);
    expect(flag.walkieRetentionDays("7")).toBe(7);
    expect(flag.walkieRetentionDays("9000")).toBe(365);
  });

  it("stamps expires_at exactly retention days after creation", () => {
    const created = Date.UTC(2026, 10, 1, 12, 0, 0);
    expect(flag.walkieExpiresAt(created, 30).toISOString()).toBe("2026-12-01T12:00:00.000Z");
    expect(flag.walkieExpired("2026-12-01T12:00:00.000Z", created + 30 * 86_400_000 - 1)).toBe(false);
    expect(flag.walkieExpired("2026-12-01T12:00:00.000Z", created + 30 * 86_400_000)).toBe(true);
    expect(flag.walkieExpired("not a date", created)).toBe(true);
  });

  it("the turn route stamps the row with the 30-day clock", async () => {
    const before = Date.now();
    await turn.POST(turnRequest({ auth: "tom", source: "en", target: "es" }));
    const insert = ops.find((o) => o.kind === "table" && o.name === store.WALKIE_TABLE && o.method === "insert");
    const row = insert?.args[0] as { created_at: string; expires_at: string; timings: Record<string, unknown>; room: string };
    expect(row).toBeDefined();
    expect(Date.parse(row.expires_at) - Date.parse(row.created_at)).toBe(30 * 86_400_000);
    expect(Date.parse(row.created_at)).toBeGreaterThanOrEqual(before);
    expect(row.room).toBe("ABCDE");
    // Numbers only on the row's timings.
    for (const v of Object.values(row.timings)) expect(typeof v).toBe("number");
  });

  it("the sweep removes the audio objects BEFORE it deletes the rows", async () => {
    tableAnswer = (table, chain) => {
      if (table === store.WALKIE_TABLE && chain.some((c) => c.method === "lte")) {
        return {
          data: [
            { id: "a", audio_path: "R/a.rec.webm", speech_path: "R/a.say.mp3" },
            { id: "b", audio_path: "R/b.rec.webm", speech_path: null }
          ],
          error: null
        };
      }
      return { data: null, error: null };
    };
    storageAnswer.remove = { data: [{}, {}, {}], error: null };
    const result = await store.sweepWalkieMessages(Date.UTC(2027, 0, 1));
    expect(result).toEqual({ scanned: 2, objectsRemoved: 3, rowsDeleted: 2, error: null });
    const removeAt = ops.findIndex((o) => o.kind === "storage" && o.method === "remove");
    const deleteAt = ops.findIndex((o) => o.kind === "table" && o.method === "delete");
    expect(removeAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(removeAt);
    expect(ops[removeAt].args[0]).toEqual(["R/a.rec.webm", "R/a.say.mp3", "R/b.rec.webm"]);
  });

  it("keeps the rows when storage refuses — an orphan is worse than a late delete", async () => {
    tableAnswer = (table, chain) =>
      table === store.WALKIE_TABLE && chain.some((c) => c.method === "lte")
        ? { data: [{ id: "a", audio_path: "R/a.rec.webm", speech_path: null }], error: null }
        : { data: null, error: null };
    storageAnswer.remove = { data: null, error: { message: "boom" } };
    const result = await store.sweepWalkieMessages();
    expect(result.error).toBe("storage_remove_failed");
    expect(result.rowsDeleted).toBe(0);
    expect(ops.some((o) => o.kind === "table" && o.method === "delete")).toBe(false);
  });

  it("the sweep route takes the cron secret, or a founder session, and nothing else", async () => {
    process.env.CRON_SECRET = "s3cret";
    expect((await sweep.GET(json("/api/walkie/sweep", undefined, undefined, "GET"))).status).toBe(401);
    expect((await sweep.GET(json("/api/walkie/sweep", "stranger", undefined, "GET"))).status).toBe(404);
    expect((await sweep.GET(json("/api/walkie/sweep", "s3cret", undefined, "GET"))).status).toBe(200);
    expect((await sweep.GET(json("/api/walkie/sweep", "tom", undefined, "GET"))).status).toBe(200);
    // Vercel Cron is wired to it.
    const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as {
      crons: Array<{ path: string }>;
    };
    expect(vercel.crons.map((c) => c.path)).toContain("/api/walkie/sweep");
  });

  it("the migration enables RLS with no policies and stamps the bucket private", () => {
    const sql = readFileSync(new URL("../supabase/migrations/20261101_walkie_messages.sql", import.meta.url), "utf8");
    expect(sql).toContain("enable row level security");
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).toMatch(/'walkie-audio', 'walkie-audio', false/);
    expect(sql).toContain("walkie_notify_text boolean not null default true");
  });
});

// ── 6. The timing line carries no text ─────────────────────────────────────
describe("[taos-walkie-timing]", () => {
  it("has every field the spike asked for", () => {
    const line = timing.formatWalkieTiming({
      status: "ok",
      http: 200,
      recMs: 4200,
      uploadMs: 310,
      transcribeMs: 1800,
      translateMs: 900,
      ttsMs: 1200,
      deliverMs: "?",
      releaseToPlayMs: "?",
      busyBlocked: 2,
      cancelled: 0,
      failStage: "?",
      src: "es",
      tgt: "en",
      audioBytes: 2000,
      srcChars: 44,
      outChars: 48,
      totalMs: 4500,
      err: "?"
    });
    for (const key of [
      "rec_ms=4200",
      "upload_ms=310",
      "transcribe_ms=1800",
      "translate_ms=900",
      "tts_ms=1200",
      "deliver_ms=?",
      "release_to_play_ms=?",
      "busy_blocked=2",
      "cancelled=0",
      "fail_stage=?"
    ]) {
      expect(line).toContain(key);
    }
    expect(line.startsWith("[taos-walkie-timing] ")).toBe(true);
  });

  it("cannot carry a sentence, an address or a user agent even if handed one", () => {
    const line = timing.formatWalkieTiming({
      status: "error",
      http: 502,
      recMs: 1,
      uploadMs: 1,
      transcribeMs: 1,
      translateMs: 1,
      ttsMs: 1,
      deliverMs: 1,
      releaseToPlayMs: 1,
      busyBlocked: 0,
      cancelled: 1,
      failStage: "?",
      src: "xdrabbit@gmail.com",
      tgt: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
      audioBytes: 1,
      srcChars: 1,
      outChars: 1,
      totalMs: 1,
      err: "Pero es seguro, ya pagué la cuenta"
    });
    expect(line).not.toContain("@");
    expect(line).not.toContain(" (iPhone");
    expect(line).not.toContain("Pero es seguro");
    expect(line).not.toMatch(/\s[^\s=]+\s[^\s=]+\s/); // no free text: every token is key=value
    for (const token of line.split(" ").slice(1)) expect(token).toMatch(/^[a-z_]+=[0-9A-Za-z_.:?-]*$/);
  });

  it("the turn route logs one line with no transcript, email or user agent in it", async () => {
    await turn.POST(turnRequest({ auth: "liz", source: "es", target: "en" }));
    const lines = logs.filter((l) => l.startsWith("[taos-walkie-timing]"));
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line).toContain("status=ok");
    expect(line).toContain("rec_ms=4200");
    expect(line).toContain("busy_blocked=2");
    expect(line).toContain("cancelled=0");
    expect(line).toContain("src=es tgt=en");
    expect(line).toMatch(/transcribe_ms=\d+/);
    expect(line).toMatch(/translate_ms=\d+/);
    expect(line).toMatch(/tts_ms=\d+/);
    expect(line).toContain("deliver_ms=? release_to_play_ms=?");
    expect(line).not.toContain("Pero");
    expect(line).not.toContain("insurance");
    expect(line).not.toContain("gmail");
    expect(line).not.toContain("iPhone");
  });

  it("the played ack finishes the line from the row's numbers and the partner's two", async () => {
    tableAnswer = (table, chain) =>
      table === store.WALKIE_TABLE && chain.some((c) => c.method === "update")
        ? {
            data: {
              id: "11111111-2222-4333-8444-555555555555",
              source_lang: "es",
              target_lang: "en",
              original_text: TRANSCRIPT,
              translation_text: TRANSLATION,
              timings: { rec_ms: 4200, upload_ms: 300, transcribe_ms: 1800, translate_ms: 900, tts_ms: 1200, busy_blocked: 2, cancelled: 0 }
            },
            error: null
          }
        : { data: null, error: null };
    const res = await ack.POST(
      json("/api/walkie/ack", "tom", {
        id: "11111111-2222-4333-8444-555555555555",
        kind: "played",
        deliver_ms: 640,
        release_to_play_ms: 5100
      })
    );
    expect(res.status).toBe(200);
    const line = logs.find((l) => l.startsWith("[taos-walkie-timing]"));
    expect(line).toBeDefined();
    expect(line).toContain("deliver_ms=640");
    expect(line).toContain("release_to_play_ms=5100");
    expect(line).toContain("rec_ms=4200");
    expect(line).toContain("tts_ms=1200");
    expect(line).not.toContain("Pero");
    expect(line).not.toContain("insurance");
  });

  it("a second played ack of the same message logs nothing", async () => {
    tableAnswer = () => ({ data: null, error: null }); // the update matched no row: already stamped
    const res = await ack.POST(json("/api/walkie/ack", "tom", { id: "11111111-2222-4333-8444-555555555555", kind: "played" }));
    expect(res.status).toBe(200);
    expect(logs.filter((l) => l.startsWith("[taos-walkie-timing]"))).toHaveLength(0);
  });
});

// ── 7. Names, alphabets, and the Spanish placeholders ──────────────────────
describe("the channel is a /call room", () => {
  it("uses /call's room alphabet, letter for letter", () => {
    const call = readFileSync(new URL("../lib/call/session.ts", import.meta.url), "utf8");
    const m = call.match(/const CODE_ALPHABET = "([^"]+)"/);
    expect(m?.[1]).toBe(roomMod.ROOM_ALPHABET);
    expect(roomMod.normalizeWalkieRoom(" ab-cd ")).toBe("AB-CD");
    expect(roomMod.isWalkieRoom("ABCDE")).toBe(true);
    expect(roomMod.isWalkieRoom("ABCDE1")).toBe(false); // 1 is not in the alphabet
    expect(roomMod.isWalkieRoom("")).toBe(false);
  });

  it("the channel module reuses Supabase Realtime and nothing from gpt-realtime", () => {
    // Comments discuss what is NOT used; strip them so a mention is not a match.
    const strip = (text: string) =>
      text.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    const src = strip(readFileSync(new URL("../lib/walkie/channel.ts", import.meta.url), "utf8"));
    expect(src).toContain('from "@/lib/supabase"');
    expect(src).toContain("supabase.channel(topic");
    expect(src).toContain('channel.on("presence"');
    expect(src).not.toMatch(/realtime\/session|gpt-realtime|RTCPeerConnection|openai/i);
    const shell = strip(readFileSync(new URL("../components/walkie/WalkieShell.tsx", import.meta.url), "utf8"));
    expect(shell).not.toMatch(/lib\/realtime|lib\/call\/interpreter|gpt-realtime/);
  });

  it("marks every Spanish Taokie string as pending Liz's review", () => {
    const src = readFileSync(new URL("../lib/chrome/copy.ts", import.meta.url), "utf8");
    const esStart = src.indexOf("  es: {");
    const esEnd = src.indexOf("\n  },", esStart);
    const es = src.slice(esStart, esEnd).split("\n").filter((l) => /^\s+walkie[A-Za-z]+:/.test(l));
    expect(es.length).toBeGreaterThan(20);
    for (const line of es) expect(line, line).toContain("pendiente de revisión por Liz");
    // And the English table declares each of them (the type comes from it).
    const enKeys = (src.match(/^  walkie[A-Za-z]+:/gm) ?? []).map((k) => k.trim().replace(":", ""));
    for (const line of es) {
      const key = line.trim().split(":")[0];
      expect(enKeys, key).toContain(key);
    }
  });

  it("the settings route stores the notification-text preference with the user, default on", async () => {
    tableAnswer = (table) => (table === "profiles" ? { data: { walkie_notify_text: true }, error: null } : { data: null, error: null });
    const read = await settings.GET(json("/api/walkie/settings", "tom", undefined, "GET"));
    expect(await read.json()).toEqual({ notifyText: true });
    const write = await settings.POST(json("/api/walkie/settings", "tom", { notifyText: false }));
    expect(write.status).toBe(200);
    const update = ops.find((o) => o.kind === "table" && o.name === "profiles" && o.method === "update");
    expect(update?.args[0]).toEqual({ walkie_notify_text: false });
    expect((await settings.POST(json("/api/walkie/settings", "tom", { notifyText: "yes" }))).status).toBe(400);
  });
});

// ── 8. After the first two-phone test (2026-11-01) ─────────────────────────
// Tom on an iPhone 17 and a Galaxy S23: the Android "missed the release"
// (a tap shorter than the mic's warm-up was ignored, the recording ran until
// the next tap), the phones drifted apart with no error, and 13 of 22 turns
// reached the server but never the other phone. These pin the answers.
const toggle = await import("@/lib/walkie/toggle");

describe("tap to talk, tap to send: the button is a state machine", () => {
  const walk = (events: Array<import("@/lib/walkie/toggle").ToggleEvent>) => {
    let state: import("@/lib/walkie/toggle").ToggleState = "idle";
    const effects: unknown[] = [];
    for (const ev of events) {
      const step = toggle.toggleStep(state, ev);
      state = step.state;
      effects.push(step.effect);
    }
    return { state, effects };
  };

  it("tap starts, tap sends", () => {
    expect(walk(["tap", "armed", "tap", "stopped"])).toEqual({
      state: "idle",
      effects: ["start", null, "stop", null]
    });
  });

  it("the cap sends by itself", () => {
    expect(walk(["tap", "armed", "cap"])).toEqual({ state: "stopping", effects: ["start", null, "stop"] });
  });

  it("pointercancel mid-turn sends what was heard, marked cancelled", () => {
    expect(walk(["tap", "armed", "cancel"])).toEqual({ state: "stopping", effects: ["start", null, "stop_cancelled"] });
  });

  it("a release before the mic opens changes nothing: the turn runs and the NEXT tap ends it (the Android race)", () => {
    // tap, finger lifts (no event here — up is not an event), a stray cancel
    // and a second tap all land while the mic is still opening…
    const r = walk(["tap", "cancel", "tap", "armed"]);
    expect(r.state).toBe("recording");
    expect(r.effects).toEqual(["start", null, null, null]);
    // …and the tap after that sends.
    expect(toggle.toggleStep("recording", "tap")).toEqual({ state: "stopping", effect: "stop" });
  });

  it("a stop is stopped once: a late cancel cannot re-stamp a sent turn (the cancelled=1 artefact)", () => {
    const r = walk(["tap", "armed", "tap", "cancel", "cap", "tap"]);
    expect(r.state).toBe("stopping");
    expect(r.effects).toEqual(["start", null, "stop", null, null, null]);
  });

  it("a refused mic goes back to idle", () => {
    expect(walk(["tap", "arm_failed"])).toEqual({ state: "idle", effects: ["start", null] });
  });

  it("wears the right words", () => {
    expect(toggle.toggleLabelKey("idle")).toBe("walkieHold");
    expect(toggle.toggleLabelKey("arming")).toBe("walkieStarting");
    expect(toggle.toggleLabelKey("recording")).toBe("walkieHolding");
    expect(toggle.toggleLabelKey("stopping")).toBe("walkieSending");
    const src = readFileSync(new URL("../lib/chrome/copy.ts", import.meta.url), "utf8");
    expect(src).toContain('walkieHold: "TAP TO TALK"');
    expect(src).toContain('walkieHolding: "TAP TO SEND"');
    expect(src).not.toMatch(/HOLD TO TALK|MANTÉN PARA HABLAR/);
  });
});

describe("a busy lock that cannot stick", () => {
  it("heartbeat 4 s, stale 10 s, grace 5 s", () => {
    expect(state.HOLD_HEARTBEAT_MS).toBe(4_000);
    expect(state.HOLD_STALE_MS).toBe(10_000);
    expect(state.HOLD_GRACE_MS).toBe(5_000);
    expect(state.DELIVERY_WAIT_MS).toBe(8_000);
    expect(state.CATCH_UP_EVERY_MS).toBe(5_000);
  });

  it("a hold with fresh beats is believed; one whose beats stopped is released after 10 s", () => {
    const clock = { since: 0, seenAt: 8_000 };
    expect(state.holdingExpired(clock, 12_000, 30_000)).toBe(false);
    expect(state.holdingExpired(clock, 18_000, 30_000)).toBe(false); // 10 s since the beat: still inside
    expect(state.holdingExpired(clock, 18_001, 30_000)).toBe(true);
  });

  it("never outlives the cap plus grace, beats or no beats", () => {
    const clock = { since: 0, seenAt: 34_000 };
    expect(state.holdingExpired(clock, 35_000, 30_000)).toBe(false);
    expect(state.holdingExpired(clock, 35_001, 30_000)).toBe(true);
    // A longer cap moves the ceiling with it.
    expect(state.holdingExpired(clock, 35_001, 60_000)).toBe(false);
  });

  it("the channel beats while holding, lets the partner's hold expire, and reports a lost socket", () => {
    const src = readFileSync(new URL("../lib/walkie/channel.ts", import.meta.url), "utf8");
    // The beat is a BROADCAST, not a presence re-track (2026-11-02: Supabase
    // shuts a client's channel down at the sixth presence update in 30 s,
    // and a 4 s re-track reached six on every hold past ~16 s).
    expect(src).toContain("heartbeat = setInterval(beat, HOLD_HEARTBEAT_MS)");
    expect(src).toContain('send("hold", { holding: mine.holding, beat: Date.now() })');
    expect(src).not.toContain("setInterval(track");
    expect(src).toMatch(/channel\.track\(\{ lang: mine\.lang, name: mine\.name, joined_at/);
    expect(src).not.toMatch(/channel\.track\(\{[^}]*holding/);
    expect(src).toContain("beat: Date.now()");
    expect(src).toContain("holdingExpired(holdClock, now, config.maxTurnMs)");
    expect(src).toContain("events.onHoldExpired?.()");
    expect(src).toContain('status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED"');
    expect(src).toContain('events.onStatus?.("lost")');
    expect(src).toContain("resync: () =>");
    // A rejoin re-announces this phone: presence is not re-sent for us.
    expect(src).toMatch(/if \(status === "SUBSCRIBED"\) \{[\s\S]*?track\(\);/);
  });

  it("presence is rationed one under Supabase's 5-per-30-s limit, and a burst waits for the window", () => {
    expect(state.PRESENCE_MAX_PER_WINDOW).toBe(4);
    expect(state.PRESENCE_WINDOW_MS).toBe(30_000);
    expect(state.presenceWaitMs([], 100_000)).toBe(0);
    expect(state.presenceWaitMs([80_000, 85_000, 90_000], 100_000)).toBe(0); // the fourth may go
    expect(state.presenceWaitMs([80_000, 85_000, 90_000, 95_000], 100_000)).toBe(10_000); // until 80 s leaves the window
    expect(state.presenceWaitMs([60_000, 85_000, 90_000, 95_000], 100_000)).toBe(0); // 60 s is already out
    expect(state.presenceWaitMs([80_000, 85_000, 90_000, 95_000, 99_000], 100_000)).toBe(15_000);
    // The sender re-sends "ready" twice inside the delivery window, then asks the server.
    expect(state.READY_RETRY_AT_MS).toEqual([2_500, 5_000]);
    expect(Math.max(...state.READY_RETRY_AT_MS)).toBeLessThan(state.DELIVERY_WAIT_MS);
    expect(state.RECEIPT_REFRESH_WINDOW_MS).toBe(120_000);
  });

  it("the shell offers Resync, polls for missed turns, catches up on return, and stays awake on air", () => {
    const src = readFileSync(new URL("../components/walkie/WalkieShell.tsx", import.meta.url), "utf8");
    expect(src).toContain("data-walkie-resync=");
    expect(src).toContain("window.setInterval(tick, CATCH_UP_EVERY_MS)");
    expect(src).toContain('document.addEventListener("visibilitychange", onVisible)');
    expect(src).toContain('keepWake("walkie-on-air")');
    expect(src).toContain("&after=");
  });
});

describe("errors that show: fail_stage on the line, a banner on the phone", () => {
  it("the line carries fail_stage and only the seven known stages", () => {
    expect(timing.WALKIE_FAIL_STAGES).toEqual(["upload", "transcribe", "translate", "tts", "store", "deliver", "playback"]);
    expect(timing.isWalkieFailStage("deliver")).toBe(true);
    expect(timing.isWalkieFailStage("Pero es seguro")).toBe(false);
    expect(timing.WALKIE_CLIENT_FAIL_STAGES).toEqual(["deliver", "playback"]);
  });

  async function failedTurnLine(): Promise<string> {
    await turn.POST(turnRequest({ auth: "liz" }));
    const line = logs.find((l) => l.startsWith("[taos-walkie-timing]"));
    expect(line).toBeDefined();
    return line!;
  }

  it("transcribe", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("/v1/audio/transcriptions")) return new Response("boom", { status: 500 });
        throw new Error(`unexpected fetch ${url}`);
      })
    );
    const line = await failedTurnLine();
    expect(line).toContain("status=error");
    expect(line).toContain("fail_stage=transcribe");
  });

  it("translate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("/v1/audio/transcriptions")) return new Response(JSON.stringify({ text: TRANSCRIPT }), { status: 200 });
        if (url.includes("/v1/chat/completions")) return new Response("boom", { status: 502 });
        throw new Error(`unexpected fetch ${url}`);
      })
    );
    const line = await failedTurnLine();
    expect(line).toContain("status=error");
    expect(line).toContain("fail_stage=translate");
  });

  it("store", async () => {
    storageAnswer.upload = { error: { message: "bucket says no" } };
    const line = await failedTurnLine();
    expect(line).toContain("status=error");
    expect(line).toContain("fail_stage=store");
    expect(line).not.toContain("bucket says no");
  });

  it("tts is the one non-fatal stage: the text goes through, the line says fail_stage=tts, the phone is told", async () => {
    const mod = await import("@/app/api/tts/route");
    const spy = vi.spyOn(mod, "POST").mockImplementation(async () => NextResponse.json({ error: "quota" }, { status: 503 }));
    try {
      const res = await turn.POST(turnRequest({ auth: "liz" }));
      expect(res.status).toBe(200);
      const payload = (await res.json()) as { tts_failed?: boolean; message?: { speech_url: string | null } };
      expect(payload.tts_failed).toBe(true);
      expect(payload.message?.speech_url).toBeNull();
      const line = logs.find((l) => l.startsWith("[taos-walkie-timing]"))!;
      expect(line).toContain("status=ok");
      expect(line).toContain("fail_stage=tts");
    } finally {
      spy.mockRestore();
    }
  });

  it("deliver and playback are reported by the phones through the ack route, from the row's numbers, text-free", async () => {
    tableAnswer = (table, chain) =>
      table === store.WALKIE_TABLE && chain.some((c) => c.method === "maybeSingle")
        ? {
            data: {
              id: "11111111-2222-4333-8444-555555555555",
              source_lang: "es",
              target_lang: "en",
              original_text: TRANSCRIPT,
              translation_text: TRANSLATION,
              expires_at: new Date(Date.now() + 86_400_000).toISOString(),
              timings: { rec_ms: 4200, upload_ms: 300, transcribe_ms: 1800, translate_ms: 900, tts_ms: 1200, busy_blocked: 0, cancelled: 0 }
            },
            error: null
          }
        : { data: null, error: null };
    for (const stage of ["deliver", "playback"]) {
      logs.length = 0;
      ops.length = 0;
      const res = await ack.POST(json("/api/walkie/ack", "tom", { id: "11111111-2222-4333-8444-555555555555", kind: "failed", stage }));
      expect(res.status).toBe(200);
      const line = logs.find((l) => l.startsWith("[taos-walkie-timing]"));
      expect(line).toBeDefined();
      expect(line).toContain("status=error");
      expect(line).toContain(`fail_stage=${stage}`);
      expect(line).toContain(`err=${stage}_failed`);
      expect(line).toContain("rec_ms=4200");
      expect(line).not.toContain("Pero");
      expect(line).not.toContain("insurance");
      // Nothing stamped: a late delivery still counts.
      expect(ops.some((o) => o.kind === "table" && o.method === "update")).toBe(false);
    }
    // A phone may not claim a server stage, and never free text.
    for (const stage of ["transcribe", "Pero es seguro", 7]) {
      const res = await ack.POST(json("/api/walkie/ack", "tom", { id: "11111111-2222-4333-8444-555555555555", kind: "failed", stage }));
      expect(res.status, String(stage)).toBe(400);
    }
  });

  it("the shell shows a banner for every stage and never swallows one", () => {
    const src = readFileSync(new URL("../components/walkie/WalkieShell.tsx", import.meta.url), "utf8");
    // upload / transcribe / translate / store: the route's error reaches the banner
    expect(src).toContain("throw new Error(payload.details || payload.error || s.walkieFailed)");
    // tts: the non-fatal one
    expect(src).toContain("if (payload.tts_failed) setError(s.walkieVoiceFailed)");
    // deliver: nobody picked it up inside the window
    expect(src).toContain("setError(s.walkieNotDelivered)");
    expect(src).toContain('postAck(sent.id, "failed", { stage: "deliver" })');
    // playback: the speaker refused — and "go on air" is offered again
    expect(src).toContain("setError(s.walkiePlaybackFailed)");
    expect(src).toContain('postAck(m.id, "failed", { stage: "playback" })');
    expect(src).toContain("data-walkie-unlock=");
    // a lost socket
    expect(src).toContain("setError(s.walkieChannelLost)");
    // and a refused playback is no longer reported as played
    expect(src).toMatch(/if \(outcome === "failed"\) \{[\s\S]*?continue;/);
  });

  it("the receipts lookup returns stamps only — no text, no audio — for at most ten ids", async () => {
    tableAnswer = () => ({
      data: [{ id: "11111111-2222-4333-8444-555555555555", delivered_at: "2026-11-02T23:53:35.751Z", played_at: null }],
      error: null
    });
    const res = await messages.GET(
      json("/api/walkie/messages?ids=11111111-2222-4333-8444-555555555555,22222222-2222-4333-8444-555555555555", "tom", undefined, "GET")
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { receipts: Array<Record<string, unknown>> };
    expect(body.receipts).toEqual([{ id: "11111111-2222-4333-8444-555555555555", delivered_at: "2026-11-02T23:53:35.751Z", played_at: null }]);
    const select = ops.find((o) => o.kind === "table" && o.method === "select");
    expect(select?.args[0]).toBe("id, delivered_at, played_at");
    expect(ops.some((o) => o.kind === "storage")).toBe(false);
    expect(ops.some((o) => o.method === "delete")).toBe(false);
    for (const bad of ["", "not-a-uuid", Array.from({ length: 11 }, () => "11111111-2222-4333-8444-555555555555").join(",")]) {
      expect((await messages.GET(json(`/api/walkie/messages?ids=${bad}`, "tom", undefined, "GET"))).status, bad.slice(0, 20)).toBe(400);
    }
    expect((await messages.GET(json("/api/walkie/messages?ids=11111111-2222-4333-8444-555555555555", "stranger", undefined, "GET"))).status).toBe(404);
  });

  it("the catch-up poll asks only for rows after the last one, and does not kick the sweep", async () => {
    tableAnswer = () => ({ data: [], error: null });
    const res = await messages.GET(json("/api/walkie/messages?room=ABCDE&after=2026-11-02T02:30:00.000Z", "tom", undefined, "GET"));
    expect(res.status).toBe(200);
    const gts = ops.filter((o) => o.kind === "table" && o.method === "gt").map((o) => o.args[0]);
    expect(gts).toContain("created_at");
    expect(ops.some((o) => o.method === "delete")).toBe(false);
    ops.length = 0;
    await messages.GET(json("/api/walkie/messages?room=ABCDE&after=not-a-date", "tom", undefined, "GET"));
    expect(ops.filter((o) => o.kind === "table" && o.method === "gt").map((o) => o.args[0])).not.toContain("created_at");
  });
});
