/**
 * The WhatsApp voice-note translation pipeline.
 *
 * Voice note in → download → transcode → transcribe (auto-detect) →
 * translate (EN↔ES pair, auto direction) → TTS → OGG/Opus → voice note back.
 * Turn-based, runs entirely on Vercel serverless — no Calling API, no media
 * server. This is the marketing wedge: "send a voice note in Spanish, get
 * English back."
 *
 * Reuses the app's real pipeline pieces rather than copying them:
 * - transcription: lib/translate/transcribe.ts (the one transcriber, with
 *   Liz's no-guess rule and the fences)
 * - translation prompt: lib/translate/prompts.ts buildAutoDetectInstructions
 * - TTS: ElevenLabs direct, same model/voice selection as /api/tts, but
 *   ALWAYS the default multilingual voice (unlocked=false) — WhatsApp
 *   callers are strangers, and there is no personal-voice code out here.
 * - tier discipline: lib/languages/catalog.ts canSpeak() — a tier-2 target
 *   language gets the translation as TEXT, never confident audio in the
 *   wrong phonology.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import ffmpegStatic from "ffmpeg-static";
import { transcribeAudio } from "@/lib/translate/transcribe";
import { buildAutoDetectInstructions } from "@/lib/translate/prompts";
import { canSpeak, languageLabel } from "@/lib/languages/catalog";
import { gatedElevenLabsVoiceId } from "@/lib/tts/voice";
import {
  downloadMedia,
  markMessageRead,
  sendAudioMessage,
  sendTextMessage,
  uploadMedia
} from "./graph";

// v1 direction: the EN↔ES pair, direction auto-detected per voice note.
// Everything else the app knows (100-language catalog) is reachable later;
// the pair keeps the demo sharp and the auto-detect prompt reliable.
const PAIR_A = "en" as const;
const PAIR_B = "es" as const;

const TRANSCRIBE_TIMEOUT_MS = 60000; // voice notes are seconds, not minutes
const TRANSLATE_TIMEOUT_MS = 60000; // same cap as /api/translate's paraphrase
const SYNTH_TIMEOUT_MS = 45000; // same cap as /api/tts
const FFMPEG_TIMEOUT_MS = 30000;

// ── ffmpeg ────────────────────────────────────────────────────────────────
// Same binary-resolution pattern as app/api/video/process/route.ts:
// ffmpeg-static covers Vercel (no system ffmpeg); trust the module path only
// if the file is really there, since serverComponentsExternalPackages is
// what actually ships it (see next.config.js).

function ffmpegBinary(): string {
  if (typeof ffmpegStatic === "string" && ffmpegStatic && existsSync(ffmpegStatic)) {
    return ffmpegStatic;
  }
  const traced = join(process.cwd(), "node_modules", "ffmpeg-static", "ffmpeg");
  if (existsSync(traced)) return traced;
  return "ffmpeg";
}

/** ffmpeg with piped stdin → piped stdout: no temp files on serverless. */
function runFfmpegPipe(input: Buffer, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBinary(), ["-hide_banner", "-nostdin", ...args], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    const out: Buffer[] = [];
    let stderrTail = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("ffmpeg timed out."));
    }, FFMPEG_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderrTail}`));
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

/**
 * WhatsApp voice notes arrive as OGG/Opus. Normalize to the format the
 * transcriber is proven against (64 kbps mono 16 kHz mp3 — WHISTLER's
 * settings from app/api/video/process/route.ts).
 */
function transcodeForTranscription(oggBytes: Buffer): Promise<Buffer> {
  return runFfmpegPipe(oggBytes, [
    "-i",
    "pipe:0",
    "-vn",
    "-acodec",
    "libmp3lame",
    "-ab",
    "64k",
    "-ar",
    "16000",
    "-ac",
    "1",
    "-f",
    "mp3",
    "pipe:1"
  ]);
}

/**
 * WhatsApp renders type-"audio" messages as true voice notes ONLY for
 * OGG/Opus (mp3 arrives as an audio attachment). 48 kHz mono Opus.
 */
function transcodeForVoiceNote(mp3Bytes: Buffer): Promise<Buffer> {
  return runFfmpegPipe(mp3Bytes, [
    "-i",
    "pipe:0",
    "-vn",
    "-acodec",
    "libopus",
    "-ar",
    "48000",
    "-ac",
    "1",
    "-b:a",
    "32k",
    "-f",
    "ogg",
    "pipe:1"
  ]);
}

// ── translation ───────────────────────────────────────────────────────────

interface AutoTranslation {
  /** The language the speaker used ("en" or "es" in v1). */
  detected: typeof PAIR_A | typeof PAIR_B;
  translation: string;
}

/** Auto-detect direction within the EN↔ES pair — the /api/translate auto mode, minus the route. */
async function translateAutoDetect(apiKey: string, text: string): Promise<AutoTranslation> {
  const model = process.env.OPENAI_TRANSLATE_MODEL?.trim() || "gpt-4.1"; // full, not mini — see /api/translate
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0.2, // fidelity first — see /api/translate's 7/27 rationale
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: buildAutoDetectInstructions(
            { code: PAIR_A, label: languageLabel(PAIR_A) },
            { code: PAIR_B, label: languageLabel(PAIR_B) },
            "detailed" // preserve nuance, numbers, names — the safe default for strangers
          )
        },
        { role: "user", content: text }
      ]
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS)
  });
  const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const detail =
      payload && typeof payload === "object" ? JSON.stringify(payload) : `HTTP ${res.status}`;
    throw new Error(`Translation failed: ${detail}`);
  }
  const choices = Array.isArray(payload?.choices) ? payload.choices : [];
  const message = (choices[0] as Record<string, unknown> | undefined)?.message as
    | Record<string, unknown>
    | undefined;
  const content = typeof message?.content === "string" ? message.content : "";
  let parsed: { source_lang?: string; translation?: string } = {};
  try {
    parsed = JSON.parse(content) as { source_lang?: string; translation?: string };
  } catch {
    /* fall through to default */
  }
  const detected = parsed.source_lang === PAIR_B ? PAIR_B : PAIR_A;
  const translation = typeof parsed.translation === "string" ? parsed.translation.trim() : "";
  if (!translation) throw new Error("Translation response was empty.");
  return { detected, translation };
}

// ── speech synthesis (server-side, no /api/tts round-trip) ────────────────

async function synthesizeSpeech(
  text: string,
  targetLanguage: typeof PAIR_A | typeof PAIR_B
): Promise<Buffer> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("Missing ELEVENLABS_API_KEY.");
  // unlocked=false: no personal-voice code exists on WhatsApp. Strangers get
  // the default multilingual voice, silently — same rule as /api/tts.
  const voiceId = gatedElevenLabsVoiceId(false, undefined, targetLanguage);
  // v1 is the EN↔ES pair only, so this is the plain multilingual model. When
  // the pair widens, re-add /api/tts's yue → eleven_v3 override here.
  const model = process.env.ELEVENLABS_MODEL?.trim() || "eleven_turbo_v2_5";
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
    throw new Error(`ElevenLabs TTS failed: ${detail}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// ── orchestration ─────────────────────────────────────────────────────────

const NOTHING_HEARD =
  "I didn't catch that — try again. · No te escuché — intenta de nuevo.";
const PIPELINE_FAILED =
  "Something went wrong on my end — try again in a moment. · Algo falló de mi lado — intenta de nuevo en un momento.";
const SEND_A_VOICE_NOTE =
  "Send me a voice note and I'll translate it. 🎙️ · Mándame una nota de voz y la traduzco. 🎙️";

/** Full turn: voice note in, translated voice note (or text) back. Never throws — the user always gets an answer. */
export async function handleVoiceNote(
  from: string,
  messageId: string,
  mediaId: string
): Promise<void> {
  try {
    await markMessageRead(messageId).catch(() => {});
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Missing OPENAI_API_KEY.");

    // eslint-disable-next-line no-console
    console.log(`[taos.whatsapp] voice note in · from=${from} · msg=${messageId}`);

    const { bytes } = await downloadMedia(mediaId);
    const mp3 = await transcodeForTranscription(bytes);
    const original = await transcribeAudio(
      apiKey,
      new File([new Uint8Array(mp3)], "voice.mp3", { type: "audio/mpeg" }),
      { timeoutMs: TRANSCRIBE_TIMEOUT_MS }
    );
    if (!original) {
      await sendTextMessage(from, NOTHING_HEARD);
      return;
    }

    const { detected, translation } = await translateAutoDetect(apiKey, original);
    const target = detected === PAIR_A ? PAIR_B : PAIR_A;

    // eslint-disable-next-line no-console
    console.log(
      `[taos.whatsapp] translated · from=${from} · ${detected}->${target} · "${original.slice(0, 60)}"`
    );

    if (!canSpeak(target)) {
      // Tier-2 discipline: text, never confident audio in the wrong phonology.
      await sendTextMessage(from, translation);
      return;
    }

    const speechMp3 = await synthesizeSpeech(translation, target);
    const voiceNote = await transcodeForVoiceNote(speechMp3);
    const replyMediaId = await uploadMedia(voiceNote, "audio/ogg", "reply.ogg");
    await sendAudioMessage(from, replyMediaId);
  } catch (error) {
    // Log-and-answer: the user sent a voice note and is waiting. They get a
    // bilingual apology, never silence, never provider JSON.
    // eslint-disable-next-line no-console
    console.log(
      `[taos.whatsapp] pipeline failed · from=${from} · msg=${messageId} · ${error instanceof Error ? error.message : error}`
    );
    try {
      await sendTextMessage(from, PIPELINE_FAILED);
    } catch {
      /* the send itself failed — nothing left to do */
    }
  }
}

/** Any non-voice-note message gets the one-line nudge. Never throws. */
export async function handleTextMessage(from: string, messageId: string): Promise<void> {
  try {
    await markMessageRead(messageId).catch(() => {});
    await sendTextMessage(from, SEND_A_VOICE_NOTE);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.log(
      `[taos.whatsapp] nudge failed · from=${from} · ${error instanceof Error ? error.message : error}`
    );
  }
}
