import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { POST as speakLine } from "@/app/api/tts/route";
import { getLanguageLabel, isSupportedLanguageCode } from "@/lib/realtime/languages";
import { canSpeak } from "@/lib/languages/catalog";
import { parseContextField } from "@/lib/translate/context";
import { buildInstructions } from "@/lib/translate/prompts";
import { transcribeAudio } from "@/lib/translate/transcribe";
import { chatCompletion, getOpenAIKey } from "@/lib/translateProvider";
import { PERSONAL_VOICE_HEADER } from "@/lib/tts/personalVoice";
import { TTS_STANDALONE_HEADER, TTS_SURFACE_HEADER } from "@/lib/tts/deviceHints";
import { walkieEnabled } from "@/lib/walkie/flag";
import { walkieNotFound } from "@/lib/walkie/guard";
import { guardSpend } from "@/lib/spendGuard";
import { isFounder } from "@/lib/release";
import { isWalkieRoom, normalizeWalkieRoom } from "@/lib/walkie/room";
import {
  countWalkieTurnAsHomeTurn,
  insertWalkieMessage,
  removeWalkieAudio,
  signWalkieAudio,
  uploadWalkieAudio,
  walkieAudioPath,
  WalkieStoreError
} from "@/lib/walkie/store";
import {
  formatWalkieTiming,
  walkieErrorCode,
  type StoredTimings,
  type WalkieTimingFields
} from "@/lib/walkie/timing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The turn is capped at TAOS_WALKIE_MAX_TURN_MS (30s by default) but the
// knob can go to five minutes, so this matches /api/translate's ceiling.
export const maxDuration = 300;

// POST /api/walkie/turn — one hold-talk-release turn, end to end.
//
// The sender's phone uploads the recording and says which language it was
// spoken in (its owner's) and which it must come out in (the PARTNER's,
// read from presence — lib/walkie/channel.ts). This route is the home
// pipeline in one request: transcribe → translate → speak, the same
// transcriber (lib/translate/transcribe.ts), the same prompt and model
// (lib/translate/prompts.ts, OPENAI_TRANSLATE_MODEL), the same 3-turn
// context field, and the same /api/tts handler — invoked directly, with the
// sender's Authorization and personal-voice headers forwarded, so the clone
// follows the SPEAKER exactly as it does on "/" (lib/tts/voice.ts). Then the
// two audio objects and the row are stored, a home-history row is written
// so the turn counts like a home turn, and the one timing line is logged.
//
// Nothing hard-coded about models: every engine knob is the existing env var.

const MAX_AUDIO_BYTES = 4 * 1024 * 1024; // under Vercel's 4.5 MB body limit
const MAX_TEXT_CHARS = 4000;

function translateModel(): string {
  // Same default as app/api/translate/route.ts, same reason: full gpt-4.1,
  // not the latency-pinned OPENAI_PARAPHRASE_MODEL.
  return process.env.OPENAI_TRANSLATE_MODEL?.trim() || "gpt-4.1";
}

function since(t0: number): number {
  return Math.round(performance.now() - t0);
}

function intField(form: FormData, name: string): number | null {
  const raw = form.get(name);
  if (typeof raw !== "string") return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

type Stage = "guard" | "form" | "store_rec" | "transcribe" | "translate" | "tts" | "store_say" | "insert";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const started = performance.now();
  const t: WalkieTimingFields = {
    status: "error",
    http: 500,
    recMs: "?",
    uploadMs: "?",
    transcribeMs: "?",
    translateMs: "?",
    ttsMs: "?",
    deliverMs: "?",
    releaseToPlayMs: "?",
    busyBlocked: "?",
    cancelled: "?",
    src: "?",
    tgt: "?",
    audioBytes: "?",
    srcChars: "?",
    outChars: "?",
    totalMs: "?",
    err: "?"
  };
  let res: NextResponse | undefined;
  try {
    res = await handle(req, t);
    return res;
  } finally {
    t.http = res?.status ?? 500;
    t.status = t.http >= 200 && t.http < 300 ? "ok" : "error";
    t.totalMs = since(started);
    if (t.status === "ok") t.err = "?";
    else if (t.err === "?") t.err = "unhandled";
    console.log(formatWalkieTiming(t));
  }
}

async function handle(req: NextRequest, t: WalkieTimingFields): Promise<NextResponse> {
  let stage: Stage = "guard";
  let stageStarted = performance.now();
  const uploaded: string[] = [];
  try {
    // The three steps of lib/walkie/guard.ts, spelled out here because this
    // is the route that spends: the flag (404 before anything), guardSpend
    // (401, lib/spendGuard.ts, unweakened), the founder (404 for anyone else).
    if (!walkieEnabled()) {
      t.err = "flag_off";
      return walkieNotFound();
    }
    const guard = await guardSpend(req);
    if (!guard.ok) {
      t.err = "guard_blocked";
      return guard.response;
    }
    const user = guard.user;
    if (!user || !isFounder(user.email)) {
      t.err = "not_founder";
      return walkieNotFound();
    }

    const apiKey = getOpenAIKey();
    if (!apiKey) {
      t.err = "missing_api_key";
      return NextResponse.json({ error: "Server misconfiguration: missing OPENAI_API_KEY." }, { status: 500 });
    }

    stage = "form";
    stageStarted = performance.now();
    const form = await req.formData();
    t.uploadMs = since(stageStarted);

    const audio = form.get("audio");
    const room = normalizeWalkieRoom(form.get("room"));
    const sourceLanguage = String(form.get("sourceLanguage") ?? "");
    const targetLanguage = String(form.get("targetLanguage") ?? "");
    const engineRaw = String(form.get("engine") ?? "");
    const context = parseContextField(form.get("context"));
    const recMs = intField(form, "rec_ms");
    const releasedAtMs = intField(form, "released_at");
    const busyBlocked = intField(form, "busy_blocked");
    const cancelledRaw = String(form.get("cancelled") ?? "");
    const cancelled: 0 | 1 = cancelledRaw === "1" ? 1 : 0;

    t.recMs = recMs ?? "?";
    t.busyBlocked = busyBlocked ?? "?";
    t.cancelled = cancelled;
    t.src = isSupportedLanguageCode(sourceLanguage) ? sourceLanguage : "?";
    t.tgt = isSupportedLanguageCode(targetLanguage) ? targetLanguage : "?";
    if (audio instanceof File) t.audioBytes = audio.size;

    if (!isWalkieRoom(room)) {
      t.err = "bad_room";
      return NextResponse.json({ error: "Channel code is not valid." }, { status: 400 });
    }
    if (!(audio instanceof File) || audio.size === 0) {
      t.err = "no_audio";
      return NextResponse.json({ error: "An audio recording is required." }, { status: 400 });
    }
    if (audio.size > MAX_AUDIO_BYTES) {
      t.err = "audio_too_large";
      return NextResponse.json({ error: "That recording is too long." }, { status: 413 });
    }
    if (!isSupportedLanguageCode(sourceLanguage) || !isSupportedLanguageCode(targetLanguage)) {
      t.err = "unsupported_pair";
      return NextResponse.json({ error: "Unsupported language pair." }, { status: 400 });
    }
    if (sourceLanguage === targetLanguage) {
      // The partner's language is the target. Two phones set to the same
      // language have nothing to translate — say so rather than echo.
      t.err = "same_language";
      return NextResponse.json({ error: "You and your partner are set to the same language." }, { status: 400 });
    }

    const sourceLabel = getLanguageLabel(sourceLanguage);
    const targetLabel = getLanguageLabel(targetLanguage);
    const mime = audio.type || "audio/webm";
    const id = crypto.randomUUID();

    // The recording first — it is the message; everything after is derived.
    stage = "store_rec";
    stageStarted = performance.now();
    const recPath = walkieAudioPath(room, id, "rec", mime);
    await uploadWalkieAudio(recPath, await audio.arrayBuffer(), mime);
    uploaded.push(recPath);

    stage = "transcribe";
    stageStarted = performance.now();
    const original = (await transcribeAudio(apiKey, audio, { sourceLabel })).slice(0, MAX_TEXT_CHARS);
    t.transcribeMs = since(stageStarted);
    t.srcChars = original.length;
    if (!original) {
      await removeWalkieAudio(uploaded);
      t.err = "nothing_heard";
      return NextResponse.json(
        { error: "Nothing was heard — try again. · No se escuchó nada — intenta de nuevo." },
        { status: 422 }
      );
    }

    stage = "translate";
    stageStarted = performance.now();
    const translation = (
      await chatCompletion(apiKey, {
        model: translateModel(),
        temperature: 0.2, // both tones — see app/api/translate/route.ts paraphrase()
        messages: [
          { role: "system", content: buildInstructions(sourceLabel, targetLabel, "detailed", context) },
          { role: "user", content: original }
        ]
      })
    )
      .trim()
      .slice(0, MAX_TEXT_CHARS);
    t.translateMs = since(stageStarted);
    t.outChars = translation.length;
    if (!translation) throw new Error("Translation response was empty.");

    // Speak it, in the sender's voice, through the one TTS door — the real
    // /api/tts handler with the sender's own headers. A tier-2 target gets
    // text only, exactly as the home card would.
    stage = "tts";
    stageStarted = performance.now();
    let speechPath: string | null = null;
    let speechEngine: string | null = null;
    if (canSpeak(targetLanguage)) {
      const engine = engineRaw === "openai" || engineRaw === "fishaudio" || engineRaw === "google" ? engineRaw : "elevenlabs";
      const headers = new Headers({ "Content-Type": "application/json" });
      const auth = req.headers.get("authorization");
      if (auth) headers.set("authorization", auth);
      const voiceKey = req.headers.get(PERSONAL_VOICE_HEADER);
      if (voiceKey) headers.set(PERSONAL_VOICE_HEADER, voiceKey);
      headers.set(TTS_SURFACE_HEADER, "walkie");
      headers.set(TTS_STANDALONE_HEADER, req.headers.get(TTS_STANDALONE_HEADER) ?? "0");
      const ua = req.headers.get("user-agent");
      if (ua) headers.set("user-agent", ua);
      const ttsReq = new NextRequest(new URL("/api/tts", req.url), {
        method: "POST",
        headers,
        body: JSON.stringify({ text: translation, engine, sourceLanguage, targetLanguage })
      });
      const ttsRes = await speakLine(ttsReq);
      t.ttsMs = since(stageStarted);
      if (ttsRes.status === 200) {
        const mp3 = await ttsRes.arrayBuffer();
        speechEngine = ttsRes.headers.get("X-TTS-Engine");
        stage = "store_say";
        stageStarted = performance.now();
        speechPath = walkieAudioPath(room, id, "say", "audio/mpeg");
        await uploadWalkieAudio(speechPath, mp3, "audio/mpeg");
        uploaded.push(speechPath);
      } else if (ttsRes.status !== 422) {
        // A provider failure is not the end of the turn: the text still goes
        // through, and the log says the voice did not. 422 is "text only".
        const body = (await ttsRes.json().catch(() => null)) as { error?: string } | null;
        console.warn(`[taos-walkie] tts_failed http=${ttsRes.status} code=${(body?.error ?? "?").replace(/[^0-9A-Za-z_ ]/g, "").slice(0, 40)}`);
      }
    } else {
      t.ttsMs = 0;
    }

    const timings: StoredTimings = {
      rec_ms: recMs ?? undefined,
      upload_ms: typeof t.uploadMs === "number" ? t.uploadMs : undefined,
      transcribe_ms: typeof t.transcribeMs === "number" ? t.transcribeMs : undefined,
      translate_ms: typeof t.translateMs === "number" ? t.translateMs : undefined,
      tts_ms: typeof t.ttsMs === "number" ? t.ttsMs : undefined,
      busy_blocked: busyBlocked ?? undefined,
      cancelled
    };

    stage = "insert";
    stageStarted = performance.now();
    const row = await insertWalkieMessage({
      room,
      senderId: user.id,
      sourceLang: sourceLanguage,
      targetLang: targetLanguage,
      originalText: original,
      translationText: translation,
      audioPath: recPath,
      speechPath,
      speechEngine,
      recMs,
      timings,
      releasedAt: releasedAtMs ? new Date(releasedAtMs) : null
    });

    // Counted like a home turn — after the row exists, never blocking it.
    waitUntil(
      countWalkieTurnAsHomeTurn({
        senderId: user.id,
        sourceLang: sourceLanguage,
        targetLang: targetLanguage,
        originalText: original,
        translationText: translation
      }).catch(() => false)
    );

    const speechUrl = await signWalkieAudio(speechPath);
    return NextResponse.json(
      { message: { ...row, speech_url: speechUrl } },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    t.err = error instanceof WalkieStoreError ? error.code : walkieErrorCode(stage, error);
    if (stage === "form") t.uploadMs = since(stageStarted);
    if (stage === "transcribe") t.transcribeMs = since(stageStarted);
    if (stage === "translate") t.translateMs = since(stageStarted);
    if (stage === "tts") t.ttsMs = since(stageStarted);
    // Never strand audio behind a failed turn.
    if (uploaded.length > 0) await removeWalkieAudio(uploaded).catch(() => undefined);
    const timeout = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
    if (timeout) {
      return NextResponse.json({ error: "The translation service took too long. Please try again." }, { status: 504 });
    }
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    return NextResponse.json({ error: "Taokie turn failed.", details: message }, { status: 502 });
  }
}
