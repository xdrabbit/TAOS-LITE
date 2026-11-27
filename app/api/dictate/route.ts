import { NextRequest, NextResponse } from "next/server";
import { isLanguageCode, languageLabel } from "@/lib/languages/catalog";
import { dictateVisibleTo } from "@/lib/release";
import { guardSpend } from "@/lib/spendGuard";
import { getTranscribeModel, transcribeAudio } from "@/lib/translate/transcribe";
import { getTranslateModel } from "@/lib/translate/paraphrase";
import { decodeMessage, DICTATE_RESTYLE_TIMEOUT_MS, restyle } from "@/lib/dictate/restyle";
import {
  DICTATE_MAX_AUDIO_BYTES,
  DICTATE_MAX_TEXT_CHARS,
  DICTATE_SAME_LANGUAGE,
  resolveDictateStyle,
  type DictateStyle
} from "@/lib/dictate/style";

export const runtime = "nodejs";
// One two-minute recording, one transcription (60 s cap) and one chat
// completion (45 s cap): 120 leaves the sum room to fail as JSON rather than
// as Safari's "Load failed".
export const maxDuration = 120;

const TRANSCRIBE_TIMEOUT_MS = 60000;

// POST /api/dictate — three requests, one route (docs/dictate/CLAUDE.md).
//
//   multipart, `audio`            → transcribe, then restyle   (STT + chat)
//   JSON { raw, style, … }        → restyle only               (chat)
//   JSON { mode: "decode", raw }  → the Decoder: a pasted message, cleaned
//                                   and translated             (chat)
//
// Not an extension of /api/translate: that route refuses source === target,
// its prompt is an interpreter's, and it carries chunking, auto-detect, retry
// and review capture that a dictation wants none of. This one shares its
// TRANSCRIBER (lib/translate/transcribe.ts) and its model
// (getTranslateModel), and nothing else.
//
// ── What it does NOT do ────────────────────────────────────────────────────
// It writes no row anywhere. taos_lite_translations is the free monthly
// allowance AND History AND /study's lesson source AND the daily email, so a
// dictation saved there would show up in all four. Tom, 2026-11-27: no
// metering and nothing stored while this is founders-only. That is also why
// the gate below must not open to the public before metering is settled.
//
// Languages arrive as catalog CODES and the labels are looked up here. A
// label typed by the caller would be text placed straight into the system
// prompt.

const NOTHING_HEARD = "Nothing was heard — try again. · No se escuchó nada — intenta de nuevo.";
const NO_STORE = { "Cache-Control": "no-store" };

function isTimeout(e: unknown): boolean {
  return e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
}

// ── [taos-dictate-timing] ──────────────────────────────────────────────────
// One line per request that got past the gate, success or error. Codes,
// counts and milliseconds ONLY — never the transcript, the styled text, the
// pasted message, or an email.
interface DictateTiming {
  mode: "audio" | "restyle" | "decode" | "?";
  style: DictateStyle | "?";
  src: string;
  tgt: string;
  audioBytes: number | "?";
  guardMs: number | "?";
  transcribeMs: number | "?";
  modelMs: number | "?";
  srcChars: number | "?";
  outChars: number | "?";
  notes: number | "?";
  err: string;
}

function logTiming(t: DictateTiming, http: number, started: number): void {
  console.log(
    `[taos-dictate-timing] status=${http < 400 ? "ok" : "error"} http=${http} mode=${t.mode}` +
      ` style=${t.style} src=${t.src} tgt=${t.tgt} audio_bytes=${t.audioBytes}` +
      ` transcribe_ms=${t.transcribeMs} transcribe_model=${getTranscribeModel()}` +
      ` model_ms=${t.modelMs} model=${getTranslateModel()} guard_ms=${t.guardMs}` +
      ` total_ms=${Math.round(performance.now() - started)} src_chars=${t.srcChars}` +
      ` out_chars=${t.outChars} notes=${t.notes} err=${t.err}`
  );
}

function code(value: unknown): string | null {
  return typeof value === "string" && isLanguageCode(value) ? value : null;
}

/** "same", absent, or the source itself all mean: no translation. */
function targetOf(value: unknown, source: string): string | null {
  if (value == null || value === "" || value === DICTATE_SAME_LANGUAGE) return null;
  const target = code(value);
  if (!target) return "invalid";
  return target === source ? null : target;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const started = performance.now();
  // Identity, then the gate, then the 401 — all before the body is read, the
  // order /api/fast/listen keeps. guardSpend touches Supabase and never a
  // paid provider, so a stranger's upload is refused having cost nothing.
  const guard = await guardSpend(req);
  const email = guard.ok ? (guard.user?.email ?? null) : null;
  if (!dictateVisibleTo(email)) {
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  }
  if (!guard.ok) return guard.response;

  const t: DictateTiming = {
    mode: "?",
    style: "?",
    src: "?",
    tgt: "?",
    audioBytes: "?",
    guardMs: Math.round(performance.now() - started),
    transcribeMs: "?",
    modelMs: "?",
    srcChars: "?",
    outChars: "?",
    notes: "?",
    err: "?"
  };
  const done = (body: Record<string, unknown>, status = 200): NextResponse => {
    logTiming(t, status, started);
    return NextResponse.json(body, { status, headers: NO_STORE });
  };
  const fail = (err: string, message: string, status: number): NextResponse => {
    t.err = err;
    return done({ error: message }, status);
  };

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return fail("no_key", "Server misconfiguration: missing OPENAI_API_KEY.", 500);

  const isJson = (req.headers.get("content-type") ?? "").includes("application/json");

  try {
    // ── JSON: re-style, or the Decoder. No audio, so no transcription. ─────
    if (isJson) {
      const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body || typeof body !== "object") return fail("bad_json", "Request body must be JSON.", 400);
      const decode = body.mode === "decode";
      t.mode = decode ? "decode" : "restyle";

      const raw = typeof body.raw === "string" ? body.raw.trim() : "";
      t.srcChars = raw.length;
      if (!raw) return fail("empty", "There is no text to work on.", 400);
      if (raw.length > DICTATE_MAX_TEXT_CHARS) {
        return fail("too_long", "That text is too long. Try a shorter piece.", 413);
      }

      if (decode) {
        const reader = code(body.reader);
        const other = code(body.other);
        if (!reader || !other || reader === other) {
          return fail("bad_lang", "Two different languages are required.", 400);
        }
        t.src = other;
        t.tgt = reader;
        const modelStart = performance.now();
        const decoded = await decodeMessage(apiKey, raw, languageLabel(reader), languageLabel(other));
        t.modelMs = Math.round(performance.now() - modelStart);
        t.outChars = decoded.translation.length;
        t.notes = decoded.notes.length;
        return done({
          mode: "decode",
          raw,
          cleaned: decoded.cleaned,
          translation: decoded.translation,
          notes: decoded.notes,
          sourceLanguage: decoded.sourceLanguage
        });
      }

      const source = code(body.source);
      if (!source) return fail("bad_lang", "A spoken language is required.", 400);
      const target = targetOf(body.target, source);
      if (target === "invalid") return fail("bad_lang", "Unknown output language.", 400);
      const style = resolveDictateStyle(body.style);
      t.style = style;
      t.src = source;
      t.tgt = target ?? source;
      const modelStart = performance.now();
      const styled = await restyle(
        apiKey,
        raw,
        style,
        languageLabel(source),
        target ? languageLabel(target) : null
      );
      t.modelMs = Math.round(performance.now() - modelStart);
      t.outChars = styled.length;
      return done({ raw, styled, style, lang: target ?? source });
    }

    // ── Multipart: a recording. Transcribe, then restyle. ──────────────────
    t.mode = "audio";
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return fail("bad_form", "Request body must be multipart form data or JSON.", 400);
    }
    const audio = form.get("audio");
    if (!(audio instanceof File) || audio.size === 0) {
      return fail("no_audio", "An audio recording is required.", 400);
    }
    t.audioBytes = audio.size;
    if (audio.size > DICTATE_MAX_AUDIO_BYTES) {
      return fail("too_big", "That recording is too long. Keep a dictation under two minutes.", 413);
    }
    const source = code(form.get("source"));
    if (!source) return fail("bad_lang", "A spoken language is required.", 400);
    const target = targetOf(form.get("target"), source);
    if (target === "invalid") return fail("bad_lang", "Unknown output language.", 400);
    const style = resolveDictateStyle(form.get("style"));
    t.style = style;
    t.src = source;
    t.tgt = target ?? source;

    const sttStart = performance.now();
    const raw = await transcribeAudio(apiKey, audio, {
      sourceLabel: languageLabel(source),
      timeoutMs: TRANSCRIBE_TIMEOUT_MS
    });
    t.transcribeMs = Math.round(performance.now() - sttStart);
    t.srcChars = raw.length;
    // "" is the transcriber saying there was no usable speech. It stops here:
    // the model step cannot answer "nothing", so it is never asked.
    if (!raw) return fail("nothing_heard", NOTHING_HEARD, 422);

    const modelStart = performance.now();
    const styled = await restyle(
      apiKey,
      raw,
      style,
      languageLabel(source),
      target ? languageLabel(target) : null,
      DICTATE_RESTYLE_TIMEOUT_MS
    );
    t.modelMs = Math.round(performance.now() - modelStart);
    t.outChars = styled.length;
    return done({ raw, styled, style, lang: target ?? source });
  } catch (error) {
    if (isTimeout(error)) {
      return fail("timeout", "That took too long. Please try again.", 504);
    }
    const upstream = (error as { upstreamStatus?: unknown } | null)?.upstreamStatus;
    t.err = typeof upstream === "number" ? `upstream_${upstream}` : "failed";
    // No `details`: a provider error can quote the request back, and the
    // request is somebody's words.
    return done({ error: "Dictation failed. Please try again." }, 502);
  }
}
