// The monthly cap on paid lesson generation, pinned (2026-10-04).
//
// Tom's decision, from the #79 route audit: POST /api/tutor/lesson and
// POST /api/study/lesson are capped per user per calendar month, founders are
// exempt (the tutor meter's rule), Study's `force: true` counts, and a cache
// hit does not. GET /api/tutor/lessons stays public and is NOT capped — that
// one is pinned at the bottom, because re-gating it is the obvious mistake.
//
// Both REAL route handlers run here. What is faked is the far side: the
// session, the caches, the provider, and the ledger RPC. The ledger fake does
// what lesson_generation_reserve() does (count metered rows this month,
// refuse at the cap, record founders unmetered) — it drives the ORDER the
// routes do things in; it is not the proof the plpgsql is right.
//
// Every refusal also asserts the provider was never reached. A 429 sent after
// paying OpenAI is the same bill with better manners.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { LESSON_CAP_CODE, LESSON_CAP_DEFAULTS, lessonCapMessage } from "@/lib/lessonCap";

// ── The ledger ──────────────────────────────────────────────────────────────
interface LedgerRow {
  id: string;
  user_id: string;
  kind: string;
  metered: boolean;
}
const ledger: LedgerRow[] = [];
let ledgerFails = false;

const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
  if (ledgerFails) return { data: null, error: { message: "boom" } };
  if (name === "lesson_generation_reserve") {
    const used = ledger.filter((r) => r.user_id === args.p_user_id && r.kind === args.p_kind && r.metered).length;
    if (!args.p_unlimited && used >= Number(args.p_cap)) {
      return { data: { ok: false, used, cap: args.p_cap }, error: null };
    }
    const id = `g${ledger.length + 1}`;
    ledger.push({ id, user_id: String(args.p_user_id), kind: String(args.p_kind), metered: !args.p_unlimited });
    return { data: { ok: true, id, used: used + (args.p_unlimited ? 0 : 1), cap: args.p_cap }, error: null };
  }
  if (name === "lesson_generation_release") {
    const i = ledger.findIndex((r) => r.id === args.p_id && r.user_id === args.p_user_id);
    if (i >= 0) ledger.splice(i, 1);
    return { data: null, error: null };
  }
  throw new Error(`unexpected rpc ${name}`);
});

vi.mock("@/lib/supabaseAdmin", () => ({
  hasServiceRoleKey: true,
  supabaseAdmin: { rpc: (name: string, args: Record<string, unknown>) => rpc(name, args) }
}));

// ── The session ─────────────────────────────────────────────────────────────
let caller: { id: string; email: string } | null = null;
vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async () => caller
}));

// ── The caches ──────────────────────────────────────────────────────────────
const tutorCache = new Map<string, unknown>();
vi.mock("@/lib/tutor/lessonStore", () => ({
  readCachedLesson: async (key: string) => (tutorCache.has(key) ? { lesson: tutorCache.get(key), hit: "database" } : null),
  writeCachedLesson: async (key: string, lesson: unknown) => {
    tutorCache.set(key, lesson);
  }
}));

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const studySaved = new Map<string, { id: string; lesson: unknown; model: string }>();
vi.mock("@/lib/study/lessonStore", () => ({
  readOwnSources: async (_userId: string, ids: string[]) =>
    ids.includes(SOURCE_ID)
      ? [
          {
            id: SOURCE_ID,
            created_at: "2026-10-02T00:00:00Z",
            session_id: null,
            source_lang: "en",
            target_lang: "es",
            original_text: "Where is the station?",
            translation_text: "¿Dónde está la estación?"
          }
        ]
      : [],
  readContext: async () => [],
  readStudyLesson: async (userId: string, key: string) => {
    const row = studySaved.get(`${userId}:${key}`);
    return row ? { ...row, lesson_key: key } : null;
  },
  writeStudyLesson: async (input: { userId: string; key: string; lesson: unknown; model: string }) => {
    const id = `s-${input.key}`;
    studySaved.set(`${input.userId}:${input.key}`, { id, lesson: input.lesson, model: input.model });
    return { id };
  }
}));

// ── The provider ────────────────────────────────────────────────────────────
// The parsers are proved elsewhere (tutor-lesson, study-lesson); here they are
// stubbed so a fixture's shape cannot fail a test about counting.
vi.mock("@/lib/tutor/lesson", async (orig) => {
  const actual = await orig<typeof import("@/lib/tutor/lesson")>();
  return {
    ...actual,
    parseLesson: (_content: string, ctx: { module: { id: string }; target: string; learner: string }) => ({
      moduleId: ctx.module.id,
      target: ctx.target,
      learner: ctx.learner
    })
  };
});
const studyGenerate = vi.fn(async () => ({ lesson: { sentences: [{ text: "hola" }] }, usage: null }));
vi.mock("@/lib/study/lesson", async (orig) => {
  const actual = await orig<typeof import("@/lib/study/lesson")>();
  return { ...actual, generateStudyLesson: () => studyGenerate() };
});

const fetchSpy = vi.fn(
  async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })
);
const ORIGINAL_FETCH = globalThis.fetch;

const STRANGER = { id: "u-free", email: "stranger@example.com" };
const LIZ = { id: "u-liz", email: "lizmariett@gmail.com" };

function post(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
    body: JSON.stringify(body)
  });
}

async function tutorLesson(moduleId: string, target = "es") {
  const { POST } = await import("@/app/api/tutor/lesson/route");
  return POST(post("/api/tutor/lesson", { moduleId, target, learner: "en" }));
}

async function studyLesson(extra: Record<string, unknown> = {}) {
  const { POST } = await import("@/app/api/study/lesson/route");
  return POST(post("/api/study/lesson", { ids: [SOURCE_ID], target: "es", explain: "en", ...extra }));
}

function fillLedger(userId: string, kind: "tutor" | "study", n: number) {
  for (let i = 0; i < n; i++) ledger.push({ id: `pre-${kind}-${i}`, user_id: userId, kind, metered: true });
}

beforeEach(() => {
  ledger.length = 0;
  ledgerFails = false;
  tutorCache.clear();
  studySaved.clear();
  rpc.mockClear();
  fetchSpy.mockClear();
  studyGenerate.mockClear();
  caller = STRANGER;
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.NEXT_PUBLIC_ENABLE_TUTOR = "1";
  process.env.NEXT_PUBLIC_ENABLE_STUDY = "1";
  delete process.env.TAOS_TUTOR_LESSON_CAP;
  delete process.env.TAOS_STUDY_LESSON_CAP;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  delete process.env.NEXT_PUBLIC_ENABLE_TUTOR;
  delete process.env.NEXT_PUBLIC_ENABLE_STUDY;
});

const TUTOR_MODULE = "needs-wants";

describe("the numbers", () => {
  it("are the ones derived from production usage on 2026-10-04", () => {
    // Tom's and Liz's busiest real month: ~5 Study generations each, 13 tutor
    // lessons across EVERY user since launch. Raising these is fine; lowering
    // them toward real usage needs Tom.
    expect(LESSON_CAP_DEFAULTS).toEqual({ tutor: 30, study: 60 });
  });
});

describe("POST /api/tutor/lesson", () => {
  it("lets a free user under the cap generate, and counts it", async () => {
    fillLedger(STRANGER.id, "tutor", LESSON_CAP_DEFAULTS.tutor - 1);
    const res = await tutorLesson(TUTOR_MODULE);
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(ledger.filter((r) => r.user_id === STRANGER.id).length).toBe(LESSON_CAP_DEFAULTS.tutor);
  });

  it("refuses a free user at the cap with a 429 the screen can show, and never calls the provider", async () => {
    fillLedger(STRANGER.id, "tutor", LESSON_CAP_DEFAULTS.tutor);
    const res = await tutorLesson(TUTOR_MODULE);
    expect(res.status).toBe(429);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe(LESSON_CAP_CODE);
    expect(body.error).toBe(lessonCapMessage("tutor", LESSON_CAP_DEFAULTS.tutor));
    // ModulesShell shows `details || error` — a details field would hide the message.
    expect(body.details).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("serves a cache hit to a capped user without counting it", async () => {
    await tutorLesson(TUTOR_MODULE); // someone pays for it once
    caller = { id: "u-other", email: "other@example.com" };
    fillLedger("u-other", "tutor", LESSON_CAP_DEFAULTS.tutor);
    fetchSpy.mockClear();
    rpc.mockClear();
    const res = await tutorLesson(TUTOR_MODULE);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { cached: boolean }).cached).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("does not cap a founder, but still records the generation unmetered", async () => {
    caller = LIZ;
    fillLedger(LIZ.id, "tutor", LESSON_CAP_DEFAULTS.tutor + 5);
    const res = await tutorLesson(TUTOR_MODULE);
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(ledger.filter((r) => r.user_id === LIZ.id && !r.metered).length).toBe(1);
  });

  it("hands the reservation back when the provider fails", async () => {
    fetchSpy.mockImplementationOnce(async () => new Response("{}", { status: 500 }));
    const res = await tutorLesson(TUTOR_MODULE);
    expect(res.status).toBe(502);
    expect(ledger.length).toBe(0);
  });

  it("refuses with a 503, and spends nothing, when the cap cannot be checked", async () => {
    ledgerFails = true;
    const res = await tutorLesson(TUTOR_MODULE);
    expect(res.status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("POST /api/study/lesson", () => {
  it("lets a free user under the cap generate, and counts it", async () => {
    fillLedger(STRANGER.id, "study", LESSON_CAP_DEFAULTS.study - 1);
    const res = await studyLesson();
    expect(res.status).toBe(200);
    expect(studyGenerate).toHaveBeenCalledTimes(1);
    expect(ledger.filter((r) => r.kind === "study").length).toBe(LESSON_CAP_DEFAULTS.study);
  });

  it("refuses a free user at the cap with a 429 the screen can show, and never calls the provider", async () => {
    fillLedger(STRANGER.id, "study", LESSON_CAP_DEFAULTS.study);
    const res = await studyLesson();
    expect(res.status).toBe(429);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe(LESSON_CAP_CODE);
    expect(body.error).toBe(lessonCapMessage("study", LESSON_CAP_DEFAULTS.study));
    expect(studyGenerate).not.toHaveBeenCalled();
  });

  it("counts every force: true as a paid generation — the hole this closes", async () => {
    process.env.TAOS_STUDY_LESSON_CAP = "3";
    expect((await studyLesson()).status).toBe(200);
    expect((await studyLesson({ force: true })).status).toBe(200);
    expect((await studyLesson({ force: true })).status).toBe(200);
    expect(ledger.length).toBe(3);
    const fourth = await studyLesson({ force: true });
    expect(fourth.status).toBe(429);
    expect(studyGenerate).toHaveBeenCalledTimes(3);
  });

  it("serves a saved lesson to a capped user without counting it", async () => {
    process.env.TAOS_STUDY_LESSON_CAP = "1";
    expect((await studyLesson()).status).toBe(200);
    rpc.mockClear();
    const again = await studyLesson();
    expect(again.status).toBe(200);
    expect(((await again.json()) as { cached: boolean }).cached).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
    expect(studyGenerate).toHaveBeenCalledTimes(1);
  });

  it("does not cap a founder, forced or not", async () => {
    caller = LIZ;
    fillLedger(LIZ.id, "study", LESSON_CAP_DEFAULTS.study + 5);
    expect((await studyLesson()).status).toBe(200);
    expect((await studyLesson({ force: true })).status).toBe(200);
    expect(studyGenerate).toHaveBeenCalledTimes(2);
    expect(ledger.filter((r) => r.user_id === LIZ.id && !r.metered).length).toBe(2);
  });

  it("keeps the two caps separate", async () => {
    fillLedger(STRANGER.id, "tutor", LESSON_CAP_DEFAULTS.tutor);
    expect((await studyLesson()).status).toBe(200);
  });
});

describe("GET /api/tutor/lessons stays public (Tom, 2026-10-04)", () => {
  it("is not capped and asks for no session", () => {
    const src = readFileSync("app/api/tutor/lessons/route.ts", "utf8");
    expect(src).not.toMatch(/lessonCap|guardSpend|getUserFromRequest/);
  });
});
