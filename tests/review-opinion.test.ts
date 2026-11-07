// The second opinion on /review (Tom, 2026-11-04 20:27 MT): a model checks
// each kept turn — a second transcriber word-diffed against the transcript,
// a grader's strict JSON on the translation — so the founders can verify the
// SUSPECTS by ear. These pin the decisions it was built on:
//
//   1. the word diff: punctuation and case are not differences, accents are;
//      agreement is matched words over the longer side; spans are character
//      offsets into the ORIGINAL so the page can highlight what it shows
//   2. the grader's reply: strict on the two scores, forgiving on the rest,
//      and a malformed reply is a CODE on the row, never a crash
//   3. suspects first: lowest score first, the unreviewed last
//   4. both new routes: 401 bare, 404 for a stranger, the provider never
//      reached before the guard; "check all" refuses more than one day
//   5. the save touches the three opinion columns and nothing a person wrote
//      — a grader's issue never becomes a flag
//   6. the nightly pass is off by default, cron-only, and one batch's worth
//   7. logs: counts and codes, never a transcript
//
// OpenAI is a fetch mock routed by URL; nothing reaches the network or a database.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { ReviewOpinion } from "@/lib/review/opinion";

const TOM = "aaaaaaaa-0000-4000-8000-00000000000a";
const LIZ = "bbbbbbbb-0000-4000-8000-00000000000b";

vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async (req: Request) => {
    const auth = req.headers.get("authorization") ?? "";
    if (auth === "Bearer tom") return { id: "aaaaaaaa-0000-4000-8000-00000000000a", email: ["xdrabbit", "gmail.com"].join("@") };
    if (auth === "Bearer liz") return { id: "bbbbbbbb-0000-4000-8000-00000000000b", email: ["lizmariett", "gmail.com"].join("@") };
    if (auth === "Bearer stranger") return { id: "cccccccc-0000-4000-8000-00000000000c", email: "someone@example.com" };
    return null;
  }
}));

vi.mock("@vercel/functions", () => ({ waitUntil: () => undefined }));

// ── A recording Supabase admin ─────────────────────────────────────────────
interface Op {
  kind: "table" | "storage";
  name: string;
  method: string;
  args: unknown[];
}
const ops: Op[] = [];
let tableAnswer: (table: string, chain: Op[]) => { data: unknown; error: unknown } = () => ({ data: null, error: null });

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

const clipBytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
vi.mock("@/lib/supabaseAdmin", () => ({
  hasServiceRoleKey: true,
  supabaseAdmin: {
    from: (table: string) => builder(table),
    storage: {
      from: (bucket: string) => ({
        download: async (path: string) => {
          ops.push({ kind: "storage", name: bucket, method: "download", args: [path] });
          return { data: new Blob([clipBytes]), error: null };
        },
        remove: async (...args: unknown[]) => {
          ops.push({ kind: "storage", name: bucket, method: "remove", args });
          return { data: [], error: null };
        },
        createSignedUrl: async () => ({ data: { signedUrl: "https://signed.example/x" }, error: null })
      })
    }
  }
}));

const opinion = await import("@/lib/review/opinion");
const server = await import("@/lib/review/secondOpinion");
const store = await import("@/lib/review/store");
const opinionRoute = await import("@/app/api/review/opinion/route");
const batchRoute = await import("@/app/api/review/opinion/batch/route");
const turnsRoute = await import("@/app/api/review/turns/route");
const walkieSweep = await import("@/app/api/walkie/sweep/route");
const { STUDY_LESSON_MODEL_DEFAULT } = await import("@/lib/study/lesson");
const { ENGLISH, copyFor } = await import("@/lib/chrome/copy");

const TRANSCRIPT = "Pero es seguro, ya pagué la cuenta de la casa";
const TRANSLATION = "But it's insurance, I already paid the house bill";
const ALT = "Pero el seguro, ya pagué la cuenta de la casa";
const ID = "11111111-2222-4333-8444-555555555555";
const ID2 = "22222222-2222-4333-8444-555555555555";
const ID3 = "33333333-2222-4333-8444-555555555555";

type Row = ReturnType<typeof baseRow>;
function row(over: Partial<Row> = {}): Row {
  return { ...baseRow(), ...over };
}
function baseRow() {
  return {
    id: ID,
    user_id: TOM,
    surface: "home" as const,
    mode: "manual" as const,
    source_lang: "es",
    target_lang: "en",
    original_text: TRANSCRIPT,
    translation_text: TRANSLATION,
    segments: null,
    audio_path: `${TOM}/${ID}.webm`,
    audio_mime: "audio/webm",
    audio_bytes: 3000,
    rec_ms: 2000,
    transcribe_model: "gpt-4o-transcribe",
    translate_model: "gpt-4.1",
    timings: {},
    flag_reason: null,
    flag_note: "",
    flagged_at: null,
    flagged_by: null,
    opinion: null as ReviewOpinion | null,
    opinion_score: null as number | null,
    opinion_at: null as string | null,
    created_at: "2026-11-04T18:00:00.000Z",
    expires_at: "2099-01-01T00:00:00.000Z"
  };
}

const GOOD_GRADE = {
  meaning: 2,
  tone: 4,
  issues: [{ span: "insurance", kind: "wrong-word", why: "seguro here means safe, not insurance" }],
  suggested_translation: "But it's safe, I already paid the house bill"
};

const openai: Array<{ url: string; body: unknown; model: string | null }> = [];
let sttReply: () => Response = () => new Response(JSON.stringify({ text: ALT }), { status: 200 });
let gradeReply: () => Response = () =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(GOOD_GRADE) } }] }), { status: 200 });

function installFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/v1/audio/transcriptions")) {
        const form = init?.body as FormData;
        openai.push({ url, body: null, model: String(form.get("model")) });
        return sttReply();
      }
      if (url.includes("/v1/chat/completions")) {
        const body = JSON.parse(String(init?.body)) as { model: string };
        openai.push({ url, body, model: body.model });
        return gradeReply();
      }
      throw new Error(`unexpected fetch ${url}`);
    })
  );
}

function json(path: string, auth: string | undefined, body?: unknown, method = "POST"): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "Mozilla/5.0 (iPhone)" };
  if (auth) headers.authorization = `Bearer ${auth}`;
  return new NextRequest(`https://taos.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const logs: string[] = [];
let rows: Row[] = [];
const updates = () => ops.filter((o) => o.kind === "table" && o.name === store.REVIEW_TABLE && o.method === "update");
const sttCalls = () => openai.filter((o) => o.url.includes("transcriptions"));
const gradeCalls = () => openai.filter((o) => o.url.includes("completions"));

beforeEach(() => {
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.TAOS_WALKIE_ENABLED = "1";
  delete process.env.TAOS_REVIEW_STT_MODEL;
  delete process.env.TAOS_REVIEW_GRADER_MODEL;
  delete process.env.TAOS_REVIEW_BATCH_MAX;
  delete process.env.TAOS_REVIEW_NIGHTLY;
  delete process.env.CRON_SECRET;
  ops.length = 0;
  openai.length = 0;
  logs.length = 0;
  rows = [row()];
  sttReply = () => new Response(JSON.stringify({ text: ALT }), { status: 200 });
  gradeReply = () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(GOOD_GRADE) } }] }), { status: 200 });
  installFetch();
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  }
  tableAnswer = (table, chain) => {
    if (table !== store.REVIEW_TABLE) return { data: table === "profiles" ? [] : null, error: null };
    const eq = chain.find((c) => c.method === "eq" && c.args[0] === "id");
    const update = chain.find((c) => c.method === "update");
    if (update && eq) {
      const found = rows.find((r) => r.id === eq.args[1]);
      return { data: found ? { ...found, ...(update.args[0] as object) } : null, error: null };
    }
    if (eq) return { data: rows.find((r) => r.id === eq.args[1]) ?? null, error: null };
    // A list: honour opinion_at-is-null and the limit.
    const limit = chain.find((c) => c.method === "limit");
    const unreviewed = chain.some((c) => c.method === "is" && c.args[0] === "opinion_at");
    let list = unreviewed ? rows.filter((r) => r.opinion_at === null) : rows;
    if (limit) list = list.slice(0, Number(limit.args[0]));
    return { data: list, error: null };
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── 1. The word diff ───────────────────────────────────────────────────────
describe("the word diff and its agreement", () => {
  it("identical transcripts agree completely, with no spans", () => {
    const d = opinion.wordDiff(TRANSCRIPT, TRANSCRIPT);
    expect(d.agreement).toBe(1);
    expect(d.spans).toEqual([]);
  });

  it("punctuation and case are not differences; accents are", () => {
    expect(opinion.wordDiff("¿Cómo estás, Liz?", "cómo estás liz").agreement).toBe(1);
    const d = opinion.wordDiff("¿Cómo estás?", "como estas");
    expect(d.agreement).toBe(0);
    expect(d.spans).toHaveLength(1);
    expect(d.spans[0].alt).toBe("como estas");
  });

  it("a substituted word is one span at the original's character offsets, with what was heard instead", () => {
    const d = opinion.wordDiff(TRANSCRIPT, ALT);
    expect(d.spans).toHaveLength(1);
    const [span] = d.spans;
    expect(TRANSCRIPT.slice(span.start, span.end)).toBe("es");
    expect(span.original).toBe("es");
    expect(span.alt).toBe("el");
    // 10 words, 9 matched.
    expect(d.matched).toBe(9);
    expect(d.agreement).toBe(0.9);
  });

  it("a dropped word is a span with an empty alt; an added word is a zero-width span", () => {
    const dropped = opinion.wordDiff("ya pagué la cuenta", "ya la cuenta");
    expect(dropped.spans).toEqual([{ start: 3, end: 8, original: "pagué", alt: "" }]);
    expect(dropped.agreement).toBe(0.75);
    const added = opinion.wordDiff("ya la cuenta", "ya pagué la cuenta");
    expect(added.spans).toHaveLength(1);
    expect(added.spans[0].start).toBe(added.spans[0].end);
    expect(added.spans[0].alt).toBe("pagué");
    expect(added.agreement).toBe(0.75);
  });

  it("every span's original is exactly the slice it points at, so the page can highlight it", () => {
    const d = opinion.wordDiff("uno dos tres cuatro cinco seis", "uno 2 tres cuatro five seis siete");
    for (const span of d.spans) expect("uno dos tres cuatro cinco seis".slice(span.start, span.end)).toBe(span.original);
    expect(d.spans.map((s) => [s.original, s.alt])).toEqual([
      ["dos", "2"],
      ["cinco", "five"],
      ["", "siete"]
    ]);
  });

  it("two empty transcripts agree; one empty one does not", () => {
    expect(opinion.wordDiff("", "").agreement).toBe(1);
    expect(opinion.wordDiff("hola", "").agreement).toBe(0);
    expect(opinion.wordDiff("", "hola").agreement).toBe(0);
  });
});

// ── 2. The grader's reply ──────────────────────────────────────────────────
describe("the grader's JSON: strict on the scores, forgiving on the rest", () => {
  it("parses a good reply", () => {
    const p = opinion.parseGrade(JSON.stringify(GOOD_GRADE));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.grade.meaning).toBe(2);
    expect(p.grade.tone).toBe(4);
    expect(p.grade.issues[0]).toEqual(GOOD_GRADE.issues[0]);
    expect(p.grade.suggested_translation).toBe(GOOD_GRADE.suggested_translation);
  });

  it("clamps scores into 1..5, turns an unknown kind into other, drops empty issues, caps the list", () => {
    const p = opinion.parseGrade(
      JSON.stringify({
        meaning: 9,
        tone: "0",
        issues: [
          { span: "x", kind: "nonsense", why: "y" },
          { span: "", kind: "dropped", why: "" },
          ...Array.from({ length: 20 }, (_, i) => ({ span: `s${i}`, kind: "other", why: "w" }))
        ],
        suggested_translation: 42
      })
    );
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.grade.meaning).toBe(5);
    expect(p.grade.tone).toBe(1);
    expect(p.grade.issues[0].kind).toBe("other");
    expect(p.grade.issues.length).toBeLessThanOrEqual(opinion.GRADE_ISSUES_MAX);
    expect(p.grade.issues.some((i) => i.span === "" && i.why === "")).toBe(false);
    expect(p.grade.suggested_translation).toBe("");
  });

  it("takes JSON out of a fence, and a non-array issues list as empty", () => {
    const p = opinion.parseGrade("```json\n" + JSON.stringify({ meaning: 5, tone: 5, issues: "none", suggested_translation: "ok" }) + "\n```");
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.grade.issues).toEqual([]);
  });

  it("a malformed reply is a code, not a throw", () => {
    expect(opinion.parseGrade("")).toEqual({ ok: false, code: "empty" });
    expect(opinion.parseGrade("I think it's fine.")).toEqual({ ok: false, code: "malformed" });
    expect(opinion.parseGrade("[1,2]")).toEqual({ ok: false, code: "malformed" });
    expect(opinion.parseGrade(JSON.stringify({ tone: 3, issues: [] }))).toEqual({ ok: false, code: "malformed" });
    expect(opinion.parseGrade(JSON.stringify({ meaning: "high", tone: 3 }))).toEqual({ ok: false, code: "malformed" });
  });

  it("asks for strict JSON with the five issue kinds, and never sends a temperature", async () => {
    await server.secondOpinionFor(row(), { apiKey: "sk-test" }, "es");
    const [call] = gradeCalls();
    const body = call.body as Record<string, unknown>;
    expect(body.temperature).toBeUndefined();
    expect(body.model).toBe(STUDY_LESSON_MODEL_DEFAULT);
    const rf = body.response_format as { type: string; json_schema: { strict: boolean; schema: { properties: { issues: { items: { properties: { kind: { enum: string[] } } } } } } } };
    expect(rf.type).toBe("json_schema");
    expect(rf.json_schema.strict).toBe(true);
    expect(rf.json_schema.schema.properties.issues.items.properties.kind.enum).toEqual(["dropped", "invented", "wrong-word", "wrong-register", "other"]);
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0].content).toContain("Spanish to English");
    expect(messages[0].content).toContain('Write every "why" in Spanish');
    expect(messages[1].content).toContain(TRANSCRIPT);
    expect(messages[1].content).toContain(TRANSLATION);
  });
});

// ── 3. Suspects first ──────────────────────────────────────────────────────
describe("suspects first: the lowest score at the top, the unreviewed last", () => {
  it("the score is the lowest of agreement, meaning/5 and tone/5, null when nothing arrived", () => {
    const stt = { model: "whisper-1", alt_transcript: "", agreement: 0.9, diff: [] };
    const grade = { model: "g", meaning: 2, tone: 4, issues: [], suggested_translation: "" };
    expect(opinion.opinionScore({ stt, grade, errors: {} })).toBe(0.4);
    expect(opinion.opinionScore({ stt, grade: null, errors: { grade: "timeout" } })).toBe(0.9);
    expect(opinion.opinionScore({ stt: null, grade, errors: {} })).toBe(0.4);
    expect(opinion.opinionScore({ stt: null, grade: null, errors: { stt: "x", grade: "y" } })).toBeNull();
    expect(opinion.opinionScore(null)).toBeNull();
    expect(opinion.isSuspect(0.4)).toBe(true);
    expect(opinion.isSuspect(0.95)).toBe(false);
    expect(opinion.isSuspect(null)).toBe(false);
  });

  it("sorts checked turns by rising score, ties newest first, then the unchecked newest first", () => {
    const rowsIn = [
      { id: "unchecked-new", opinion_score: null, created_at: "2026-11-04T20:00:00Z" },
      { id: "fine", opinion_score: 0.9, created_at: "2026-11-04T19:00:00Z" },
      { id: "bad-old", opinion_score: 0.4, created_at: "2026-11-04T10:00:00Z" },
      { id: "unchecked-old", opinion_score: null, created_at: "2026-11-04T09:00:00Z" },
      { id: "bad-new", opinion_score: 0.4, created_at: "2026-11-04T18:00:00Z" }
    ];
    expect(opinion.sortSuspectsFirst(rowsIn).map((r) => r.id)).toEqual(["bad-new", "bad-old", "fine", "unchecked-new", "unchecked-old"]);
  });

  it("the list route orders the same way in SQL when asked, and newest-first otherwise", async () => {
    await turnsRoute.GET(json("/api/review/turns?sort=suspects", "tom", undefined, "GET"));
    const orders = ops.filter((o) => o.name === store.REVIEW_TABLE && o.method === "order").map((o) => o.args);
    expect(orders).toEqual([
      ["opinion_score", { ascending: true, nullsFirst: false }],
      ["created_at", { ascending: false }]
    ]);
    ops.length = 0;
    await turnsRoute.GET(json("/api/review/turns", "tom", undefined, "GET"));
    expect(ops.filter((o) => o.name === store.REVIEW_TABLE && o.method === "order").map((o) => o.args)).toEqual([["created_at", { ascending: false }]]);
  });
});

// ── 4. The knobs ───────────────────────────────────────────────────────────
describe("the knobs", () => {
  it("the second transcriber is whisper-1 unless TAOS_REVIEW_STT_MODEL says otherwise", () => {
    expect(opinion.reviewSttModel(undefined)).toBe("whisper-1");
    expect(opinion.reviewSttModel("  ")).toBe("whisper-1");
    expect(opinion.reviewSttModel("gpt-4o-mini-transcribe")).toBe("gpt-4o-mini-transcribe");
  });

  it("never re-reads a clip with the model that produced the turn", () => {
    expect(opinion.pickAltSttModel("gpt-4o-transcribe", "whisper-1")).toBe("whisper-1");
    expect(opinion.pickAltSttModel("whisper-1", "whisper-1")).toBe("gpt-4o-mini-transcribe");
    expect(opinion.pickAltSttModel("gpt-4o-mini-transcribe", "gpt-4o-mini-transcribe")).toBe("whisper-1");
    expect(opinion.pickAltSttModel(null, "whisper-1")).toBe("whisper-1");
  });

  it("the grader is the strongest text model the repo already runs, unless TAOS_REVIEW_GRADER_MODEL says otherwise", () => {
    expect(server.reviewGraderModel(undefined)).toBe(STUDY_LESSON_MODEL_DEFAULT);
    expect(STUDY_LESSON_MODEL_DEFAULT).toMatch(/^gpt-5/);
    expect(server.reviewGraderModel("gpt-4.1")).toBe("gpt-4.1");
  });

  it("a click sends 50 turns by default, TAOS_REVIEW_BATCH_MAX otherwise, never more than 200", () => {
    expect(opinion.reviewBatchMax(undefined)).toBe(50);
    expect(opinion.reviewBatchMax("abc")).toBe(50);
    expect(opinion.reviewBatchMax("0")).toBe(50);
    expect(opinion.reviewBatchMax("20")).toBe(20);
    expect(opinion.reviewBatchMax("5000")).toBe(200);
  });

  it("the nightly pass is off unless TAOS_REVIEW_NIGHTLY=1", () => {
    expect(opinion.reviewNightlyEnabled(undefined)).toBe(false);
    expect(opinion.reviewNightlyEnabled("true")).toBe(false);
    expect(opinion.reviewNightlyEnabled("1")).toBe(true);
  });

  it("the grader explains in the reviewer's language, or English", () => {
    expect(opinion.explainLanguage("es")).toBe("es");
    expect(opinion.explainLanguage("xx")).toBe("en");
    expect(opinion.explainLanguage(undefined)).toBe("en");
  });
});

// ── 5. The routes ──────────────────────────────────────────────────────────
describe("the routes: founders only, the provider never reached before the guard", () => {
  it("both answer 401 bare and 404 to a stranger, touching nothing", async () => {
    const day = { from: "2026-11-04T07:00:00.000Z", to: "2026-11-05T07:00:00.000Z" };
    const calls: Array<[string, (auth?: string) => Promise<Response>]> = [
      ["opinion", (a) => opinionRoute.POST(json("/api/review/opinion", a, { id: ID }))],
      ["batch", (a) => batchRoute.POST(json("/api/review/opinion/batch", a, day))]
    ];
    for (const [name, call] of calls) {
      expect((await call(undefined)).status, `${name} bare`).toBe(401);
      expect((await call("stranger")).status, `${name} stranger`).toBe(404);
      expect(ops, name).toHaveLength(0);
      expect(openai, name).toHaveLength(0);
    }
  });

  it("both route files read the guard, and the guard reads guardSpend", () => {
    for (const file of ["../app/api/review/opinion/route.ts", "../app/api/review/opinion/batch/route.ts"]) {
      const src = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(src, file).toContain("guardReview");
      expect(src.indexOf("guardReview(req)"), file).toBeLessThan(src.indexOf("OPENAI_API_KEY"));
    }
    expect(readFileSync(new URL("../lib/review/guard.ts", import.meta.url), "utf8")).toContain("guardSpend");
  });

  it("the second opinion lands on the row: alt transcript, agreement, spans, grade, score — and nothing else", async () => {
    const res = await opinionRoute.POST(json("/api/review/opinion", "tom", { id: ID, explain: "es" }));
    expect(res.status).toBe(200);
    const { turn } = (await res.json()) as { turn: Record<string, unknown> };
    expect(sttCalls()).toHaveLength(1);
    expect(sttCalls()[0].model).toBe("whisper-1");
    expect(gradeCalls()).toHaveLength(1);
    // The clip was fetched from the review bucket.
    expect(ops.some((o) => o.kind === "storage" && o.name === store.REVIEW_BUCKET && o.method === "download" && o.args[0] === `${TOM}/${ID}.webm`)).toBe(true);
    const [update] = updates();
    const patch = update.args[0] as Record<string, unknown>;
    expect(Object.keys(patch).sort()).toEqual(["opinion", "opinion_at", "opinion_score"]);
    const op = patch.opinion as { stt: { model: string; alt_transcript: string; agreement: number; diff: unknown[] }; grade: { model: string; meaning: number; tone: number }; errors: object };
    expect(op.stt.model).toBe("whisper-1");
    expect(op.stt.alt_transcript).toBe(ALT);
    expect(op.stt.agreement).toBe(0.9);
    expect(op.stt.diff).toHaveLength(1);
    expect(op.grade.model).toBe(STUDY_LESSON_MODEL_DEFAULT);
    expect(op.grade.meaning).toBe(2);
    expect(op.errors).toEqual({});
    expect(patch.opinion_score).toBe(0.4);
    expect(turn.flag_reason).toBeNull();
    expect(turn.opinion_score).toBe(0.4);
  });

  it("a failed transcription or a malformed grade is a code on the row; the other half still lands", async () => {
    sttReply = () => new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 });
    let res = await opinionRoute.POST(json("/api/review/opinion", "liz", { id: ID }));
    expect(res.status).toBe(200);
    let patch = updates()[0].args[0] as { opinion: { stt: unknown; grade: unknown; errors: Record<string, string> }; opinion_score: number | null };
    expect(patch.opinion.stt).toBeNull();
    expect(patch.opinion.errors.stt).toBe("http_500");
    expect(patch.opinion.grade).not.toBeNull();
    expect(patch.opinion_score).toBe(0.4);

    ops.length = 0;
    sttReply = () => new Response(JSON.stringify({ text: ALT }), { status: 200 });
    gradeReply = () => new Response(JSON.stringify({ choices: [{ message: { content: "Looks fine to me!" } }] }), { status: 200 });
    res = await opinionRoute.POST(json("/api/review/opinion", "liz", { id: ID }));
    expect(res.status).toBe(200);
    patch = updates()[0].args[0] as typeof patch;
    expect(patch.opinion.grade).toBeNull();
    expect(patch.opinion.errors.grade).toBe("grade_malformed");
    expect(patch.opinion_score).toBe(0.9);

    ops.length = 0;
    sttReply = () => new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 });
    res = await opinionRoute.POST(json("/api/review/opinion", "liz", { id: ID }));
    expect(res.status).toBe(200);
    patch = updates()[0].args[0] as typeof patch;
    expect(patch.opinion_score).toBeNull();
  });

  it("a bad id is 400, a turn that is gone is 404", async () => {
    expect((await opinionRoute.POST(json("/api/review/opinion", "tom", { id: "nope" }))).status).toBe(400);
    rows = [];
    expect((await opinionRoute.POST(json("/api/review/opinion", "tom", { id: ID }))).status).toBe(404);
    expect(openai).toHaveLength(0);
  });

  it("check all refuses anything wider than one day, and takes only the unreviewed, capped per click", async () => {
    const wide = { from: "2026-11-01T07:00:00.000Z", to: "2026-11-05T07:00:00.000Z" };
    expect((await batchRoute.POST(json("/api/review/opinion/batch", "tom", wide))).status).toBe(400);
    expect((await batchRoute.POST(json("/api/review/opinion/batch", "tom", { from: "x" }))).status).toBe(400);
    expect(openai).toHaveLength(0);

    process.env.TAOS_REVIEW_BATCH_MAX = "2";
    rows = [row(), row({ id: ID2 }), row({ id: ID3, opinion_at: "2026-11-04T19:00:00.000Z", opinion_score: 1 }), row({ id: "44444444-2222-4333-8444-555555555555" })];
    const day = { from: "2026-11-04T07:00:00.000Z", to: "2026-11-05T07:00:00.000Z" };
    const res = await batchRoute.POST(json("/api/review/opinion/batch", "tom", { ...day, speaker: TOM }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ checked: 2, failed: 0, more: true, max: 2 });
    expect(ops.some((o) => o.name === store.REVIEW_TABLE && o.method === "is" && o.args[0] === "opinion_at" && o.args[1] === null)).toBe(true);
    expect(ops.some((o) => o.name === store.REVIEW_TABLE && o.method === "gte" && o.args[1] === day.from)).toBe(true);
    expect(ops.some((o) => o.name === store.REVIEW_TABLE && o.method === "eq" && o.args[0] === "user_id" && o.args[1] === TOM)).toBe(true);
    expect(sttCalls()).toHaveLength(2);
    expect(gradeCalls()).toHaveLength(2);
    expect(updates()).toHaveLength(2);
  });
});

// ── 6. The nightly pass ────────────────────────────────────────────────────
describe("the nightly pass: off by default, cron only", () => {
  const cron = (): NextRequest =>
    new NextRequest("https://taos.test/api/walkie/sweep", { method: "GET", headers: { authorization: "Bearer cron-secret" } });

  it("the cron sweep checks nothing unless TAOS_REVIEW_NIGHTLY=1", async () => {
    process.env.CRON_SECRET = "cron-secret";
    rows = [row(), row({ id: ID2 })];
    await walkieSweep.GET(cron());
    expect(openai).toHaveLength(0);
    expect(logs.some((l) => l.includes("[taos-review] nightly"))).toBe(false);
  });

  it("with the flag on, the cron pass checks the last day's unreviewed turns and logs counts", async () => {
    process.env.CRON_SECRET = "cron-secret";
    process.env.TAOS_REVIEW_NIGHTLY = "1";
    rows = [row(), row({ id: ID2 }), row({ id: ID3, opinion_at: "2026-11-04T19:00:00.000Z", opinion_score: 1 })];
    await walkieSweep.GET(cron());
    expect(sttCalls()).toHaveLength(2);
    expect(gradeCalls()).toHaveLength(2);
    expect(logs.some((l) => /^\[taos-review\] nightly checked=2 failed=0 more=0 key=1$/.test(l))).toBe(true);
  });

  it("a founder calling the sweep by hand never triggers it, flag or no flag", async () => {
    process.env.TAOS_REVIEW_NIGHTLY = "1";
    rows = [row()];
    await walkieSweep.GET(json("/api/walkie/sweep", "tom", undefined, "GET"));
    expect(openai).toHaveLength(0);
  });
});

// ── 7. Privacy and the human flag ──────────────────────────────────────────
describe("privacy, and a grader never flags", () => {
  it("no [taos-review] line carries the transcript, the translation, the alt transcript or a user id", async () => {
    await opinionRoute.POST(json("/api/review/opinion", "tom", { id: ID }));
    const lines = logs.filter((l) => l.includes("[taos-review]"));
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const line of lines) {
      expect(line).not.toContain(TRANSCRIPT);
      expect(line).not.toContain(TRANSLATION);
      expect(line).not.toContain(ALT);
      expect(line).not.toContain("insurance");
      expect(line).not.toContain(TOM);
      expect(line).not.toContain("gmail");
    }
    expect(lines.some((l) => /^\[taos-review\] opinion stt=whisper-1 grader=\S+ agreement=0\.9 meaning=2 tone=4 issues=1 score=0\.4 err_stt=- err_grade=- ms=\d+$/.test(l))).toBe(true);
  });

  it("the save path cannot write a flag, and the panel draws no flag button", () => {
    const src = readFileSync(new URL("../lib/review/store.ts", import.meta.url), "utf8");
    const start = src.indexOf("export async function saveReviewOpinion");
    const save = src.slice(start, src.indexOf("export async function", start + 1));
    expect(save).toContain("opinion_score");
    expect(save).not.toMatch(/flag_reason|flag_note|flagged_at|flagged_by/);
    const panel = readFileSync(new URL("../components/review/SecondOpinion.tsx", import.meta.url), "utf8");
    expect(panel).not.toMatch(/data-review-flag|\/api\/review\/flag/);
    const shell = readFileSync(new URL("../components/review/ReviewShell.tsx", import.meta.url), "utf8");
    expect(shell).toContain("data-review-opinion-one");
    expect(shell).toContain("data-review-opinion-all");
    expect(shell).toContain("data-review-suspects-first");
  });

  it("the migration adds three nullable columns and no policy", () => {
    const sql = readFileSync(new URL("../supabase/migrations/20261105_review_second_opinion.sql", import.meta.url), "utf8");
    expect(sql).toContain("add column if not exists opinion       jsonb");
    expect(sql).toContain("opinion_score real");
    expect(sql).toContain("opinion_at    timestamptz");
    expect(sql).not.toMatch(/create policy|not null/i);
  });

  it("every second-opinion string has its own Spanish, marked pending Liz's review", () => {
    const keys = Object.keys(ENGLISH).filter((k) => /^(reviewOpinion|reviewSuspects|reviewIssue)/.test(k));
    expect(keys.length).toBeGreaterThanOrEqual(25);
    const es = copyFor("es");
    for (const key of keys) expect(es[key as keyof typeof ENGLISH], key).not.toBe(ENGLISH[key as keyof typeof ENGLISH]);
    const src = readFileSync(new URL("../lib/chrome/copy.ts", import.meta.url), "utf8");
    const esStart = src.indexOf("  es: {");
    const esEnd = src.indexOf("\n  },", esStart);
    const lines = src.slice(esStart, esEnd).split("\n").filter((l) => /^\s+(reviewOpinion|reviewSuspects|reviewIssue)[A-Za-z]*:/.test(l));
    expect(lines).toHaveLength(keys.length);
    for (const line of lines) expect(line, line).toContain("pendiente de revisión por Liz");
  });
});
