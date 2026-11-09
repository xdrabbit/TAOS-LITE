// Redo · Rehacer (2026-11-05): POST /api/review/redo runs a KEPT clip through
// the fallback transcriber and the same translation, and stores the result
// beside the first one. Pins:
//
//   1. the door: 401 bare, 404 for a signed-in stranger (lib/review/guard.ts)
//   2. every Redo stores a before/after pair: the row's first result is
//      untouched and the redo lands in `redo` with model, hint, both texts
//   3. the hint: an auto turn → the pair's other language (target_lang);
//      a manual turn → its source language; whisper gets `language`, no prompt
//   4. a gone turn is a 404; a store failure is a 502
//   5. the log line is counts and codes, never text
//
// OpenAI is a fetch mock by URL; the store is mocked at the module.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { ReviewRedo, ReviewTurnRow } from "@/lib/review/store";

vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async (req: Request) => {
    const auth = req.headers.get("authorization") ?? "";
    if (auth === "Bearer tom") return { id: "aaaaaaaa-0000-4000-8000-00000000000a", email: ["xdrabbit", "gmail.com"].join("@") };
    if (auth === "Bearer stranger") return { id: "cccccccc-0000-4000-8000-00000000000c", email: "someone@example.com" };
    return null;
  }
}));

const FIRST = "And you know, if I beat you.";
const SECOND = "Y sabes, si te gano, vamos a tener que hablar de la cuenta de la casa.";
const TRANSLATION = "And you know, if I beat you, we will have to talk about the house bill.";

const store = vi.hoisted(() => ({
  turn: null as ReviewTurnRow | null,
  readError: false,
  saveError: false,
  saved: [] as Array<{ id: string; redo: ReviewRedo }>
}));
vi.mock("@/lib/review/store", () => ({
  ReviewStoreError: class extends Error {
    constructor(
      message: string,
      public readonly code: string
    ) {
      super(message);
    }
  },
  readReviewTurn: async (id: string) => {
    if (store.readError) throw Object.assign(new Error("db"), { code: "read_failed" });
    return store.turn && store.turn.id === id ? store.turn : null;
  },
  downloadReviewAudio: async () => new Uint8Array([1, 2, 3, 4, 5]),
  saveReviewRedo: async (id: string, redo: ReviewRedo) => {
    if (store.saveError) throw new Error("db");
    store.saved.push({ id, redo });
    return store.turn ? { ...store.turn, redo, redo_at: redo.at } : null;
  }
}));

// No ffmpeg on this path: the clip is five bytes.
vi.mock("@/lib/translate/normalize", () => ({
  sttNormalizeEnabled: () => false,
  normalizeForStt: async () => null
}));

const openai: Array<{ url: string; form?: FormData; body?: string }> = [];
function installFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/v1/audio/transcriptions")) {
        openai.push({ url, form: init?.body as FormData });
        return new Response(JSON.stringify({ text: SECOND }), { status: 200 });
      }
      if (url.includes("/v1/chat/completions")) {
        const body = String(init?.body);
        openai.push({ url, body });
        const content = body.includes("json_object") ? JSON.stringify({ source_lang: "es", translation: TRANSLATION }) : TRANSLATION;
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    })
  );
}

const ID = "11111111-2222-4333-8444-555555555555";
function row(over: Partial<ReviewTurnRow> = {}): ReviewTurnRow {
  return {
    id: ID,
    user_id: "aaaaaaaa-0000-4000-8000-00000000000a",
    surface: "home",
    mode: "auto",
    source_lang: "en",
    target_lang: "es",
    original_text: FIRST,
    translation_text: "Y sabes, si te gano.",
    segments: null,
    audio_path: `aaaaaaaa-0000-4000-8000-00000000000a/${ID}.webm`,
    audio_mime: "audio/webm",
    audio_bytes: 442943,
    rec_ms: 69000,
    transcribe_model: "gpt-4o-mini-transcribe",
    translate_model: "gpt-4.1",
    timings: { transcribe_ms: 2632, translate_ms: 851, total_ms: 3649 },
    flag_reason: "other",
    flag_note: "",
    flagged_at: null,
    flagged_by: null,
    opinion: null,
    opinion_score: null,
    opinion_at: null,
    redo: null,
    redo_at: null,
    created_at: "2026-11-06T02:24:46.000Z",
    expires_at: "2026-11-20T02:24:46.000Z",
    ...over
  };
}

function redoRequest(auth: string | undefined, id: unknown = ID): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) headers.authorization = `Bearer ${auth}`;
  return new NextRequest("https://taos.test/api/review/redo", { method: "POST", headers, body: JSON.stringify({ id }) });
}

const { POST } = await import("@/app/api/review/redo/route");
const { redoHintFor } = await import("@/lib/translate/shortTranscript");

let logs: string[];
beforeEach(() => {
  process.env.OPENAI_API_KEY = "sk-test";
  delete process.env.TAOS_TRANSCRIBE_FALLBACK_MODEL;
  store.turn = row();
  store.readError = false;
  store.saveError = false;
  store.saved.length = 0;
  openai.length = 0;
  installFetch();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the door", () => {
  it("401 bare, 404 for a stranger, 400 without a turn id", async () => {
    expect((await POST(redoRequest(undefined))).status).toBe(401);
    expect((await POST(redoRequest("stranger"))).status).toBe(404);
    expect((await POST(redoRequest("tom", "nope"))).status).toBe(400);
    expect(openai).toHaveLength(0);
    expect(store.saved).toHaveLength(0);
  });
});

describe("the pair", () => {
  it("stores the redo beside the first result: both texts, the model, the hint", async () => {
    const res = await POST(redoRequest("tom"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { turn: ReviewTurnRow };
    expect(store.saved).toHaveLength(1);
    const { id, redo } = store.saved[0];
    expect(id).toBe(ID);
    expect(redo).toMatchObject({
      model: "whisper-1",
      language_hint: "es",
      original_text: SECOND,
      translation_text: TRANSLATION,
      source_lang: "es",
      target_lang: "en",
      norm_gain_db: null
    });
    expect(redo.timings.transcribe_ms).toBeGreaterThanOrEqual(0);
    expect(redo.timings.total_ms).toBeGreaterThanOrEqual(redo.timings.transcribe_ms ?? 0);
    // The first result is the row's own and is not what was written.
    expect(body.turn.original_text).toBe(FIRST);
    expect(body.turn.redo?.original_text).toBe(SECOND);
    expect(openai.map((o) => (o.url.includes("transcriptions") ? "stt" : "chat"))).toEqual(["stt", "chat"]);
  });

  it("the whisper retry sends the language field and no prompt", async () => {
    await POST(redoRequest("tom"));
    const form = openai[0].form!;
    expect(form.get("model")).toBe("whisper-1");
    expect(form.get("language")).toBe("es");
    expect(form.get("prompt")).toBeNull();
  });

  it("a gpt-4o fallback sends the language field AND the spoken-language prompt", async () => {
    process.env.TAOS_TRANSCRIBE_FALLBACK_MODEL = "gpt-4o-transcribe";
    await POST(redoRequest("tom"));
    const form = openai[0].form!;
    expect(form.get("model")).toBe("gpt-4o-transcribe");
    expect(form.get("language")).toBe("es");
    expect(String(form.get("prompt"))).toContain("Spoken Spanish");
  });

  it("the hint: auto → the other language; manual → the known one", () => {
    expect(redoHintFor({ mode: "auto", source_lang: "en", target_lang: "es" })).toEqual({ code: "es", label: "Spanish" });
    expect(redoHintFor({ mode: "manual", source_lang: "es", target_lang: "en" })).toEqual({ code: "es", label: "Spanish" });
    expect(redoHintFor({ mode: "manual", source_lang: "xx", target_lang: "en" })).toBeNull();
  });

  it("a manual turn is translated with the one-direction prompt", async () => {
    store.turn = row({ mode: "manual", source_lang: "es", target_lang: "en" });
    await POST(redoRequest("tom"));
    expect(store.saved[0].redo).toMatchObject({ language_hint: "es", source_lang: "es", target_lang: "en", translation_text: TRANSLATION });
    expect(openai[1].body).not.toContain("json_object");
  });
});

describe("failure", () => {
  it("a gone turn is a 404 and nothing is spent", async () => {
    store.turn = null;
    expect((await POST(redoRequest("tom"))).status).toBe(404);
    expect(openai).toHaveLength(0);
  });

  it("a store failure is a 502 with a code in the log", async () => {
    store.saveError = true;
    expect((await POST(redoRequest("tom"))).status).toBe(502);
    expect(logs.some((l) => /^\[taos-review\] redo_failed code=\S+$/.test(l))).toBe(true);
  });
});

describe("the log", () => {
  it("counts and codes, never text", async () => {
    await POST(redoRequest("tom"));
    const line = logs.find((l) => l.startsWith("[taos-review] redo "));
    expect(line).toMatch(
      /^\[taos-review\] redo mode=auto model=whisper-1 hint=es words1=7 words2=\d+ norm_gain_db=\? translate_model=\S+ ms=\d+$/
    );
    const all = logs.join("\n");
    expect(all).not.toContain("beat");
    expect(all).not.toContain("gano");
    expect(all).not.toContain("gmail");
  });
});

// ── The two buttons, by source ─────────────────────────────────────────────
// jsdom cannot sign in to home or /review; these read the components the way
// tests/home-labels-one-language.test.ts does, and pin where Redo may appear.
describe("where Redo appears", () => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const home = readFileSync(new URL("../components/TranslatorShell.tsx", import.meta.url), "utf8");
  const review = readFileSync(new URL("../components/review/ReviewShell.tsx", import.meta.url), "utf8");
  const copy = readFileSync(new URL("../lib/chrome/copy.ts", import.meta.url), "utf8");

  it("home: only a turn the server kept, and only for a founder", () => {
    expect(home).toMatch(/setReviewId\(typeof payload\.reviewId === "string" && founder \? payload\.reviewId : null\)/);
    expect(home).toMatch(/\{reviewId \? \(\s*<button[^>]*data-redo-button/);
    expect(home).toContain('form.append("rec_ms"');
    expect(home).toContain('fetch("/api/review/redo"');
  });

  it("/review: every row has the button and shows the pair when there is one", () => {
    expect(review).toContain("data-review-redo-button");
    expect(review).toContain("turn.redo.original_text");
    expect(review).toContain("turn.redo.translation_text");
    expect(review).toContain('fetch("/api/review/redo"');
  });

  it("the words come from the copy table, Spanish pending Liz", () => {
    expect(copy).toMatch(/\n  redo: "Redo",/);
    expect(copy).toMatch(/\n    redo: "Rehacer", \/\/ pendiente de revisión por Liz/);
    expect(home).not.toContain('"Rehacer"');
    expect(review).not.toContain('"Rehacer"');
  });
});
