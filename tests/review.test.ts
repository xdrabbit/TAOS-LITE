// Founder translation review (Tom, 2026-11-04): keep the audio for a while,
// review turns with audio + transcript + translation side by side, flag the
// bad ones. These pin the decisions it was built on:
//
//   1. the opt-in gates storage: a turn is kept only when the SPEAKER's own
//      profiles.review_keep_audio is on; nobody else's setting is read, and
//      a non-founder's profile is never consulted at all
//   2. retention: 14 days stamped at insert; the sweep removes objects
//      BEFORE rows, and the existing walkie cron runs it
//   3. every /api/review route: 401 bare, 404 for a signed-in stranger
//   4. the flag: four reasons, one line of note, stored on the turn
//   5. the export is the transcriber probe's clip-set format, round-tripped
//      through the probe's own reader
//   6. nothing in a log line but counts and codes
//
// OpenAI is a fetch mock routed by URL; /api/tts is mocked at the module;
// nothing reaches the network or a database.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The two founders, by the addresses lib/release.ts hardcodes.
const TOM = "aaaaaaaa-0000-4000-8000-00000000000a";
const LIZ = "bbbbbbbb-0000-4000-8000-00000000000b";
const STRANGER = "cccccccc-0000-4000-8000-00000000000c";
const TOM_EMAIL = ["xdrabbit", "gmail.com"].join("@");
const LIZ_EMAIL = ["lizmariett", "gmail.com"].join("@");

vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async (req: Request) => {
    const auth = req.headers.get("authorization") ?? "";
    if (auth === "Bearer tom") return { id: "aaaaaaaa-0000-4000-8000-00000000000a", email: ["xdrabbit", "gmail.com"].join("@") };
    if (auth === "Bearer liz") return { id: "bbbbbbbb-0000-4000-8000-00000000000b", email: ["lizmariett", "gmail.com"].join("@") };
    if (auth === "Bearer stranger") return { id: "cccccccc-0000-4000-8000-00000000000c", email: "someone@example.com" };
    return null;
  }
}));

// waitUntil runs the review copy OFF the response: the phone has its answer
// before the object and the row exist. The mock keeps those promises so a
// test can wait for them the way Vercel does after the response is sent.
const pending = vi.hoisted(() => [] as Promise<unknown>[]);
vi.mock("@vercel/functions", () => ({
  waitUntil: (p: Promise<unknown>) => {
    pending.push(p);
  }
}));
async function settled(): Promise<void> {
  while (pending.length) await pending.shift();
}

// ── A recording Supabase admin ─────────────────────────────────────────────
interface Op {
  kind: "table" | "storage";
  name: string;
  method: string;
  args: unknown[];
}
const ops: Op[] = [];
let tableAnswer: (table: string, chain: Op[]) => { data: unknown; error: unknown } = () => ({ data: null, error: null });
/** profiles.review_keep_audio per user id, as the database would hold it. */
const keep: Record<string, boolean> = {};

function builder(table: string): unknown {
  const chain: Op[] = [];
  const b: Record<string, unknown> = {};
  const methods = ["insert", "select", "eq", "gt", "gte", "lt", "lte", "is", "in", "not", "order", "limit", "update", "delete", "single", "maybeSingle"];
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
  sign: { data: { signedUrl: "https://signed.example/x" } as unknown, error: null as unknown },
  download: new Map<string, Uint8Array>()
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
        },
        download: async (path: string) => {
          ops.push({ kind: "storage", name: bucket, method: "download", args: [path] });
          const bytes = storageAnswer.download.get(path);
          return bytes ? { data: new Blob([bytes.buffer as ArrayBuffer]), error: null } : { data: null, error: { message: "missing" } };
        }
      })
    }
  }
}));

vi.mock("@/app/api/tts/route", () => ({
  POST: async () =>
    new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "Content-Type": "audio/mpeg", "X-TTS-Engine": "elevenlabs" } })
}));

const flag = await import("@/lib/review/flag");
const store = await import("@/lib/review/store");
const capture = await import("@/lib/review/capture");
const tar = await import("@/lib/review/tar");
const clipSet = await import("@/lib/review/clipSet");
const clipDir = await import("@/lib/review/clipDir");
const shell = await import("@/components/review/ReviewShell");
const translate = await import("@/app/api/translate/route");
const walkieTurn = await import("@/app/api/walkie/turn/route");
const walkieSweep = await import("@/app/api/walkie/sweep/route");
const settings = await import("@/app/api/review/settings/route");
const turns = await import("@/app/api/review/turns/route");
const flagRoute = await import("@/app/api/review/flag/route");
const exportRoute = await import("@/app/api/review/export/route");
const sweepRoute = await import("@/app/api/review/sweep/route");

const TRANSCRIPT = "Pero es seguro, ya pagué la cuenta de la casa";
const TRANSLATION = "But it's insurance, I already paid the house bill";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)";

const openai: Array<{ url: string }> = [];
let autoReply: string | null = null;
function installFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/v1/audio/transcriptions")) {
        openai.push({ url });
        return new Response(JSON.stringify({ text: TRANSCRIPT }), { status: 200 });
      }
      if (url.includes("/v1/chat/completions")) {
        openai.push({ url });
        const body = JSON.parse(String(init?.body)) as { response_format?: unknown };
        const content = body.response_format && autoReply ? autoReply : TRANSLATION;
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    })
  );
}

function homeRequest(opts: { auth?: string; source?: string; target?: string; pair?: [string, string] }): NextRequest {
  const form = new FormData();
  form.append("audio", new File([new Uint8Array(3000)], "audio.webm", { type: "audio/webm" }));
  form.append("sourceLanguage", opts.source ?? "es");
  form.append("targetLanguage", opts.target ?? "en");
  form.append("tone", "detailed");
  if (opts.pair) {
    form.append("pairA", opts.pair[0]);
    form.append("pairB", opts.pair[1]);
  }
  const headers: Record<string, string> = { "user-agent": UA };
  if (opts.auth) headers.authorization = `Bearer ${opts.auth}`;
  return new NextRequest("https://taos.test/api/translate", { method: "POST", headers, body: form });
}

function walkieRequest(auth: string): NextRequest {
  const form = new FormData();
  form.append("audio", new File([new Uint8Array(2000)], "audio.webm", { type: "audio/webm" }));
  form.append("room", "ABCDE");
  form.append("sourceLanguage", "es");
  form.append("targetLanguage", "en");
  form.append("engine", "elevenlabs");
  form.append("rec_ms", "4200");
  return new NextRequest("https://taos.test/api/walkie/turn", {
    method: "POST",
    headers: { authorization: `Bearer ${auth}`, "user-agent": UA },
    body: form
  });
}

function json(path: string, auth: string | undefined, body?: unknown, method = "POST"): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": UA };
  if (auth) headers.authorization = `Bearer ${auth}`;
  return new NextRequest(`https://taos.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const logs: string[] = [];
const reviewInserts = () => ops.filter((o) => o.kind === "table" && o.name === store.REVIEW_TABLE && o.method === "insert");
const reviewUploads = () => ops.filter((o) => o.kind === "storage" && o.name === store.REVIEW_BUCKET && o.method === "upload");
const profileReads = () =>
  ops.filter((o) => o.kind === "table" && o.name === "profiles" && o.method === "eq").map((o) => o.args[1]);

beforeEach(() => {
  process.env.TAOS_WALKIE_ENABLED = "1";
  process.env.OPENAI_API_KEY = "sk-test";
  delete process.env.TAOS_REVIEW_RETENTION_DAYS;
  delete process.env.CRON_SECRET;
  ops.length = 0;
  openai.length = 0;
  logs.length = 0;
  pending.length = 0;
  autoReply = null;
  for (const k of Object.keys(keep)) delete keep[k];
  storageAnswer.upload = { error: null };
  storageAnswer.remove = { data: [], error: null };
  storageAnswer.download.clear();
  installFetch();
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  tableAnswer = (table, chain) => {
    const insert = chain.find((c) => c.method === "insert");
    if (insert && (table === store.REVIEW_TABLE || table === "taos_lite_walkie_messages")) {
      const row = insert.args[0] as Record<string, unknown>;
      return { data: { id: "11111111-2222-4333-8444-555555555555", ...row }, error: null };
    }
    if (table === "profiles") {
      const eq = chain.find((c) => c.method === "eq");
      const id = eq ? String(eq.args[1]) : "";
      if (chain.some((c) => c.method === "in")) {
        return { data: [{ id: TOM, email: TOM_EMAIL }, { id: LIZ, email: LIZ_EMAIL }], error: null };
      }
      return { data: { review_keep_audio: keep[id] ?? false }, error: null };
    }
    return { data: null, error: null };
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── 1. Retention ───────────────────────────────────────────────────────────
describe("retention: 14 days, then gone", () => {
  it("is 14 days by default, from TAOS_REVIEW_RETENTION_DAYS, never more than a year", () => {
    expect(flag.reviewRetentionDays(undefined)).toBe(14);
    expect(flag.reviewRetentionDays("")).toBe(14);
    expect(flag.reviewRetentionDays("0")).toBe(14);
    expect(flag.reviewRetentionDays("nope")).toBe(14);
    expect(flag.reviewRetentionDays("30")).toBe(30);
    expect(flag.reviewRetentionDays("9999")).toBe(365);
    process.env.TAOS_REVIEW_RETENTION_DAYS = "7";
    expect(flag.reviewRetentionDays()).toBe(7);
  });

  it("stamps expires_at exactly retention days after creation", () => {
    const created = Date.UTC(2026, 10, 4, 12, 0, 0);
    expect(flag.reviewExpiresAt(created, 14).toISOString()).toBe("2026-11-18T12:00:00.000Z");
    expect(flag.reviewExpired("2026-11-18T12:00:00.000Z", created + 13 * 86400000)).toBe(false);
    expect(flag.reviewExpired("2026-11-18T12:00:00.000Z", created + 14 * 86400000)).toBe(true);
    expect(flag.reviewExpired("garbage", created)).toBe(true);
  });

  it("the sweep removes the audio objects BEFORE it deletes the rows", async () => {
    tableAnswer = (table, chain) =>
      table === store.REVIEW_TABLE && chain.some((c) => c.method === "lte")
        ? { data: [{ id: "a", audio_path: `${TOM}/a.webm` }, { id: "b", audio_path: `${LIZ}/b.m4a` }], error: null }
        : { data: null, error: null };
    storageAnswer.remove = { data: [{}, {}], error: null };
    const result = await store.sweepReviewTurns(Date.UTC(2027, 0, 1));
    expect(result).toEqual({ scanned: 2, objectsRemoved: 2, rowsDeleted: 2, error: null });
    const removeAt = ops.findIndex((o) => o.kind === "storage" && o.name === store.REVIEW_BUCKET && o.method === "remove");
    const deleteAt = ops.findIndex((o) => o.kind === "table" && o.name === store.REVIEW_TABLE && o.method === "delete");
    expect(removeAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(removeAt);
  });

  it("keeps the rows when storage refuses", async () => {
    tableAnswer = (table, chain) =>
      table === store.REVIEW_TABLE && chain.some((c) => c.method === "lte")
        ? { data: [{ id: "a", audio_path: `${TOM}/a.webm` }], error: null }
        : { data: null, error: null };
    storageAnswer.remove = { data: null, error: { message: "boom" } };
    const result = await store.sweepReviewTurns();
    expect(result.error).toBe("storage_remove_failed");
    expect(ops.some((o) => o.kind === "table" && o.name === store.REVIEW_TABLE && o.method === "delete")).toBe(false);
  });

  it("the EXISTING daily walkie cron sweeps review turns in the same pass", async () => {
    process.env.CRON_SECRET = "s3cret";
    const res = await walkieSweep.GET(json("/api/walkie/sweep", "s3cret", undefined, "GET"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { review?: unknown };
    expect(body.review).toEqual({ scanned: 0, objectsRemoved: 0, rowsDeleted: 0, error: null });
    expect(ops.some((o) => o.kind === "table" && o.name === store.REVIEW_TABLE && o.method === "lte")).toBe(true);
    expect(logs.some((l) => l.startsWith("[taos-review] sweep by=cron"))).toBe(true);
  });

  it("the review sweep route takes the cron secret, or a founder session, and nothing else", async () => {
    process.env.CRON_SECRET = "s3cret";
    expect((await sweepRoute.GET(json("/api/review/sweep", undefined, undefined, "GET"))).status).toBe(401);
    expect((await sweepRoute.GET(json("/api/review/sweep", "stranger", undefined, "GET"))).status).toBe(404);
    expect((await sweepRoute.GET(json("/api/review/sweep", "s3cret", undefined, "GET"))).status).toBe(200);
    expect((await sweepRoute.GET(json("/api/review/sweep", "liz", undefined, "GET"))).status).toBe(200);
  });

  it("opening the list kicks a bounded sweep, off the response", async () => {
    const res = await turns.GET(json("/api/review/turns", "tom", undefined, "GET"));
    expect(res.status).toBe(200);
    const sweep = ops.find((o) => o.kind === "table" && o.name === store.REVIEW_TABLE && o.method === "lte");
    expect(sweep).toBeDefined();
  });
});

// ── 2. The opt-in gates storage ────────────────────────────────────────────
describe("the opt-in gates storage: only the speaker's own setting", () => {
  it("a founder with the opt-in OFF: the turn works and nothing is kept", async () => {
    keep[TOM] = false;
    const res = await translate.POST(homeRequest({ auth: "tom" }));
    expect(res.status).toBe(200);
    await settled();
    expect(await res.json()).toMatchObject({ original: TRANSCRIPT, translation: TRANSLATION });
    expect(reviewUploads()).toHaveLength(0);
    expect(reviewInserts()).toHaveLength(0);
  });

  it("a founder with the opt-in ON: the clip is copied and the row written, 14 days out", async () => {
    keep[TOM] = true;
    const before = Date.now();
    const res = await translate.POST(homeRequest({ auth: "tom" }));
    expect(res.status).toBe(200);
    // The phone's answer came back before the copy was made.
    expect(reviewInserts()).toHaveLength(0);
    await settled();
    const upload = reviewUploads();
    expect(upload).toHaveLength(1);
    expect(String(upload[0].args[0])).toMatch(new RegExp(`^${TOM}/[0-9a-f-]{36}\\.webm$`));
    expect((upload[0].args[2] as { contentType: string }).contentType).toBe("audio/webm");
    const insert = reviewInserts();
    expect(insert).toHaveLength(1);
    const row = insert[0].args[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      user_id: TOM,
      surface: "home",
      mode: "manual",
      source_lang: "es",
      target_lang: "en",
      original_text: TRANSCRIPT,
      translation_text: TRANSLATION,
      audio_mime: "audio/webm",
      audio_bytes: 3000,
      translate_model: "gpt-4.1"
    });
    expect(row.transcribe_model).toBe("gpt-4o-transcribe");
    const created = Date.parse(String(row.created_at));
    const expires = Date.parse(String(row.expires_at));
    expect(created).toBeGreaterThanOrEqual(before);
    expect(expires - created).toBe(14 * 86400000);
    const timings = row.timings as Record<string, unknown>;
    expect(typeof timings.transcribe_ms).toBe("number");
    expect(typeof timings.translate_ms).toBe("number");
    expect(typeof timings.total_ms).toBe("number");
    // The upload comes before the row, and the response is unchanged.
    expect(ops.indexOf(upload[0])).toBeLessThan(ops.indexOf(insert[0]));
    expect(await res.json()).toMatchObject({ original: TRANSCRIPT, translation: TRANSLATION });
  });

  it("an auto turn is kept as auto, with its segments", async () => {
    keep[TOM] = true;
    autoReply = JSON.stringify({
      segments: [
        { source_lang: "en", original: "I think we should leave early.", translation: "Creo que deberíamos salir temprano." },
        { source_lang: "es", original: "No, mejor después.", translation: "No, better later." }
      ]
    });
    const res = await translate.POST(homeRequest({ auth: "tom", source: "auto", target: "es", pair: ["en", "es"] }));
    expect(res.status).toBe(200);
    await settled();
    const row = reviewInserts()[0].args[0] as Record<string, unknown>;
    expect(row.mode).toBe("auto");
    expect(Array.isArray(row.segments)).toBe(true);
    expect((row.segments as unknown[]).length).toBe(2);
    expect(row.source_lang).toBe("en");
  });

  it("a signed-in stranger's profile is never consulted, and nothing is kept", async () => {
    keep[STRANGER] = true; // even if the column were on
    const res = await translate.POST(homeRequest({ auth: "stranger" }));
    expect(res.status).toBe(200);
    await settled();
    expect(profileReads()).toHaveLength(0);
    expect(reviewUploads()).toHaveLength(0);
    expect(reviewInserts()).toHaveLength(0);
  });

  it("a Taokie turn keeps the SENDER's audio by the sender's setting, not the partner's", async () => {
    keep[LIZ] = true;
    keep[TOM] = false;
    const res = await walkieTurn.POST(walkieRequest("liz"));
    expect(res.status).toBe(200);
    await settled();
    expect(profileReads()).toEqual([LIZ]);
    const insert = reviewInserts();
    expect(insert).toHaveLength(1);
    const row = insert[0].args[0] as Record<string, unknown>;
    expect(row).toMatchObject({ user_id: LIZ, surface: "taokie", source_lang: "es", target_lang: "en", rec_ms: 4200 });
    expect(String(reviewUploads()[0].args[0]).startsWith(`${LIZ}/`)).toBe(true);
    // Its own copy, in its own bucket — never a pointer into walkie-audio.
    expect(String(row.audio_path).startsWith(LIZ)).toBe(true);
    expect(ops.filter((o) => o.kind === "storage" && o.name === "walkie-audio" && o.method === "upload")).toHaveLength(2);

    ops.length = 0;
    const res2 = await walkieTurn.POST(walkieRequest("tom"));
    expect(res2.status).toBe(200);
    await settled();
    expect(profileReads()).toEqual([TOM]);
    expect(reviewInserts()).toHaveLength(0);
  });

  it("a row that fails to insert takes its object with it", async () => {
    keep[TOM] = true;
    const base = tableAnswer;
    tableAnswer = (table, chain) =>
      table === store.REVIEW_TABLE && chain.some((c) => c.method === "insert")
        ? { data: null, error: { message: "nope" } }
        : base(table, chain);
    const res = await translate.POST(homeRequest({ auth: "tom" }));
    expect(res.status).toBe(200);
    await settled();
    const remove = ops.find((o) => o.kind === "storage" && o.name === store.REVIEW_BUCKET && o.method === "remove");
    expect(remove).toBeDefined();
    expect(logs.some((l) => l.includes("[taos-review] keep_failed surface=home code=insert_failed"))).toBe(true);
  });

  it("speakerKeepsAudio answers false for nobody, a stranger, and on any error, without a database read for non-founders", async () => {
    expect(await capture.speakerKeepsAudio(null)).toBe(false);
    expect(await capture.speakerKeepsAudio({ id: "x", email: "someone@example.com" } as never)).toBe(false);
    expect(ops).toHaveLength(0);
    tableAnswer = () => ({ data: null, error: { message: "db down" } });
    expect(await capture.speakerKeepsAudio({ id: TOM, email: TOM_EMAIL } as never)).toBe(false);
  });

  it("the setting is per founder, read and written for the session's own id only, default off", async () => {
    const read = await settings.GET(json("/api/review/settings", "liz", undefined, "GET"));
    expect(await read.json()).toEqual({ keepAudio: false, retentionDays: 14 });
    expect(profileReads()).toEqual([LIZ]);
    const write = await settings.POST(json("/api/review/settings", "liz", { keepAudio: true }));
    expect(write.status).toBe(200);
    const update = ops.find((o) => o.kind === "table" && o.name === "profiles" && o.method === "update");
    expect(update?.args[0]).toEqual({ review_keep_audio: true });
    const scoped = ops.slice(ops.indexOf(update!)).find((o) => o.method === "eq");
    expect(scoped?.args).toEqual(["id", LIZ]);
    expect((await settings.POST(json("/api/review/settings", "liz", { keepAudio: "yes" }))).status).toBe(400);
    // A body cannot name another user.
    expect((await settings.POST(json("/api/review/settings", "liz", { keepAudio: true, userId: TOM }))).status).toBe(200);
    expect(ops.filter((o) => o.method === "eq").every((o) => o.args[1] !== TOM)).toBe(true);
  });
});

// ── 3. The gate ────────────────────────────────────────────────────────────
describe("the gate: founders only, 404 for anyone else", () => {
  it("every /api/review route turns a bare curl away with 401 and a stranger with 404", async () => {
    const calls: Array<[string, (auth?: string) => Promise<Response>]> = [
      ["settings GET", (a) => settings.GET(json("/api/review/settings", a, undefined, "GET"))],
      ["settings POST", (a) => settings.POST(json("/api/review/settings", a, { keepAudio: true }))],
      ["turns", (a) => turns.GET(json("/api/review/turns", a, undefined, "GET"))],
      ["flag", (a) => flagRoute.POST(json("/api/review/flag", a, { id: "11111111-2222-4333-8444-555555555555", reason: "words" }))],
      ["export", (a) => exportRoute.GET(json("/api/review/export", a, undefined, "GET"))],
      ["sweep", (a) => sweepRoute.GET(json("/api/review/sweep", a, undefined, "GET"))]
    ];
    for (const [name, call] of calls) {
      expect((await call(undefined)).status, `${name} bare`).toBe(401);
      expect((await call("stranger")).status, `${name} stranger`).toBe(404);
      expect(ops, name).toHaveLength(0);
    }
  });

  it("every /api/review route reads the guard (a new route cannot forget it)", () => {
    const dir = new URL("../app/api/review/", import.meta.url);
    const files = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => `${e.name}/route.ts`);
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const file of files) {
      expect(readFileSync(new URL(file, dir), "utf8"), file).toContain("guardReview");
    }
    const guard = readFileSync(new URL("../lib/review/guard.ts", import.meta.url), "utf8");
    expect(guard).toContain("guardSpend");
    expect(guard).toContain("reviewVisibleTo");
  });

  it("the page gate tells signed-out from not-a-founder, and a non-founder gets 'denied'", () => {
    expect(flag.reviewGateState({ ready: false, email: null, signedIn: false })).toBe("loading");
    expect(flag.reviewGateState({ ready: true, email: null, signedIn: false })).toBe("sign-in");
    expect(flag.reviewGateState({ ready: true, email: "someone@example.com", signedIn: true })).toBe("denied");
    expect(flag.reviewGateState({ ready: true, email: LIZ_EMAIL, signedIn: true })).toBe("open");
    const gate = readFileSync(new URL("../components/review/ReviewGate.tsx", import.meta.url), "utf8");
    // The card's words live in lib/chrome/copy.ts since the Spanish pass
    // (tests/review-chrome-language.test.ts renders it in both languages).
    expect(gate).toContain("404 · {s.reviewNotFound}");
    expect(gate).not.toContain("Coming soon");
  });

  it("the page never prerenders and is never indexed", () => {
    const page = readFileSync(new URL("../app/review/page.tsx", import.meta.url), "utf8");
    expect(page).toContain('export const dynamic = "force-dynamic"');
    expect(page).toContain("index: false");
  });
});

// ── 4. The flag ────────────────────────────────────────────────────────────
describe("the flag: four reasons, one line, stored on the turn", () => {
  const ID = "11111111-2222-4333-8444-555555555555";
  beforeEach(() => {
    const base = tableAnswer;
    tableAnswer = (table, chain) => {
      const update = chain.find((c) => c.method === "update");
      if (table === store.REVIEW_TABLE && update) return { data: { id: ID, ...(update.args[0] as object) }, error: null };
      return base(table, chain);
    };
  });

  it("accepts exactly words / meaning / tone / other", async () => {
    expect([...flag.FLAG_REASONS]).toEqual(["words", "meaning", "tone", "other"]);
    for (const reason of flag.FLAG_REASONS) {
      ops.length = 0;
      const res = await flagRoute.POST(json("/api/review/flag", "tom", { id: ID, reason, note: "  what   was said  " }));
      expect(res.status, reason).toBe(200);
      const update = ops.find((o) => o.kind === "table" && o.name === store.REVIEW_TABLE && o.method === "update");
      expect(update?.args[0]).toMatchObject({ flag_reason: reason, flag_note: "what was said", flagged_by: TOM });
      expect(typeof (update?.args[0] as { flagged_at: unknown }).flagged_at).toBe("string");
      const scoped = ops.find((o) => o.method === "eq");
      expect(scoped?.args).toEqual(["id", ID]);
    }
    expect((await flagRoute.POST(json("/api/review/flag", "tom", { id: ID, reason: "bad" }))).status).toBe(400);
    expect((await flagRoute.POST(json("/api/review/flag", "tom", { id: ID }))).status).toBe(400);
    expect((await flagRoute.POST(json("/api/review/flag", "tom", { id: "nope", reason: "words" }))).status).toBe(400);
  });

  it("null clears the flag, note and all", async () => {
    const res = await flagRoute.POST(json("/api/review/flag", "liz", { id: ID, reason: null, note: "ignored" }));
    expect(res.status).toBe(200);
    const update = ops.find((o) => o.kind === "table" && o.name === store.REVIEW_TABLE && o.method === "update");
    expect(update?.args[0]).toEqual({ flag_reason: null, flag_note: "", flagged_at: null, flagged_by: null });
  });

  it("the note is one line of at most 200 characters", () => {
    expect(flag.FLAG_NOTE_MAX).toBe(200);
    expect(flag.cleanFlagNote("a\nb\tc")).toBe("a b c");
    expect(flag.cleanFlagNote("x".repeat(500))).toHaveLength(200);
    expect(flag.cleanFlagNote(42)).toBe("");
  });

  it("a flag on a turn that has expired answers 404", async () => {
    tableAnswer = () => ({ data: null, error: null });
    expect((await flagRoute.POST(json("/api/review/flag", "tom", { id: ID, reason: "tone" }))).status).toBe(404);
  });
});

// ── 5. The export round-trips into the probe ───────────────────────────────
describe("the export is the transcriber probe's clip set", () => {
  const rowA = {
    id: "11111111-2222-4333-8444-555555555555",
    user_id: TOM,
    surface: "home",
    mode: "manual",
    source_lang: "es",
    target_lang: "en",
    original_text: "Pero es seguro, ya pagué la cuenta",
    translation_text: "But it's safe, I already paid the bill",
    segments: null,
    audio_path: `${TOM}/11111111-2222-4333-8444-555555555555.webm`,
    audio_mime: "audio/webm",
    audio_bytes: 5,
    rec_ms: 4200,
    transcribe_model: "gpt-4o-transcribe",
    translate_model: "gpt-4.1",
    timings: { transcribe_ms: 900, translate_ms: 1200 },
    flag_reason: "words",
    flag_note: "Pero es el seguro, ya pagué la cuenta de la casa",
    flagged_at: "2026-11-04T18:00:00.000Z",
    flagged_by: TOM,
    created_at: "2026-11-04T17:30:00.000Z",
    expires_at: "2026-11-18T17:30:00.000Z"
  };
  const rowB = {
    ...rowA,
    id: "22222222-2222-4333-8444-555555555555",
    user_id: LIZ,
    surface: "taokie",
    source_lang: "en",
    target_lang: "es",
    original_text: "Can you call the restaurant?",
    translation_text: "¿Puedes llamar al restaurante?",
    audio_path: `${LIZ}/22222222-2222-4333-8444-555555555555.m4a`,
    audio_mime: "audio/mp4",
    flag_reason: "meaning",
    flag_note: "",
    created_at: "2026-11-03T09:00:00.000Z"
  };

  it("the tar writer and reader agree, byte for byte", () => {
    const entries = [
      { name: "a/one.webm", data: new Uint8Array([1, 2, 3, 4, 5]), mtime: 1_700_000_000 },
      { name: "a/one.txt", data: new TextEncoder().encode("es: hola\n"), mtime: 1_700_000_000 },
      { name: "a/big.bin", data: new Uint8Array(1025).fill(7) }
    ];
    const archive = tar.buildTar(entries);
    expect(archive.length % 512).toBe(0);
    const back = tar.readTar(archive);
    expect(back.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    for (const [i, e] of entries.entries()) expect(Array.from(back[i].data)).toEqual(Array.from(e.data));
    expect(back[0].mtime).toBe(1_700_000_000);
  });

  it("exports only FLAGGED turns and the probe reads every one of them back", async () => {
    storageAnswer.download.set(rowA.audio_path, new Uint8Array([10, 20, 30, 40, 50]));
    storageAnswer.download.set(rowB.audio_path, new Uint8Array([9, 8, 7]));
    tableAnswer = (table, chain) => {
      if (table === store.REVIEW_TABLE && chain.some((c) => c.method === "select")) {
        expect(chain.some((c) => c.method === "not" && c.args[0] === "flag_reason")).toBe(true);
        return { data: [rowA, rowB], error: null };
      }
      if (table === "profiles") {
        return { data: [{ id: TOM, email: TOM_EMAIL }, { id: LIZ, email: LIZ_EMAIL }], error: null };
      }
      return { data: null, error: null };
    };
    const res = await exportRoute.GET(json("/api/review/export", "tom", undefined, "GET"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-tar");
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="review-clips-\d{4}-\d{2}-\d{2}\.tar"/);

    // tar xf, in effect.
    const archive = new Uint8Array(await res.arrayBuffer());
    const dir = mkdtempSync(join(tmpdir(), "taos-review-export-"));
    try {
      const entries = tar.readTar(archive);
      expect(entries.every((e) => /^review-clips-\d{4}-\d{2}-\d{2}\//.test(e.name))).toBe(true);
      const folder = join(dir, entries[0].name.split("/")[0]);
      mkdirSync(folder, { recursive: true });
      for (const e of entries) writeFileSync(join(folder, e.name.split("/")[1]), e.data);
      // What `--clips <dir>` reads — through the probe's own reader.
      const clips = clipDir.readClipDir(folder);
      expect(clips).toHaveLength(2);
      const [b, a] = clips; // sorted by name: 20261103-taokie-… before 20261104-home-…
      expect(a.stem).toBe("20261104-home-11111111");
      expect(a.mime).toBe("audio/webm");
      expect(Array.from(a.bytes)).toEqual([10, 20, 30, 40, 50]);
      // A `words` flag with a note: the NOTE is the reference the probe scores against.
      expect(a.parts).toEqual([{ lang: "es", text: "Pero es el seguro, ya pagué la cuenta de la casa" }]);
      expect(b.stem).toBe("20261103-taokie-22222222");
      expect(b.mime).toBe("audio/mp4");
      expect(b.parts).toEqual([{ lang: "en", text: "Can you call the restaurant?" }]);
      // The sidecar carries the translation and the flag; the probe ignores it.
      const meta = JSON.parse(readFileSync(join(folder, "20261104-home-11111111.json"), "utf8")) as Record<string, unknown>;
      expect(meta).toMatchObject({
        translation: rowA.translation_text,
        flag: { reason: "words", note: rowA.flag_note },
        models: { transcribe: "gpt-4o-transcribe", translate: "gpt-4.1" },
        speaker: "xdrabbit",
        audio: "20261104-home-11111111.webm"
      });
      expect(JSON.stringify(meta)).not.toContain("gmail");
      const manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8")) as { clips: unknown[] };
      expect(manifest.clips).toHaveLength(2);
      expect(readdirSync(folder).sort()).toEqual([
        "20261103-taokie-22222222.json",
        "20261103-taokie-22222222.m4a",
        "20261103-taokie-22222222.txt",
        "20261104-home-11111111.json",
        "20261104-home-11111111.txt",
        "20261104-home-11111111.webm",
        "manifest.json"
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the probe and its runner read the one shared format", () => {
    const measure = readFileSync(new URL("./live-fire/transcribe-accuracy.measure.ts", import.meta.url), "utf8");
    expect(measure).toContain('from "@/lib/review/clipDir"');
    expect(measure).not.toMatch(/function parseScript/);
    const runner = readFileSync(new URL("./live-fire/transcribe-accuracy.run.mjs", import.meta.url), "utf8");
    expect(runner).toContain("--clips");
    expect(runner).toContain("TRANSCRIBE_CLIPS_DIR");
    // The script format itself, pinned: tags, guessing, blanks.
    expect(clipSet.parseClipScript("en: Hello\n\nes: Hola\n¿Qué tal?\n")).toEqual([
      { lang: "en", text: "Hello" },
      { lang: "es", text: "Hola" },
      { lang: "es", text: "¿Qué tal?" }
    ]);
    // A language the probe cannot tag goes untagged.
    expect(clipSet.clipScriptFor({ source_lang: "it", original_text: "Ciao", flag_reason: "tone", flag_note: "" })).toBe("Ciao\n");
    expect(clipSet.clipScriptFor({ source_lang: "en", original_text: "Hi", flag_reason: "words", flag_note: "" })).toBe("en: Hi\n");
  });
});

// ── 6. Privacy ─────────────────────────────────────────────────────────────
describe("privacy: rows and objects only, nothing new in logs", () => {
  it("no [taos-review] line carries a transcript, a translation, an email or a user agent", async () => {
    keep[TOM] = true;
    await translate.POST(homeRequest({ auth: "tom" }));
    await settled();
    await settings.POST(json("/api/review/settings", "tom", { keepAudio: true }));
    await turns.GET(json("/api/review/turns", "tom", undefined, "GET"));
    const lines = logs.filter((l) => l.includes("[taos-review]"));
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      expect(line).not.toContain(TRANSCRIPT);
      expect(line).not.toContain(TRANSLATION);
      expect(line).not.toContain("xdrabbit");
      expect(line).not.toContain("gmail");
      expect(line).not.toContain("iPhone");
      expect(line).not.toContain(TOM);
    }
    expect(lines.some((l) => /^\[taos-review\] kept surface=home mode=manual bytes=3000$/.test(l))).toBe(true);
  });

  it("the migration: opt-in default OFF, RLS with no policies, private bucket, cascade on the speaker", () => {
    const sql = readFileSync(new URL("../supabase/migrations/20261104_review_turns.sql", import.meta.url), "utf8");
    expect(sql).toContain("review_keep_audio boolean not null default false");
    expect(sql).toContain("enable row level security");
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).toMatch(/'review-audio', 'review-audio', false/);
    expect(sql).toContain("references auth.users (id) on delete cascade");
    expect(sql).toMatch(/flag_reason in \('words', 'meaning', 'tone', 'other'\)/);
  });

  it("the home-history row is untouched: no audio column, no new writer", () => {
    const supa = readFileSync(new URL("../lib/supabase.ts", import.meta.url), "utf8");
    expect(supa).not.toMatch(/audio_path|review_keep/);
    const route = readFileSync(new URL("../app/api/translate/route.ts", import.meta.url), "utf8");
    expect(route).not.toContain("taos_lite_translations");
  });

  it("marks every Spanish review string as pending Liz's review", () => {
    const src = readFileSync(new URL("../lib/chrome/copy.ts", import.meta.url), "utf8");
    const esStart = src.indexOf("  es: {");
    const esEnd = src.indexOf("\n  },", esStart);
    const es = src.slice(esStart, esEnd).split("\n").filter((l) => /^\s+(review|navReview)[A-Za-z]*:/.test(l));
    expect(es.length).toBeGreaterThan(20);
    for (const line of es) expect(line, line).toContain("pendiente de revisión por Liz");
    const enKeys = (src.match(/^  (review|navReview)[A-Za-z]*:/gm) ?? []).map((k) => k.trim().replace(":", ""));
    for (const line of es) expect(enKeys, line).toContain(line.trim().split(":")[0]);
  });
});

// ── 7. The screen ──────────────────────────────────────────────────────────
describe("the screen: one page, three columns on a laptop, stacked on a phone", () => {
  it("filters by the reviewer's own day", () => {
    const b = shell.dayBounds("2026-11-04")!;
    expect(Date.parse(b.to) - Date.parse(b.from)).toBe(86400000);
    expect(new Date(b.from).getDate()).toBe(4);
    expect(shell.dayBounds("nope")).toBeNull();
    expect(shell.todayValue(new Date(2026, 10, 4, 23, 59))).toBe("2026-11-04");
  });

  it("stacks on a phone, sits side by side from md up, with thumb-sized flag buttons", () => {
    const src = readFileSync(new URL("../components/review/ReviewShell.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/grid gap-3 md:grid-cols-\[/);
    expect(src).toContain("<audio controls");
    expect(src).toContain("data-review-flag={reason}");
    const flagButton = src.slice(src.indexOf("data-review-flag"), src.indexOf("reasonLabel[reason]"));
    expect(flagButton).toContain("min-h-[44px] min-w-[44px]");
    expect(src).toContain('data-review-keep-audio=""');
    expect(src).toContain('"/api/review/export"');
    expect(src).not.toMatch(/localStorage/);
  });

  it("the list route filters by day, speaker and flagged, newest first, signed audio, speakers labelled", async () => {
    tableAnswer = (table, chain) => {
      if (table === store.REVIEW_TABLE && chain.some((c) => c.method === "select")) {
        return { data: [{ id: "r1", user_id: TOM, audio_path: `${TOM}/r1.webm`, created_at: "2026-11-04T17:30:00.000Z" }], error: null };
      }
      if (table === "profiles") return { data: [{ id: TOM, email: TOM_EMAIL }], error: null };
      return { data: null, error: null };
    };
    const res = await turns.GET(
      json(`/api/review/turns?from=2026-11-04T07:00:00.000Z&to=2026-11-05T07:00:00.000Z&speaker=${TOM}&flagged=1`, "liz", undefined, "GET")
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { turns: Array<Record<string, unknown>>; speakers: unknown[]; retentionDays: number };
    expect(body.turns[0].audio_url).toBe("https://signed.example/x");
    expect(body.speakers).toEqual([{ id: TOM, email: TOM_EMAIL }]);
    expect(body.retentionDays).toBe(14);
    const listOps = ops.filter((o) => o.kind === "table" && o.name === store.REVIEW_TABLE);
    expect(listOps.some((o) => o.method === "gte" && o.args[0] === "created_at")).toBe(true);
    expect(listOps.some((o) => o.method === "lt" && o.args[0] === "created_at")).toBe(true);
    expect(listOps.some((o) => o.method === "eq" && o.args[0] === "user_id" && o.args[1] === TOM)).toBe(true);
    expect(listOps.some((o) => o.method === "not" && o.args[0] === "flag_reason")).toBe(true);
    expect(listOps.some((o) => o.method === "order" && (o.args[1] as { ascending: boolean }).ascending === false)).toBe(true);
    expect(listOps.some((o) => o.method === "gt" && o.args[0] === "expires_at")).toBe(true);
  });
});
