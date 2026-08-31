// The mic on /fast — what it costs, what it is allowed to do, and where the
// words it produces end up.
//
// /fast is a TYPING screen with a mic on it, and that ordering is the whole
// design. Dictation does not produce a translation; it produces text in an
// input box, which the screen's existing two clocks then translate and bill
// exactly as if it had been typed (lib/fast/settle.ts). Four things have to
// stay true for that to hold, and each of them is a way this could have
// shipped wrong:
//
//   1. speaking is gated exactly as typing is — a founders-only screen with a
//      mic anyone can reach is not a founders-only screen;
//   2. speaking is METERED as typing is, against the SAME per-minute buckets,
//      because a mic with its own counter is a second way to spend on /fast
//      that the /fast ceiling cannot see — and it is the pricier call;
//   3. the route transcribes and STOPS. Reaching for /api/translate instead
//      would have bought a gpt-4.1 paraphrase per dictation, in the house
//      register /fast deliberately does not use, only to throw it away;
//   4. one spoken quickie still bills ONE row, because the billing key is the
//      settled text and knows nothing about how the text arrived.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { billingKey } from "@/lib/fast/settle";
import {
  dictationHintFor,
  FAST_MAX_DICTATION_BYTES,
  FAST_MAX_DICTATION_MS,
  FAST_MIN_DICTATION_MS
} from "@/lib/fast/dictation";
import { CANTONESE_STT_HINT, STT_NO_GUESS_RULE } from "@/lib/translate/prompts";

let caller: { id: string; email: string } | null = null;

vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async (req: Request) => {
    const header = req.headers.get("authorization") ?? "";
    return header.startsWith("Bearer ") && caller ? caller : null;
  }
}));

/** Stands in for OpenAI. Records every call so the assertions can ask which
 *  endpoint was reached, and with what prompt. */
const calls: { url: string; body: unknown }[] = [];
let transcript = "where is the pharmacy";

const fetchSpy = vi.fn(async (url: unknown, init?: RequestInit) => {
  const href = String(url);
  calls.push({ url: href, body: init?.body });
  if (href.includes("/audio/transcriptions")) {
    return new Response(JSON.stringify({ text: transcript }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
  return new Response(JSON.stringify({ choices: [{ message: { content: "hola" } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
});

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_KEY = process.env.OPENAI_API_KEY;
const ORIGINAL_FLAG = process.env.NEXT_PUBLIC_ENABLE_FAST;

beforeEach(async () => {
  caller = null;
  transcript = "where is the pharmacy";
  calls.length = 0;
  fetchSpy.mockClear();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  process.env.OPENAI_API_KEY = "sk-test";
  delete process.env.NEXT_PUBLIC_ENABLE_FAST;
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

/** A recording, the shape FastShell uploads: a named File in a FormData. */
function dictation(
  { bytes = 4096, pair = ["en", "es"] }: { bytes?: number; pair?: [string, string] } = {}
): FormData {
  const form = new FormData();
  form.append("audio", new File([new Uint8Array(bytes)], "quickie.webm", { type: "audio/webm" }));
  form.append("pairA", pair[0]);
  form.append("pairB", pair[1]);
  return form;
}

function listenRequest(form: FormData, token?: string): NextRequest {
  return new NextRequest("https://taoslite.com/api/fast/listen", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form
  });
}

async function listen(form = dictation(), token?: string) {
  const { POST } = await import("@/app/api/fast/listen/route");
  return POST(listenRequest(form, token));
}

const routeSource = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("POST /api/fast/listen — who may speak into it", () => {
  it("404s a signed-out stranger without touching a provider", async () => {
    const res = await listen();
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("404s a signed-in customer without touching a provider", async () => {
    caller = { id: "u1", email: "stranger@example.com" };
    const res = await listen(dictation(), "token");
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("transcribes for a founder", async () => {
    caller = { id: "u2", email: "xdrabbit@gmail.com" };
    const res = await listen(dictation(), "token");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "where is the pharmacy" });
  });

  it("opens to everyone on the same flag the typing does", async () => {
    // One env var opens the screen, the translate route and the mic together.
    // A mic that needed a second flag is a mic that ships dark by accident.
    process.env.NEXT_PUBLIC_ENABLE_FAST = "1";
    caller = { id: "u3", email: "stranger@example.com" };
    expect((await listen(dictation(), "token")).status).toBe(200);
  });

  it("identifies the caller before it reads the upload", async () => {
    // The ordering that makes the 404 free, and here it matters more than it
    // does next door: the body this refuses to read is an audio file.
    const src = routeSource("app/api/fast/listen/route.ts");
    const guard = src.indexOf("await guardSpend(req)");
    const gate = src.indexOf("fastVisibleTo(email)");
    // The STATEMENT, not the word: the header comment above says why the
    // buckets are shared, and it says it before any of this runs.
    const rate = src.indexOf("const rate = checkFastRate(");
    const body = src.indexOf("await req.formData()");
    expect(guard).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(guard);
    expect(rate).toBeGreaterThan(gate);
    expect(body).toBeGreaterThan(rate);
  });
});

describe("the mic spends against the SAME meter as the keyboard", () => {
  beforeEach(() => {
    caller = { id: "founder-1", email: "xdrabbit@gmail.com" };
  });

  it("counts a dictation against /fast's per-minute ceiling", async () => {
    // Sixty of anything, then a refusal. The number is checkFastRate's, and
    // this route reads the same buckets rather than a private copy.
    const statuses: number[] = [];
    for (let i = 0; i < 62; i += 1) statuses.push((await listen(dictation(), "t")).status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(60);
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);
  });

  it("shares one budget with typing — speaking does not top it up", async () => {
    // The bug this forbids: 60 typed quickies AND 60 spoken ones in the same
    // minute, because each route counted only itself.
    const { POST: translatePost } = await import("@/app/api/fast/route");
    const type = (text: string) =>
      translatePost(
        new NextRequest("https://taoslite.com/api/fast", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
          body: JSON.stringify({ text, sourceLanguage: "en", targetLanguage: "es" })
        })
      );

    for (let i = 0; i < 30; i += 1) expect((await type(`q${i}`)).status).toBe(200);
    for (let i = 0; i < 30; i += 1) expect((await listen(dictation(), "t")).status).toBe(200);
    // Sixty served between them. The sixty-first is refused whichever door it
    // comes through.
    expect((await listen(dictation(), "t")).status).toBe(429);
    expect((await type("one more")).status).toBe(429);
  });

  it("refuses before the upload is read, so a big one costs nothing", async () => {
    for (let i = 0; i < 60; i += 1) await listen(dictation(), "t");
    calls.length = 0;
    const res = await listen(dictation({ bytes: 1_000_000 }), "t");
    expect(res.status).toBe(429);
    expect(calls).toHaveLength(0);
  });
});

describe("what the route does with the audio", () => {
  beforeEach(() => {
    caller = { id: "founder-1", email: "xdrabbit@gmail.com" };
  });

  it("transcribes and STOPS — no paraphrase is bought and thrown away", async () => {
    // The reason this route exists instead of a call to /api/translate. That
    // one transcribes AND paraphrases; /fast would discard the paraphrase,
    // having paid for it in the wrong register.
    await listen(dictation(), "t");
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.openai.com/v1/audio/transcriptions"
    ]);
  });

  it("asks for no language, because the box does not know which one is coming", async () => {
    // Auto-detect, the same as the direction row says. A source hint here
    // would make the mic disagree with the screen it is on.
    await listen(dictation(), "t");
    const form = calls[0].body as FormData;
    expect(String(form.get("prompt"))).not.toContain("Spoken ");
  });

  it("carries the no-guess rule — a dropout is a gap, never an invented word", async () => {
    // Liz, 7/27: a signal dip turned "montar bicicleta" into "montar un
    // caballo". Sharing lib/translate/transcribe.ts is what gets this fence
    // for free; a hand-rolled fourth copy of the fetch would not have it.
    await listen(dictation(), "t");
    expect(String((calls[0].body as FormData).get("prompt"))).toContain(STT_NO_GUESS_RULE);
  });

  it("adds the Cantonese hint when the pair could be Cantonese", async () => {
    await listen(dictation({ pair: ["en", "yue"] }), "t");
    expect(String((calls[0].body as FormData).get("prompt"))).toContain(CANTONESE_STT_HINT);
  });

  it("leaves the hint out when it cannot be", async () => {
    await listen(dictation({ pair: ["en", "es"] }), "t");
    expect(String((calls[0].body as FormData).get("prompt"))).not.toContain(CANTONESE_STT_HINT);
    expect(dictationHintFor(["en", "es"])).toBeUndefined();
  });

  it("answers a silent recording with the retry line, not provider JSON", async () => {
    transcript = "";
    const res = await listen(dictation(), "t");
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain("Nothing was heard");
  });

  it("refuses an oversized upload without paying to find out", async () => {
    const res = await listen(dictation({ bytes: FAST_MAX_DICTATION_BYTES + 1 }), "t");
    expect(res.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it("refuses an empty upload", async () => {
    const form = new FormData();
    form.append("audio", new File([], "quickie.webm", { type: "audio/webm" }));
    expect((await listen(form, "t")).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe("the fences on a spoken quickie", () => {
  it("caps a dictation far below a spoken TURN — this is a phrase, not a story", () => {
    // /api/translate's ceiling is five minutes because somebody there is
    // telling a pharmacist what happened. Nobody speaks 500 characters (the
    // /fast text cap) in thirty seconds, so this is generous for the screen
    // and mean to a pocket-dialled mic.
    expect(FAST_MAX_DICTATION_MS).toBe(30000);
    expect(FAST_MAX_DICTATION_MS).toBeLessThan(300000);
  });

  it("throws away a fumbled tap before it leaves the phone", () => {
    // Sub-second clips carry no usable speech and the shortest ones lack
    // complete container headers, so the provider rejects them as corrupted.
    // Same 600ms as TranslatorShell's MIN_TURN_DURATION_MS.
    expect(FAST_MIN_DICTATION_MS).toBe(600);
    expect(FAST_MIN_DICTATION_MS).toBeLessThan(FAST_MAX_DICTATION_MS);
  });

  it("sizes the byte cap above a full-length recording at the shell's bitrate", () => {
    // 32 kbps for 30s is ~120 KB. The cap is an order of magnitude above that
    // because FAST_MAX_DICTATION_MS is enforced in a browser, and a browser is
    // not where a spend bound belongs.
    const fullLengthBytes = (32000 / 8) * (FAST_MAX_DICTATION_MS / 1000);
    expect(FAST_MAX_DICTATION_BYTES).toBeGreaterThan(fullLengthBytes * 8);
  });
});

describe("transcript → input → translation, and what it bills", () => {
  it("puts the words in the INPUT, not on screen as an answer", () => {
    // The point of dictating into a text field rather than at a translator:
    // the transcript is a draft you can fix. So the shell's dictation handler
    // writes `input` and nothing else — it must not set `translation`, which
    // would put an unedited mis-hearing on screen as a result.
    const shell = routeSource("components/FastShell.tsx");
    const start = shell.indexOf("const receiveDictation");
    const end = shell.indexOf("const dictation = useDictation");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const handler = shell.slice(start, end);
    expect(handler).toContain("setInput(");
    expect(handler).not.toContain("setTranslation(");
  });

  it("bills through the same settle clock as typing — the handler cannot bill", () => {
    // saveTranslation is the row that IS the free monthly allowance
    // (lib/supabase.ts, getMonthlyUsage). It is written by the SETTLE effect,
    // over the settled text, and dictation must reach it only by putting words
    // in the box — never by writing a row of its own, which would bill a
    // transcript nobody had finished editing yet.
    const shell = routeSource("components/FastShell.tsx");
    const start = shell.indexOf("const receiveDictation");
    const end = shell.indexOf("const dictation = useDictation");
    expect(shell.slice(start, end)).not.toContain("saveTranslation");
    expect(shell).toContain("saveTranslation"); // still billed, by the settle effect
    // And the route itself has no idea the allowance exists.
    expect(routeSource("app/api/fast/listen/route.ts")).not.toContain("saveTranslation");
  });

  it("bills a spoken quickie exactly as it bills a typed one — once", () => {
    // The billing key is the settled text and the direction. It knows nothing
    // about how the text arrived, which is the whole reason dictation needed
    // no third clock: speak it, or type it, or speak it and then fix a word —
    // the same phrase in the same direction is one row.
    const spoken = billingKey("where is the pharmacy", "en", "es");
    const typed = billingKey("where is the pharmacy", "en", "es");
    expect(spoken).toBe(typed);

    const billed = new Set<string>();
    const bill = (text: string) => {
      const key = billingKey(text, "en", "es");
      if (billed.has(key)) return false;
      billed.add(key);
      return true;
    };
    expect(bill("where is the pharmacy")).toBe(true); // the transcript settles
    expect(bill("where is the pharmacy")).toBe(false); // a re-render does not
    expect(billed.size).toBe(1);

    // Fixing a mis-heard word IS a second lookup, and honestly so: it is a
    // different phrase, and it is the one the person actually meant.
    expect(bill("where is the pharmacy open")).toBe(true);
    expect(billed.size).toBe(2);
  });

  it("appends to the box rather than replacing what is in it", () => {
    // There is no undo on this screen. Somebody who typed half a phrase and
    // then said the rest has not asked for the typed half to be thrown away.
    const shell = routeSource("components/FastShell.tsx");
    const start = shell.indexOf("const receiveDictation");
    const handler = shell.slice(start, shell.indexOf("const dictation = useDictation"));
    expect(handler).toContain("current.trim()");
    expect(handler).toContain("FAST_MAX_CHARS"); // and still respects the cap
  });

  it("sends the upload without a Content-Type of its own", () => {
    // authHeaders, not jsonAuthHeaders: the browser must set its own multipart
    // boundary, and a Content-Type set here corrupts the body (lib/authClient).
    const shell = routeSource("components/FastShell.tsx");
    const start = shell.indexOf("const receiveDictation");
    const handler = shell.slice(start, shell.indexOf("const dictation = useDictation"));
    expect(handler).toContain("headers: await authHeaders()");
    expect(handler).not.toContain("await jsonAuthHeaders()");
    expect(handler).not.toContain('"Content-Type"');
  });
});

describe("the transcriber is shared, not copied", () => {
  it("is the one /api/translate uses", () => {
    // The extraction that made this feature small. Both routes call the same
    // function, so the STT fences cannot drift apart — and a fifth copy of the
    // transcription fetch is a fifth chance to forget one.
    expect(routeSource("app/api/translate/route.ts")).toContain(
      'from "@/lib/translate/transcribe"'
    );
    expect(routeSource("app/api/fast/listen/route.ts")).toContain(
      'from "@/lib/translate/transcribe"'
    );
    expect(routeSource("app/api/fast/listen/route.ts")).not.toContain(
      "api.openai.com/v1/audio/transcriptions"
    );
  });

  it("waits less on a phrase than /api/translate waits on a five-minute turn", async () => {
    const { TRANSCRIBE_TIMEOUT_MS } = await import("@/lib/translate/transcribe");
    const src = routeSource("app/api/fast/listen/route.ts");
    const listenTimeout = Number(/LISTEN_TIMEOUT_MS = (\d+)/.exec(src)?.[1]);
    expect(listenTimeout).toBeLessThan(TRANSCRIBE_TIMEOUT_MS);
    // And still under this route's own maxDuration, or a stall reaches the
    // phone as Safari's opaque "Load failed" instead of something retryable.
    const maxDuration = Number(/maxDuration = (\d+)/.exec(src)?.[1]);
    expect(listenTimeout).toBeLessThan(maxDuration * 1000);
  });
});
