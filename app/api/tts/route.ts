import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import {
  defaultElevenLabsVoiceId,
  resolveTtsVoice,
  type ResolvedVoice,
  type TtsLangCode as LangCode,
  type VoiceOverride
} from "@/lib/tts/voice";
import { PERSONAL_VOICE_HEADER, personalVoiceUnlocked } from "@/lib/tts/personalVoice";
import {
  decodeGoogleAudio,
  googleVoiceFor,
  synthesizeGoogle,
  type GoogleVoice
} from "@/lib/tts/google";
import { canSpeak, isLanguageCode } from "@/lib/languages/catalog";
import { guardSpend, SIGN_IN_REQUIRED } from "@/lib/spendGuard";
import { isFounder } from "@/lib/release";
import { authorizeDemoVoice, countDemoLine, demoEnabled } from "@/lib/demo/server";
import {
  TTS_STANDALONE_HEADER,
  TTS_SURFACE_HEADER,
  parseStandalone,
  parseSurface,
  parseUserAgent,
  uaHash,
  writeTtsLog,
  type TtsLogRecord
} from "@/lib/tts/requestLog";
import {
  SIGNOFF_AVAILABLE_HEADER,
  SIGNOFF_HEADER,
  shareSignoffEnabled,
  withSignoff
} from "@/lib/tts/shareSignoff";

export const runtime = "nodejs";
export const maxDuration = 60;

type Engine = "elevenlabs" | "openai" | "fishaudio" | "google";

// Bound the upstream synthesis call well under maxDuration (60s): a stalled
// provider must become a fast, retryable JSON error, not a hung request the
// phone eventually reports as Safari's opaque "Load failed".
const SYNTH_TIMEOUT_MS = 45000;
const DEFAULT_OPENAI_TTS_TIMEOUT_MS = 8000;

function openAiTtsTimeoutMs(): number {
  const configured = Number(process.env.OPENAI_TTS_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_OPENAI_TTS_TIMEOUT_MS;
}

function isTimeout(e: unknown): boolean {
  return e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
}

// X-TTS-Engine says which provider actually spoke. It matters for Fish
// Audio, the one engine that can hand a line to another provider (see
// fishAudio below): without it, "that didn't sound like Fish" has no answer
// short of the server log.
function audioResponse(buffer: ArrayBuffer, engine: Engine, log: RequestLog): NextResponse {
  log.audioBytes = buffer.byteLength;
  log.audioMime = "audio/mpeg";
  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
      "X-TTS-Engine": engine
    }
  });
}

// What the request log (lib/tts/requestLog.ts) learns along the way. Filled
// in as the handler goes, written once by POST whatever the outcome.
type RequestLog = { demo?: boolean } & Pick<
  TtsLogRecord,
  | "userId"
  | "engine"
  | "requestedEngine"
  | "voiceId"
  | "voiceRole"
  | "unlocked"
  | "lang"
  | "sourceLang"
  | "textChars"
  | "errorCode"
  | "audioBytes"
  | "audioMime"
>;

function providerFailed(log: RequestLog, status: number): void {
  log.errorCode = `provider_${status}`;
}

// Cloned-voice selection lives in lib/tts/voice.ts (voice follows the
// SPEAKER — see the unit tests that pin the rule), behind the personal-voice
// gate in lib/tts/personalVoice.ts. The clone ids are resolved HERE, on the
// server, from a speaker direction: a client never names a voice id, so a
// phone without the code cannot reach one however it shapes the request.

async function elevenLabs(
  text: string,
  voiceId: string,
  log: RequestLog,
  targetLanguage?: LangCode,
  latency?: "flash"
): Promise<NextResponse> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    log.errorCode = "missing_key";
    return NextResponse.json({ error: "Missing ELEVENLABS_API_KEY." }, { status: 500 });
  }
  // /live sends latency:"flash" — trade a little clone fidelity for the
  // lowest-latency model so spoken concepts don't lag the conversation.
  // Cantonese output overrides both: turbo/flash don't speak Cantonese (they
  // read written Cantonese with Mandarin-ish pronunciation), so yue routes to
  // the v3 family — slower, but the only one that actually speaks it. Field
  // verdict pending (7/25 promise to the two guests).
  const model =
    targetLanguage === "yue"
      ? process.env.ELEVENLABS_YUE_MODEL?.trim() || "eleven_v3"
      : latency === "flash"
        ? process.env.ELEVENLABS_FLASH_MODEL?.trim() || "eleven_flash_v2_5"
        : process.env.ELEVENLABS_MODEL?.trim() || "eleven_turbo_v2_5"; // low-latency, multilingual

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg"
      },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: { stability: 0.4, similarity_boost: 0.8 }
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(SYNTH_TIMEOUT_MS)
    }
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => `HTTP ${res.status}`);
    providerFailed(log, res.status);
    return NextResponse.json({ error: "ElevenLabs TTS failed.", details: detail }, { status: 502 });
  }
  return audioResponse(await res.arrayBuffer(), "elevenlabs", log);
}

type OpenAiAttempt =
  | { ok: true; buffer: ArrayBuffer }
  | { ok: false; response: NextResponse; errorCode: string; fallbackCode: string };

async function openaiAttempt(text: string, voice: string, log: RequestLog): Promise<OpenAiAttempt> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    log.errorCode = "missing_key";
    return {
      ok: false,
      response: NextResponse.json({ error: "Missing OPENAI_API_KEY." }, { status: 500 }),
      errorCode: "missing_key",
      fallbackCode: "missing_key"
    };
  }
  const model = process.env.OPENAI_TTS_MODEL?.trim() || "gpt-4o-mini-tts";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), openAiTtsTimeoutMs());

  try {
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model, voice, input: text, response_format: "mp3" }),
      cache: "no-store",
      signal: controller.signal
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => `HTTP ${res.status}`);
      return {
        ok: false,
        response: NextResponse.json({ error: "OpenAI TTS failed.", details: detail }, { status: 502 }),
        errorCode: `provider_${res.status}`,
        fallbackCode: `openai_${res.status}_fallback`
      };
    }
    return { ok: true, buffer: await res.arrayBuffer() };
  } catch (error) {
    if (!controller.signal.aborted && !isTimeout(error)) throw error;
    return {
      ok: false,
      response: NextResponse.json(
        { error: "The voice service took too long. Please try again." },
        { status: 504 }
      ),
      errorCode: "openai_timeout",
      fallbackCode: "openai_timeout_fallback"
    };
  } finally {
    clearTimeout(timer);
  }
}

async function openai(
  text: string,
  voice: string,
  log: RequestLog,
  targetLanguage?: LangCode
): Promise<NextResponse> {
  const attempt = await openaiAttempt(text, voice, log);
  if (attempt.ok) return audioResponse(attempt.buffer, "openai", log);

  // A missing key is local configuration, not an unhealthy OpenAI response.
  // Preserve the existing error instead of spending ElevenLabs credit too.
  if (attempt.errorCode === "missing_key") return attempt.response;

  const stockVoiceId = defaultElevenLabsVoiceId();
  log.engine = "elevenlabs";
  log.voiceId = stockVoiceId;
  log.voiceRole = "stock";
  log.errorCode = attempt.fallbackCode;

  try {
    const fallback = await elevenLabs(text, stockVoiceId, log, targetLanguage);
    if (fallback.ok) {
      // elevenLabs leaves a successful log code alone; assign again to make
      // that contract explicit at the hand-off boundary.
      log.errorCode = attempt.fallbackCode;
      return fallback;
    }
  } catch {
    // Return the OpenAI failure below. The fallback is deliberately invisible
    // to the caller unless it succeeds with playable audio.
  }

  log.errorCode = attempt.errorCode;
  return attempt.response;
}

type GoogleAttempt =
  | { ok: true; buffer: ArrayBuffer }
  | { ok: false; response: NextResponse; errorCode: string; fallbackCode: string };

async function googleAttempt(text: string, voice: GoogleVoice, log: RequestLog): Promise<GoogleAttempt> {
  const apiKey = process.env.GOOGLE_TTS_API_KEY;
  if (!apiKey) {
    log.errorCode = "missing_key";
    return {
      ok: false,
      response: NextResponse.json({ error: "Missing GOOGLE_TTS_API_KEY." }, { status: 500 }),
      errorCode: "missing_key",
      fallbackCode: "missing_key"
    };
  }

  try {
    const res = await synthesizeGoogle(text, voice, apiKey);
    if (!res.ok) {
      const detail = await res.text().catch(() => `HTTP ${res.status}`);
      return {
        ok: false,
        response: NextResponse.json(
          { error: "Google Cloud TTS failed.", details: detail },
          { status: 502 }
        ),
        errorCode: `provider_${res.status}`,
        fallbackCode: `google_${res.status}_fallback`
      };
    }

    const payload = (await res.json().catch(() => null)) as { audioContent?: unknown } | null;
    const audio = decodeGoogleAudio(payload?.audioContent);
    if (!audio) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "Google Cloud TTS returned no audio." },
          { status: 502 }
        ),
        errorCode: "provider_payload",
        fallbackCode: "google_payload_fallback"
      };
    }
    return { ok: true, buffer: audio };
  } catch (error) {
    if (!isTimeout(error)) throw error;
    return {
      ok: false,
      response: NextResponse.json(
        { error: "The voice service took too long. Please try again." },
        { status: 504 }
      ),
      errorCode: "google_timeout",
      fallbackCode: "google_timeout_fallback"
    };
  }
}

async function googleCloud(
  text: string,
  voice: GoogleVoice,
  log: RequestLog,
  targetLanguage?: LangCode
): Promise<NextResponse> {
  const attempt = await googleAttempt(text, voice, log);
  if (attempt.ok) return audioResponse(attempt.buffer, "google", log);

  // Match the OpenAI leash: configuration errors stay errors, while a real
  // provider failure gets one attempt in ElevenLabs' stock voice.
  if (attempt.errorCode === "missing_key") return attempt.response;

  const stockVoiceId = defaultElevenLabsVoiceId();
  log.engine = "elevenlabs";
  log.voiceId = stockVoiceId;
  log.voiceRole = "stock";
  log.errorCode = attempt.fallbackCode;

  try {
    const fallback = await elevenLabs(text, stockVoiceId, log, targetLanguage);
    if (fallback.ok) {
      log.errorCode = attempt.fallbackCode;
      return fallback;
    }
  } catch {
    // As with OpenAI, expose the original Google failure if fallback fails.
  }

  log.errorCode = attempt.errorCode;
  return attempt.response;
}

/**
 * Fish Audio (fish.audio) — a second home for Tom's and Liz's clones, tried
 * as the home screen's default on 10/06.
 *
 * Fish is ONLY the clones. When there is no Fish clone for this line — a
 * locked phone, a guest speaker, a missing or malformed voice variable — the
 * line goes to the ElevenLabs path, which answers exactly as it always has
 * (the stock multilingual voice). That hand-off is about WHICH voice, never a
 * rescue from a failure: a Fish error is a Fish error and comes back as a 502,
 * because quietly answering in another provider's voice is how a "why does
 * it sound different?" report is born. X-TTS-Engine says who spoke.
 *
 * The hand-off itself is decided in resolveTtsVoice (lib/tts/voice.ts): this
 * function is only reached when there IS a Fish clone for the line.
 */
async function fishAudio(
  text: string,
  referenceId: string,
  log: RequestLog,
  latency?: "flash"
): Promise<NextResponse> {
  const apiKey = process.env.FISHAUDIO_API_KEY;
  if (!apiKey) {
    log.errorCode = "missing_key";
    return NextResponse.json({ error: "Missing FISHAUDIO_API_KEY." }, { status: 500 });
  }

  const res = await fetch("https://api.fish.audio/v1/tts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      model: process.env.FISHAUDIO_MODEL?.trim() || "s2.1-pro"
    },
    body: JSON.stringify({
      text,
      reference_id: referenceId,
      format: "mp3",
      mp3_bitrate: 128,
      latency: latency === "flash" ? "low" : "normal"
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(SYNTH_TIMEOUT_MS)
  });

  if (!res.ok) {
    // 402 is the one worth naming: Fish keeps API credit separate from the
    // app's credit, so a funded account can still be empty here.
    const detail = await res.text().catch(() => `HTTP ${res.status}`);
    console.error(`[tts/fishaudio] HTTP ${res.status}: ${detail.slice(0, 300)}`);
    providerFailed(log, res.status);
    return NextResponse.json({ error: "Fish Audio TTS failed.", details: detail }, { status: 502 });
  }
  return audioResponse(await res.arrayBuffer(), "fishaudio", log);
}

async function demoVoice(
  text: string,
  voiceOverride: unknown,
  demoToken: unknown,
  user: { id: string; email?: string | null } | null,
  log: RequestLog,
  targetLanguage?: LangCode
): Promise<NextResponse> {
  log.demo = true;
  log.requestedEngine = "demo";
  const refuse = (code: string): NextResponse => {
    log.errorCode = `demo_${code}`;
    return NextResponse.json({ error: "That voice is not available." }, { status: 403 });
  };
  if (!demoEnabled()) return refuse("disabled");
  if (!user || !isFounder(user.email)) return refuse("founder");
  const verdict = authorizeDemoVoice({
    voiceId: voiceOverride,
    token: demoToken,
    userId: user.id,
    consume: false
  });
  if (!verdict.ok) return refuse(verdict.reason);

  // The id is NOT logged: it is a stranger's voice, and the request log is
  // the one place on this route that writes to a table. `[taos-demo]` lines
  // from the demo routes carry it, which is enough to correlate.
  log.engine = "elevenlabs";
  log.voiceRole = "none";
  const res = await elevenLabs(text, voiceOverride as string, log, targetLanguage);
  if (res.ok) res.headers.set("X-Demo-Lines-Left", String(countDemoLine(voiceOverride as string)));
  return res;
}

/**
 * The most an anonymous /try caller may ask to have spoken in one request.
 *
 * A turn on /try is a sentence or two. This is not a quality limit, it is a
 * bill limit: TTS is priced per character, so an unbounded `text` from an
 * unauthenticated caller is an unbounded invoice.
 */
const ANON_MAX_CHARS = 1000;

/**
 * Every request is logged — success, refusal and failure alike — AFTER the
 * answer is decided, and without waiting on the write: waitUntil keeps the
 * function alive for the insert, and writeTtsLog cannot throw.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const started = Date.now();
  const log: RequestLog = {
    userId: null,
    engine: null,
    requestedEngine: null,
    voiceId: null,
    voiceRole: "none",
    unlocked: false,
    lang: null,
    sourceLang: null,
    textChars: 0,
    errorCode: null,
    audioBytes: null,
    audioMime: null
  };
  const share: ShareRequest = { requested: false, target: null };
  const res = await shareStep(req, await handle(req, log, share), log, share);
  try {
    const ua = req.headers.get("user-agent");
    const { device, browser } = parseUserAgent(ua);
    const record: TtsLogRecord = {
      ...log,
      surface: parseSurface(req.headers.get(TTS_SURFACE_HEADER)),
      standalone: parseStandalone(req.headers.get(TTS_STANDALONE_HEADER)),
      device,
      browser,
      uaHash: uaHash(ua),
      status: res.status === 200 ? "ok" : "error",
      httpStatus: res.status,
      errorCode: log.errorCode ?? (res.status === 200 ? null : `http_${res.status}`),
      latencyMs: Date.now() - started
    };
    // A request the spend guard turned away gets the log line but no row:
    // a flood of strangers must not become a flood of inserts.
    //
    // A /demo line gets the line and no row either: the stranger's voice is
    // promised to leave nothing behind, and a table row is something.
    waitUntil(
      log.errorCode === "guard" || log.demo ? writeTtsLog(record, null) : writeTtsLog(record)
    );
  } catch (e) {
    console.warn(`[taos-tts] log skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
  return res;
}

// What the body said about the share sign-off (lib/tts/shareSignoff.ts).
interface ShareRequest {
  requested: boolean;
  target: string | null;
}

/**
 * The home card's Share, after the line is synthesized. Two jobs, both only
 * on a 200 for a signed-in caller:
 *   * a home-screen line says whether the flag is on, so the client knows a
 *     Share should come back for the signed version rather than reuse Play's;
 *   * a home-share request that asked gets [line][gap][sign-off] — or the
 *     clean line, when the caller is a subscriber or anything goes wrong.
 */
async function shareStep(
  req: NextRequest,
  res: NextResponse,
  log: RequestLog,
  share: ShareRequest
): Promise<NextResponse> {
  if (res.status !== 200 || !log.userId) return res;
  const surface = parseSurface(req.headers.get(TTS_SURFACE_HEADER));
  if (surface !== "home" && surface !== "home-share") return res;
  if (shareSignoffEnabled()) res.headers.set(SIGNOFF_AVAILABLE_HEADER, "1");
  if (!share.requested) return res;

  const line = new Uint8Array(await res.arrayBuffer());
  const result = await withSignoff(line, {
    requested: true,
    userId: log.userId,
    target: share.target
  });
  if (result.skipped && !log.errorCode) log.errorCode = result.skipped;
  log.audioBytes = result.audio.byteLength;
  const headers = new Headers(res.headers);
  headers.set(SIGNOFF_HEADER, result.signed ? "1" : "0");
  return new NextResponse(result.audio as BodyInit, { status: 200, headers });
}

async function handle(req: NextRequest, log: RequestLog, share: ShareRequest): Promise<NextResponse> {
  try {
    // FIRST, before the body is even read and long before a provider is
    // called. Until 8/19 this route answered anyone — a bare curl got 14KB of
    // ElevenLabs audio off Tom's card (ship report cdf9f02a).
    //
    // `allowAnonymous` is the /try funnel (components/AtomShell.tsx), which is
    // supposed to work without an account; lib/spendGuard.ts describes what
    // that costs and what it does not buy. Everything expensive on this route
    // stays behind a real session — see the engine check below.
    const guard = await guardSpend(req, { allowAnonymous: true });
    if (!guard.ok) {
      log.errorCode = "guard";
      return guard.response;
    }
    log.userId = guard.user?.id ?? null;

    const body = (await req.json().catch(() => ({}))) as {
      text?: string;
      engine?: string;
      sourceLanguage?: LangCode;
      targetLanguage?: LangCode;
      latency?: string;
      voice?: string;
      voiceOverride?: unknown;
      demoToken?: unknown;
      signoff?: boolean;
    };
    // Only the home card's Share may ask, and asking is all the client does:
    // whether the flag is on and the caller is free tier is decided after
    // synthesis, in shareStep.
    share.requested =
      body.signoff === true &&
      parseSurface(req.headers.get(TTS_SURFACE_HEADER)) === "home-share";
    share.target = typeof body.targetLanguage === "string" ? body.targetLanguage : null;
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const googleEnabled = process.env.TAOS_TTS_GOOGLE_ENABLED === "1";
    const engine: Engine =
      body.engine === "openai" ||
      body.engine === "fishaudio" ||
      (body.engine === "google" && googleEnabled)
        ? body.engine
        : "elevenlabs";
    const latency = body.latency === "flash" ? ("flash" as const) : undefined;
    const voice: VoiceOverride | undefined =
      body.voice === "tom" || body.voice === "liz" ? body.voice : undefined;

    log.requestedEngine = typeof body.engine === "string" ? body.engine.slice(0, 20) : null;
    log.textChars = text.length;
    log.lang = typeof body.targetLanguage === "string" ? body.targetLanguage.slice(0, 12) : null;
    log.sourceLang =
      typeof body.sourceLanguage === "string" ? body.sourceLanguage.slice(0, 12) : null;

    if (!text) {
      log.errorCode = "text_required";
      return NextResponse.json({ error: "Text is required." }, { status: 400 });
    }

    // What the /try funnel is allowed to request: OpenAI's voice, a sentence
    // at a time. The guarded request may use one ElevenLabs STOCK fallback
    // when OpenAI fails, but an anonymous caller can never select ElevenLabs
    // directly or reach a clone. That keeps the fallback inside the same
    // per-IP/global allowance instead of creating an unmetered second path.
    if (guard.anonymous) {
      if (engine !== "openai") {
        log.errorCode = "anon_engine";
        return NextResponse.json({ error: SIGN_IN_REQUIRED }, { status: 401 });
      }
      if (text.length > ANON_MAX_CHARS) {
        log.errorCode = "anon_too_long";
        return NextResponse.json(
          { error: "That is too long for the free trial. Please sign in." },
          { status: 413 }
        );
      }
    }

    // Tier 2 (lib/languages/catalog.ts): no engine wired up here can speak
    // this language. Sending the text anyway gets either a 502 or — worse —
    // confident audio in the wrong language's phonology, which a listener has
    // no way to recognize as a failure. Say what is true instead.
    //
    // /translate never reaches this: it asks canSpeak() before it calls, and
    // shows "text only" on the pill. This is the fence for everything that
    // doesn't ask — and it is deliberately narrow, firing only for a language
    // the catalog KNOWS it cannot speak. An unrecognized code keeps the old
    // pass-through behavior (default voice, no opinion) rather than becoming a
    // new way for an existing caller to start failing.
    if (isLanguageCode(body.targetLanguage) && !canSpeak(body.targetLanguage)) {
      log.errorCode = "text_only";
      return NextResponse.json(
        { error: "This language is text only.", textOnly: true },
        { status: 422 }
      );
    }

    // /demo ("Tu voz"): speak in a stranger's ten-minute instant clone. The
    // ONLY way a client names an ElevenLabs voice id on this route, so it is
    // fenced four ways — flag, founder session, a token the clone route signed
    // for this exact voice and founder, and the line cap — and a refusal is a
    // refusal: no fallback to another voice (lib/demo/server.ts says why).
    if (body.voiceOverride !== undefined) {
      return await demoVoice(text, body.voiceOverride, body.demoToken, guard.user, log, body.targetLanguage);
    }

    // Wrong or absent code -> locked -> default voice. Deliberately silent:
    // a stranger gets working audio and no sign the clones exist.
    const unlocked = personalVoiceUnlocked(
      req.headers.get(PERSONAL_VOICE_HEADER),
      process.env.TAOS_PERSONAL_VOICE_CODE
    );

    if (engine === "google") {
      const googleVoice = googleVoiceFor(body.targetLanguage);
      if (!googleVoice) {
        log.errorCode = "text_only";
        return NextResponse.json(
          { error: "This language is text only.", textOnly: true },
          { status: 422 }
        );
      }
      log.unlocked = unlocked;
      log.engine = "google";
      log.voiceId = googleVoice.voiceName;
      log.voiceRole = "stock";
      return await googleCloud(text, googleVoice, log, body.targetLanguage);
    }

    // Which provider, which id, whose voice — one decision, shared with the log.
    const resolved: ResolvedVoice = resolveTtsVoice(
      engine,
      unlocked,
      body.sourceLanguage,
      body.targetLanguage,
      voice
    );
    log.unlocked = unlocked;
    log.engine = resolved.provider;
    log.voiceId = resolved.voiceId;
    log.voiceRole = resolved.role;

    // `await` (not a bare returned promise) so a thrown timeout lands in the
    // catch below rather than escaping the handler as a generic 500.
    if (resolved.provider === "openai") {
      return await openai(text, resolved.voiceId, log, body.targetLanguage);
    }
    if (resolved.provider === "fishaudio") {
      return await fishAudio(text, resolved.voiceId, log, latency);
    }
    return await elevenLabs(text, resolved.voiceId, log, body.targetLanguage, latency);
  } catch (error) {
    if (isTimeout(error)) {
      log.errorCode = "timeout";
      return NextResponse.json(
        { error: "The voice service took too long. Please try again." },
        { status: 504 }
      );
    }
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    log.errorCode = "exception";
    return NextResponse.json({ error: "TTS failed.", details: message }, { status: 500 });
  }
}
