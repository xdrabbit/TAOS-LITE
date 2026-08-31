// The LIVE mic on /fast — the words that arrive while you are still talking.
//
// The batch mic (tests/fast-dictation.test.ts) pinned four things: speaking is
// gated as typing is, metered as typing is, transcribes and stops, and bills
// one row per settled input. All four still hold, and this file does not
// re-prove them. It pins what STREAMING added, which is a different list:
//
//   1. a hypothesis is never text. Partials are drawn and never committed, so
//      they cannot start the 300ms debounce and cannot reach a paid
//      translator — the one rule that separates a live mic from an expensive
//      one, and the only one that is invisible when it breaks (it does not
//      look wrong on screen, it just costs more);
//   2. no words are ever LOST. A final clears the tail it supersedes, and a
//      stop keeps a tail no final covered, because this screen has no undo;
//   3. the candidate set is the pair plus the pill row, capped at four, and
//      it is null-or-nothing on the pair — a recogniser that can hear one of
//      the two pills would silently mangle every sentence in the other;
//   4. AZURE_SPEECH_KEY never reaches a browser. The socket is opened from a
//      phone, so it gets a ten-minute token and the key stays on the server;
//   5. the fallback is SILENT and it never dead-ends the mic;
//   6. the settled count is untouched — a spoken quickie still bills exactly
//      one row, however many segments it arrived in.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { appendDictated, stepTranscript } from "@/lib/fast/liveTranscript";
import {
  MAX_SPEECH_CANDIDATES,
  SPEECH_LANGUAGE_ID_MODE,
  speechCandidates,
  speechLocale,
  STREAMABLE_LANGUAGES
} from "@/lib/fast/speechLocale";
import {
  AZURE_TOKEN_REFRESH_MS,
  AZURE_TOKEN_TTL_MS,
  FAST_MAX_DICTATION_MS,
  STREAM_CONNECT_MS
} from "@/lib/fast/dictation";
import { assessmentLocale } from "@/lib/tutor/pronunciation";
import { LANGUAGES, type LanguageCode } from "@/lib/languages/catalog";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/**
 * The same file with its line comments stripped.
 *
 * These files EXPLAIN themselves at length, and several of them explain a bug
 * by naming the API that caused it. An assertion that a call is gone has to
 * look at the code and not at the paragraph describing why it went.
 */
const code = (path: string) => source(path).replace(/^\s*\/\/.*$/gm, "");

// ───────────────────────────────────────────────────────────────────────────
// 1. Partials, finals, and the money rule
// ───────────────────────────────────────────────────────────────────────────

describe("stepTranscript — a hypothesis is drawn, never committed", () => {
  it("shows a partial and commits nothing", () => {
    // THE cost fence. /fast translates as you type, so anything that reaches
    // `input` starts a 300ms debounce toward a per-character billed Azure
    // call. Azure re-guesses several times a second; committing those would
    // fire dozens of translations per spoken phrase to render text that was
    // about to be replaced anyway.
    expect(stepTranscript("", { type: "partial", text: "where is" })).toEqual({
      partial: "where is",
      commit: null
    });
  });

  it("replaces one partial with the next rather than accumulating them", () => {
    // Each hypothesis describes the SAME audio re-heard, not new audio. Adding
    // them up would put "where is / where is the / where is the pharmacy" on
    // screen, which is the bug this rule exists to make impossible.
    let step = stepTranscript("", { type: "partial", text: "where is" });
    step = stepTranscript(step.partial, { type: "partial", text: "where is the far" });
    step = stepTranscript(step.partial, { type: "partial", text: "where is the pharmacy" });
    expect(step).toEqual({ partial: "where is the pharmacy", commit: null });
  });

  it("commits on a final and clears the tail in the SAME step", () => {
    // The hypothesis and the final describe one stretch of audio. If the tail
    // outlived the commit by even a render, the phrase would be shown twice.
    expect(stepTranscript("where is the pharm", { type: "final", text: "where is the pharmacy" }))
      .toEqual({ partial: "", commit: "where is the pharmacy" });
  });

  it("ignores an empty or whitespace-only final", () => {
    // Azure emits these for trailing silence.
    expect(stepTranscript("", { type: "final", text: "" }).commit).toBeNull();
    expect(stepTranscript("", { type: "final", text: "   " }).commit).toBeNull();
  });
});

describe("stepTranscript — no words are lost", () => {
  it("keeps a tail that no final covered when the mic stops", () => {
    // Azure normally flushes a final for trailing audio on stop, so this is
    // the safety net for when it does not: a dropped socket on the walk back
    // to the car. A tentative last word that can be edited beats a lost
    // sentence on a screen with no undo.
    expect(stepTranscript("and a receipt", { type: "stop" })).toEqual({
      partial: "",
      commit: "and a receipt"
    });
  });

  it("commits nothing on stop when the last final already covered the tail", () => {
    // The normal path, and the one that must not double-write: `final`
    // cleared the tail, so `stop` finds nothing left to keep.
    const afterFinal = stepTranscript("where is the pharm", {
      type: "final",
      text: "where is the pharmacy"
    });
    expect(afterFinal.partial).toBe("");
    expect(stepTranscript(afterFinal.partial, { type: "stop" }).commit).toBeNull();
  });

  it("discards the tail on cancel, and only cancel discards", () => {
    expect(stepTranscript("half a sentence", { type: "cancel" })).toEqual({
      partial: "",
      commit: null
    });
  });
});

describe("appendDictated — dictation never eats what was typed", () => {
  it("appends to typed text with a single space", () => {
    expect(appendDictated("where is", "the pharmacy", 500)).toBe("where is the pharmacy");
  });

  it("does not lead with a space in an empty box", () => {
    expect(appendDictated("", "hola", 500)).toBe("hola");
  });

  it("leaves the box alone when nothing was heard", () => {
    expect(appendDictated("where is", "   ", 500)).toBe("where is");
  });

  it("caps at the same length the textarea does", () => {
    // Dictation must not be able to put the box in a state typing could not
    // reach — FAST_MAX_CHARS is a bill bound on a per-character engine.
    expect(appendDictated("a".repeat(495), "bbbbbbbbbb", 500)).toHaveLength(500);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. The candidate set
// ───────────────────────────────────────────────────────────────────────────

describe("speechCandidates — who Azure is told to listen for", () => {
  it("asks Azure to choose between the two pills, and nothing else", () => {
    expect(speechCandidates(["en", "es"], null)).toEqual(["en-US", "es-MX"]);
  });

  it("never asks it to choose between more than two", () => {
    // The cap is TWO, and it came from a stopwatch rather than from Azure's
    // ceiling (which is 4 for at-start and 10 for continuous). Measured on one
    // 4.15s clip: 4 candidates put the first word on screen at ~4.5s, 2 at
    // ~2.4s, and 1 at ~0.8s — with an identical transcript every time. Extra
    // candidates bought nothing and cost the whole feature.
    expect(MAX_SPEECH_CANDIDATES).toBe(2);
    for (const pair of [["en", "es"], ["fr", "de"], ["ja", "ko"]] as const) {
      expect(speechCandidates(pair, null)!.length).toBeLessThanOrEqual(MAX_SPEECH_CANDIDATES);
    }
  });

  it("drops to ONE language when the direction is pinned", () => {
    // The fast path, and the reason it is worth having a swap button: with one
    // language there is no identification to do, and the words start landing
    // in ~800ms instead of ~2400ms.
    expect(speechCandidates(["en", "es"], "es")).toEqual(["es-MX"]);
    expect(speechCandidates(["en", "es"], "en")).toEqual(["en-US"]);
  });

  it("uses continuous identification, not at-start", () => {
    // Also a stopwatch decision: 2.4s against 3.8s for the same two candidates
    // and the same transcript. At-start buffers ~3s to decide once, which is
    // precisely what this screen cannot spend.
    expect(SPEECH_LANGUAGE_ID_MODE).toBe("Continuous");
  });

  it("answers null when EITHER side of the pair is unhearable", () => {
    // The load-bearing rule for Auto. /fast does not know which pill is about
    // to be spoken, so a recogniser that can hear only one side is not a
    // cheaper version of this feature — it is one that silently
    // mis-transcribes every sentence in the other language. Whisper hears all
    // 100, so the honest answer is to hand it the whole job.
    expect(speechCandidates(["en", "la"], null)).toBeNull();
    expect(speechCandidates(["haw", "es"], null)).toBeNull();
  });

  it("still streams a half-unhearable pair when the direction is pinned", () => {
    // Pinning only needs the ONE language, so an English speaker with Latin on
    // the other pill gets the live mic by saying which way round they are
    // talking — where Auto has to give the whole job to Whisper.
    expect(speechCandidates(["en", "la"], "en")).toEqual(["en-US"]);
    expect(speechCandidates(["en", "la"], "la")).toBeNull();
  });

  it("de-duplicates, since two catalog rows could share one locale", () => {
    const picked = speechCandidates(["en", "en"], null);
    expect(picked).toEqual(["en-US"]);
  });
});

describe("speechLocale — the map itself", () => {
  it("covers most of the catalog and leaves the rest to Whisper", () => {
    const heard = LANGUAGES.filter((l) => speechLocale(l.code));
    expect(heard).toHaveLength(STREAMABLE_LANGUAGES.length);
    // A real majority, so the live mic is the normal experience rather than a
    // lucky one — but emphatically not all 100, which is why the batch mic
    // stays in the build.
    expect(heard.length).toBeGreaterThan(70);
    expect(heard.length).toBeLessThan(LANGUAGES.length);
  });

  it("only names languages that are actually in the catalog", () => {
    const codes = new Set(LANGUAGES.map((l) => l.code));
    for (const code of STREAMABLE_LANGUAGES) expect(codes).toContain(code);
  });

  it("is a well-formed BCP-47 locale everywhere", () => {
    for (const code of STREAMABLE_LANGUAGES) {
      expect(speechLocale(code)).toMatch(/^[a-z]{2,3}-[A-Z]{2}$/);
    }
  });

  it("agrees with the tutor about regional variants", () => {
    // One household, one opinion. A phone that SCORES Tom's Spanish as es-MX
    // and then TRANSCRIBES it as es-ES would be two different answers to the
    // same question about the same voice — and the es-MX choice is Liz's
    // accent, which is the one this app is actually tuned for.
    for (const code of STREAMABLE_LANGUAGES) {
      const scored = assessmentLocale(code);
      if (scored) expect(speechLocale(code)).toBe(scored);
    }
    expect(speechLocale("es")).toBe("es-MX");
    expect(speechLocale("pt")).toBe("pt-BR");
    expect(speechLocale("ar")).toBe("ar-EG");
    expect(speechLocale("yue")).toBe("zh-HK");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. The token route — the key stays on the server
// ───────────────────────────────────────────────────────────────────────────

let caller: { id: string; email: string } | null = null;

vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async (req: Request) => {
    const header = req.headers.get("authorization") ?? "";
    return header.startsWith("Bearer ") && caller ? caller : null;
  }
}));

const AZURE_JWT = "eyJhbGciOi.MINTED.TOKEN";

const fetchSpy = vi.fn(async (url: unknown, _init?: RequestInit) => {
  if (String(url).includes("issueToken")) {
    return new Response(AZURE_JWT, { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return new Response("{}", { status: 200 });
});

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL = {
  key: process.env.AZURE_SPEECH_KEY,
  region: process.env.AZURE_SPEECH_REGION,
  flag: process.env.NEXT_PUBLIC_ENABLE_FAST
};

beforeEach(async () => {
  caller = null;
  fetchSpy.mockClear();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  process.env.AZURE_SPEECH_KEY = "speech-key-secret";
  process.env.AZURE_SPEECH_REGION = "eastus";
  delete process.env.NEXT_PUBLIC_ENABLE_FAST;
  const { resetFastRateLimits } = await import("@/lib/fast/rateLimit");
  resetFastRateLimits();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const [name, value] of [
    ["AZURE_SPEECH_KEY", ORIGINAL.key],
    ["AZURE_SPEECH_REGION", ORIGINAL.region],
    ["NEXT_PUBLIC_ENABLE_FAST", ORIGINAL.flag]
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.resetModules();
});

async function mint(token?: string) {
  const { POST } = await import("@/app/api/fast/speech-token/route");
  return POST(
    new NextRequest("https://taoslite.com/api/fast/speech-token", {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    })
  );
}

describe("POST /api/fast/speech-token — who may open a socket to Azure", () => {
  it("404s a signed-out stranger without reaching Azure", async () => {
    const res = await mint();
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("404s a signed-in customer without reaching Azure", async () => {
    // Same fastVisibleTo() 404-not-403 the screen and the other two /fast
    // routes use: a credential to a paid resource is not a thing to hand out
    // one rung below the gate on the screen it is for.
    caller = { id: "u1", email: "stranger@example.com" };
    const res = await mint("token");
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("mints a short-lived token for a founder", async () => {
    caller = { id: "u2", email: "xdrabbit@gmail.com" };
    const res = await mint("token");
    expect(res.status).toBe(200);
    // sessionId is the ledger row this mint reserved (lib/fast/speechMeter.ts).
    // Null here because these tests run without a service-role key, which is
    // the unmetered-off-production path; what it must never be is absent from
    // the contract, since the browser hands it back to settle.
    expect(await res.json()).toEqual({
      token: AZURE_JWT,
      region: "eastus",
      expiresInMs: AZURE_TOKEN_TTL_MS,
      sessionId: null,
      grantedSeconds: Math.ceil(FAST_MAX_DICTATION_MS / 1000)
    });
  });

  it("sends the subscription key to Azure and NEVER to the client", async () => {
    // The whole reason this route exists. AZURE_SPEECH_KEY is a permanent,
    // unscoped credential to a paid resource; the browser gets a JWT that
    // expires in ten minutes and can only recognise speech.
    caller = { id: "u3", email: "xdrabbit@gmail.com" };
    const res = await mint("token");
    const body = await res.text();
    expect(body).not.toContain("speech-key-secret");
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://eastus.api.cognitive.microsoft.com/sts/v1.0/issueToken");
    expect((init.headers as Record<string, string>)["Ocp-Apim-Subscription-Key"]).toBe(
      "speech-key-secret"
    );
  });

  it("never lets a bearer credential be cached", async () => {
    caller = { id: "u4", email: "xdrabbit@gmail.com" };
    const res = await mint("token");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });

  it("opens to everyone on the same flag the typing does", async () => {
    // One env var opens the screen, the translate route, the batch mic and
    // this together. A live mic that needed a second flag is a live mic that
    // ships dark by accident.
    process.env.NEXT_PUBLIC_ENABLE_FAST = "1";
    caller = { id: "u5", email: "anyone@example.com" };
    expect((await mint("token")).status).toBe(200);
  });

  it("shares the /fast rate buckets rather than keeping its own", async () => {
    // Same reasoning as the listen route: a spend path with a private counter
    // is one the /fast ceiling cannot see. Token issuance is not itself
    // billed — the recognition it unlocks is, which is exactly why the bucket
    // belongs here rather than nowhere.
    caller = { id: "burst", email: "xdrabbit@gmail.com" };
    const { checkFastRate } = await import("@/lib/fast/rateLimit");
    for (let i = 0; i < 60; i += 1) checkFastRate("burst");
    const res = await mint("token");
    expect(res.status).toBe(429);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("POST /api/fast/speech-token — the fallback signals", () => {
  it("says speech_not_configured, machine-readably, when the resource is absent", async () => {
    // The caller's whole job on this answer is to stop asking and use the
    // batch mic. It should not have to pattern-match an English sentence to
    // decide that — and an unconfigured resource is not an error on this
    // screen, it is the older, slower mic, which still works.
    delete process.env.AZURE_SPEECH_KEY;
    caller = { id: "u6", email: "xdrabbit@gmail.com" };
    const res = await mint("token");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "speech_not_configured" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("needs BOTH halves of the credential", async () => {
    // A region-less key cannot address a resource; guessing one would turn a
    // missing env var into a 401 nobody can read.
    delete process.env.AZURE_SPEECH_REGION;
    caller = { id: "u7", email: "xdrabbit@gmail.com" };
    expect((await mint("token")).status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("degrades rather than 500s when Azure refuses the key", async () => {
    fetchSpy.mockImplementationOnce(async () => new Response("no", { status: 401 }));
    caller = { id: "u8", email: "xdrabbit@gmail.com" };
    const res = await mint("token");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "speech_unavailable" });
  });

  it("does not echo Azure's rejection to the phone", async () => {
    // A 401 here means OUR key is wrong. Azure's prose about it is a server
    // log line, not something to hand a client.
    fetchSpy.mockImplementationOnce(
      async () => new Response("Access denied due to invalid subscription key", { status: 401 })
    );
    caller = { id: "u9", email: "xdrabbit@gmail.com" };
    const body = await (await mint("token")).text();
    expect(body).not.toContain("invalid subscription key");
  });

  it("degrades when Azure cannot be reached at all", async () => {
    fetchSpy.mockImplementationOnce(async () => {
      throw new Error("network down");
    });
    caller = { id: "u10", email: "xdrabbit@gmail.com" };
    expect((await mint("token")).status).toBe(503);
  });

  it("refuses an empty token instead of handing the browser a blank one", async () => {
    fetchSpy.mockImplementationOnce(async () => new Response("   ", { status: 200 }));
    caller = { id: "u11", email: "xdrabbit@gmail.com" };
    expect((await mint("token")).status).toBe(503);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. The fallback is silent, and the mic is never dead
// ───────────────────────────────────────────────────────────────────────────

describe("the batch mic is still there, and nothing announces it", () => {
  const hook = source("lib/fast/useLiveDictation.ts");

  it("owns the batch mic rather than replacing it", () => {
    // The old path has to survive intact: it is the only mic for the 24
    // catalog languages Azure cannot hear, and the only one left when a
    // token, a socket or a browser says no.
    //
    // The option list grew by one on 8/31 — `adopt`, which hands the batch mic
    // the microphone this hook already opened instead of making the phone
    // grant a second one (tests/live-fire/fast-dictation-browser-check.mjs
    // counts the streams, and caught the double-open). The relationship it
    // pins is unchanged: the callbacks are wired straight through, and the
    // batch hook is CALLED, not reimplemented.
    expect(hook).toContain('from "@/lib/fast/useDictation"');
    expect(hook).toContain("useDictation({ onAudio, onError, adopt })");
  });

  it("hands the batch mic the microphone it already opened", () => {
    // One press opens ONE microphone, however many recognisers it passes
    // through. Stopping every track and immediately asking the phone for
    // another is how iOS gives you a stream that records silence — and the
    // second ask would land outside the gesture besides.
    expect(hook).toContain("captureRef.current?.detachStream()");
    const recover = hook.slice(hook.indexOf("const recoverToBatch = useCallback"));
    // Before teardown, which would otherwise stop the tracks on its way past.
    expect(recover.indexOf("handOffCapture()")).toBeLessThan(recover.indexOf("teardown()"));
  });

  it("falls back without telling anybody", () => {
    // The requirement, verbatim from the field report: never a dead mic, and
    // never an interruption to discuss infrastructure with somebody who is
    // mid-errand. The catch that handles a failed stream start must reach for
    // the batch mic and NOT for onError.
    const start = hook.slice(hook.indexOf("void beginStream(session)"));
    const catchBlock = start.slice(0, start.indexOf(".finally("));
    expect(catchBlock).toContain("fallBackToBatch()");
    expect(catchBlock).not.toContain("onError");
  });

  it("decides per press, not once per page", () => {
    // The reasons streaming fails are mostly weather — an expired token, a
    // tunnel, a dropped socket. A phone that fell back once and then refused
    // to stream for the rest of the trip would be a worse bug than the one
    // this fixes, and an invisible one.
    expect(hook).toContain("activeRef.current = null");
  });

  it("spends nothing on a pair Azure cannot hear", () => {
    // No token, no SDK, no delay in front of the mic — straight to Whisper.
    expect(hook).toContain("if (!candidatesRef.current) {");
  });

  it("asks for continuous identification, and for none at all when it can", () => {
    // Both halves are stopwatch decisions (lib/fast/speechLocale.ts). The SDK
    // DEFAULTS to at-start, which measured a second and a half slower, so the
    // mode is set explicitly rather than inherited.
    expect(hook).toContain("SpeechServiceConnection_LanguageIdMode");
    expect(hook).toContain("SPEECH_LANGUAGE_ID_MODE");
    expect(hook).not.toContain('"AtStart"');
    // One language: no LID machinery at all, which is the ~800ms path.
    expect(hook).toContain("speechConfig.speechRecognitionLanguage = locales[0]");
  });

  it("keeps the audio off Vercel", () => {
    // The point of the whole exercise: a function hop per 100ms of speech
    // would spend the latency this exists to save. The only server call in
    // the streaming path is the one that mints the credential.
    expect(hook).toContain("/api/fast/speech-token");
    expect(hook).not.toContain("/api/fast/listen");
  });

  it("refreshes the token before it expires, not after", () => {
    // A token that dies BETWEEN the press and the first syllable fails the
    // recogniser open and drops a dictation into batch for no reason.
    expect(AZURE_TOKEN_REFRESH_MS).toBeGreaterThan(0);
    expect(AZURE_TOKEN_REFRESH_MS).toBeLessThan(AZURE_TOKEN_TTL_MS);
    expect(hook).toContain("expiresAt - AZURE_TOKEN_REFRESH_MS");
  });

  it("stops gently at the cap instead of throwing the words away", () => {
    // The 30s bound is a spend bound (streaming STT bills per audio-second),
    // and it ends the session the same way letting go does — punishing
    // somebody for talking too long by discarding what they said would be a
    // worse feature than no cap.
    expect(hook).toContain("stopStream(false);");
    expect(hook).toContain("}, FAST_MAX_DICTATION_MS);");
    // And the cap now says so in the ledger, so a session that ran to the
    // ceiling is distinguishable from one somebody let go of.
    expect(hook).toContain('endReasonRef.current = "cap"');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4b. The iPhone: the mic is opened in the tap, and every silence falls back
// ───────────────────────────────────────────────────────────────────────────

describe("the microphone belongs to the hook, not to the SDK", () => {
  const hook = source("lib/fast/useLiveDictation.ts");

  it("never lets the SDK open the microphone", () => {
    // The whole iPhone bug in one call. `fromDefaultMicrophoneInput` makes the
    // SDK build its own AudioContext and resume it from inside
    // startContinuousRecognitionAsync — which this hook reaches only after
    // `await ensureWarm()`, so WebKit sees both outside the tap, refuses to
    // start the graph, and reports nothing wrong. The recogniser is fed PCM
    // through a push stream instead.
    const body = code("lib/fast/useLiveDictation.ts");
    expect(body).not.toContain("fromDefaultMicrophoneInput");
    expect(body).not.toContain("fromMicrophoneInput");
    expect(hook).toContain("sdk.AudioConfig.fromStreamInput(sink)");
    expect(hook).toContain("createPushStream");
  });

  it("opens the mic in the press handler, with nothing awaited in front", () => {
    // `press` is a plain callback and openMicCapture is reached inside it, so
    // the AudioContext, its resume() and getUserMedia all happen in the tap's
    // own task (lib/fast/micCapture.ts proves the three calls and their
    // order). beginStream — the part with a network round trip in it — is only
    // started AFTER the microphone is already open.
    const press = hook.slice(hook.indexOf("const press = useCallback(() => {"));
    const body = press.slice(0, press.indexOf("const release ="));
    expect(body).toContain("openMicCapture({");
    expect(body.indexOf("openMicCapture({")).toBeLessThan(body.indexOf("void beginStream(session)"));
    // An await anywhere in `press` would put the gesture behind a microtask.
    expect(body).not.toContain("await ");
  });

  it("puts a clock on the handshake the SDK does not put one on", () => {
    // startContinuousRecognitionAsync can hang for as long as the TCP stack
    // allows — a captive portal holds the button lit indefinitely otherwise.
    expect(STREAM_CONNECT_MS).toBeGreaterThan(0);
    expect(hook).toContain("connect timeout");
    expect(hook).toContain("STREAM_CONNECT_MS");
  });

  it("watches a STARTED session, because starting proved nothing", () => {
    // The failure this whole change exists for does not throw: the socket
    // opens, the button lights, and no audio is ever produced. So a started
    // session is polled against micVerdict rather than trusted.
    expect(hook).toContain("micVerdict({");
    expect(hook).toContain('if (verdict === "dead-graph") recoverToBatch();');
    expect(hook).toContain("armWatchdog(session)");
  });

  it("routes a dead graph to the batch mic and keeps the finger's meaning", () => {
    // Nothing was heard, so nothing is lost — but a LATCHED press must arrive
    // at the batch mic still latched, or the mic closes under somebody who is
    // still talking to it.
    const recover = hook.slice(hook.indexOf("const recoverToBatch = useCallback"));
    const body = recover.slice(0, recover.indexOf("const beginSalvage"));
    expect(body).toContain("latchedRef.current");
    expect(body).toContain("pendingLatchRef.current = true");
    expect(body).toContain("fallBackToBatch()");
    // Still silent. The field report's rule has not moved.
    expect(body).not.toContain("onError");
  });

  it("salvages a deaf socket instead of asking for the sentence again", () => {
    // Four seconds of voiced audio with no hypothesis back means the socket is
    // one-way. The capture stays open and what it already holds is posted as
    // one WAV — restarting into the batch mic here would throw away exactly
    // the audio that diagnosed the problem.
    const salvage = hook.slice(hook.indexOf("const beginSalvage = useCallback"));
    const body = salvage.slice(0, salvage.indexOf("const stopStream"));
    expect(body).toContain('activeRef.current = "salvage"');
    expect(body).toContain('setMode("batch")');
    expect(hook).toContain('onAudioRef.current(wav, "audio/wav")');
    expect(hook).not.toContain("/api/fast/listen");
  });

  it("closes its own microphone before handing the press to the batch mic", () => {
    // Two live captures on a phone is how you get one that records silence.
    const start = hook.slice(hook.indexOf("void beginStream(session)"));
    const catchBlock = start.slice(0, start.indexOf(".finally("));
    expect(catchBlock).toContain("closeCapture()");
  });

  it("lets the retained copy go the moment Azure proves the socket", () => {
    // Retention is memory held against a problem that is ruled out by the
    // first partial. Thirty seconds of PCM after that is just a leak.
    expect(hook).toContain("captureRef.current?.stopRetaining()");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 5. The meter did not move
// ───────────────────────────────────────────────────────────────────────────

describe("one settled quickie still bills one row", () => {
  it("arrives at the box as the same text a keyboard would have produced", () => {
    // What the meter sees is the input, and the input does not record how the
    // words got there. Two streamed segments that add up to the same sentence
    // as one typed phrase ARE that phrase by the time POST /api/fast is
    // called — which is the whole reason dictating costs the same as typing.
    const spoken = ["where is", "the pharmacy"].reduce(
      (box, segment) => appendDictated(box, segment, 500),
      ""
    );
    expect(spoken).toBe("where is the pharmacy");
  });

  it("counts the burst, not the segments — and the shell counts nothing", () => {
    // Billing moved to the server in #51. Streaming makes `input` change more
    // often on the way to a settled phrase; it does not add a clock, and the
    // shell must not have grown one — nor may it write a row of its own, which
    // is the shape the old bug had.
    const shell = source("components/FastShell.tsx");
    expect(shell).not.toContain("saveTranslation");
    expect(shell).not.toContain("FAST_SETTLE_MS");
    // The one clock left here is the debounce, and it is about feel.
    expect(shell).toContain("FAST_DEBOUNCE_MS");
  });

  it("keeps hypotheses out of the input entirely", () => {
    // The cost fence again, this time where it is actually enforced: the
    // shell commits `onSegment` (finals only) and renders `dictation.partial`
    // without ever setting it into `input`.
    const shell = source("components/FastShell.tsx");
    expect(shell).toContain("onSegment: commitDictated");
    expect(shell).not.toMatch(/setInput\([^)]*partial/);
  });
});

describe("the live view is the same box", () => {
  const shell = source("components/FastShell.tsx");

  it("shares one class string with the textarea it stands in for", () => {
    // The two render alternately in the same slot. Different metrics would
    // make the box jump the instant somebody started talking.
    expect(shell).toContain("const BOX_BASE");
    expect(shell.match(/\$\{BOX_BASE\}/g)?.length).toBe(2);
  });

  it("draws the tail dimmed, and only while streaming", () => {
    expect(shell).toContain("text-amber-100/40");
    expect(shell).toContain('dictation.mode === "stream" && dictation.state === "recording"');
  });

  it("aims the recogniser with the same pin that aims the translation", () => {
    // One direction decision, used twice. Pinning does not just choose which
    // way the translation runs; it removes the language identification step
    // and is most of the difference between ~800ms and ~2400ms to first word.
    expect(shell).toContain("speechCandidates([mine, theirs], explicitSource)");
  });

  it("labels the stop button for what it actually does in each mode", () => {
    // Streaming has already put the finalized words in the box, so there is
    // nothing to take back — calling it "Cancel" would promise an undo this
    // screen does not have. The batch mic really does discard.
    expect(shell).toContain('dictation.mode === "stream" ? "Done · Listo" : "Cancel · Cancelar"');
  });
});

describe("the catalog rows the live mic cannot serve", () => {
  it("names them, so the fallback is a documented set and not a surprise", () => {
    const silent = LANGUAGES.map((l) => l.code as LanguageCode).filter((c) => !speechLocale(c));
    // Whisper hears every one of these; Azure Speech hears none of them. They
    // are batch-mic languages permanently, which is a degrade worth being
    // able to point at rather than discover.
    expect(silent).toEqual([
      "ba",
      "be",
      "br",
      "fo",
      "ht",
      "ha",
      "haw",
      "la",
      "ln",
      "lb",
      "mg",
      "mi",
      "nn",
      "oc",
      "sa",
      "sn",
      "sd",
      "su",
      "tg",
      "tt",
      "bo",
      "tk",
      "yi",
      "yo"
    ]);
  });
});
