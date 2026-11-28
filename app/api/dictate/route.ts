import { NextRequest, NextResponse } from "next/server";
import { isLanguageCode, languageLabel } from "@/lib/languages/catalog";
import { dictateVisibleTo } from "@/lib/release";
import { guardSpend } from "@/lib/spendGuard";
import { getTranscribeModel, transcribeAudio } from "@/lib/translate/transcribe";
import { getTranslateModel } from "@/lib/translate/paraphrase";
import { parseWords, wordsTranscribeHint } from "@/lib/dictate/words";
import { dialectLabel, parseDialects } from "@/lib/dictate/dialect";
import { decodeMessage, DICTATE_RESTYLE_TIMEOUT_MS, livePiece, restyle, summarizeLive } from "@/lib/dictate/restyle";
import { LIVE_MAX_SUMMARY_CHARS, liveTranscribeHint, type LiveSide } from "@/lib/dictate/live";
import {
  DICTATE_MAX_AUDIO_BYTES,
  DICTATE_MAX_CHUNKS,
  DICTATE_MAX_REPORTED_MS,
  DICTATE_MAX_TEXT_CHARS,
  DICTATE_MAX_TRANSCRIPT_CHARS,
  DICTATE_SAME_LANGUAGE,
  resolveDictateStyle,
  type DictateStyle
} from "@/lib/dictate/style";
import {
  parsePriorField,
  stitchTranscripts,
  translateTimeoutFor,
  weaveTranslations,
  type ChunkResult
} from "@/lib/translate/longTurn";

export const runtime = "nodejs";
// The longest request is a long dictation's last: one chunk's transcription
// (90 s cap) and one rewrite of up to ten minutes of text (150 s cap). 300
// leaves the sum room to fail as JSON rather than as Safari's "Load failed".
export const maxDuration = 300;

// One chunk is at most 4.5 minutes of audio. One attempt: the phone retries.
const TRANSCRIBE_TIMEOUT_MS = 90000;

// POST /api/dictate — one route (docs/dictate/CLAUDE.md has the contract).
//
//   multipart, `audio`                → transcribe, then restyle (STT + chat)
//   multipart, `audio`, chunk_part=1  → a long dictation's EARLIER chunk:
//                                       transcribe only          (STT)
//   multipart, `prior` (+ `audio`)    → its LAST chunk: transcribe, stitch
//                                       with the earlier ones, restyle the
//                                       whole text ONCE          (STT + chat)
//   JSON { raw, style, … }            → restyle only             (chat)
//   JSON { mode: "decode", raw }      → the Decoder: a pasted message,
//                                       cleaned and translated   (chat)
//   multipart, mode=live, `audio`     → Live notes: one piece of a room,
//                                       heard + translated       (STT + chat)
//   JSON { mode: "summarize", raw }   → Live notes: the finished transcript,
//                                       title + summary + points (chat)
//
// ── Who may call ───────────────────────────────────────────────────────────
// `Authorization: Bearer <Supabase access token>`, verified with Supabase on
// every request (lib/authServer.ts, through guardSpend). There is no cookie:
// the web screen sends the same header (lib/authClient.ts), so the iOS app
// signs in to the same project and calls this exactly as the website does.
// No token, or one Supabase will not vouch for (expired, forged): 401 — the
// app's cue to refresh and try again. A real user who is not a founder: 404.
// No CORS headers are set, on purpose: a native app needs none, and the web
// screen is same-origin.
//
// ── Ten minutes, in chunks ─────────────────────────────────────────────────
// A dictation runs up to ten minutes and is recorded the way a long home
// turn is (lib/translate/longTurn.ts): in chunks, each its own request, the
// earlier ones transcribed while the speaker is still talking. That is what
// keeps every request inside Vercel's 4.5 MB body limit and this function's
// 300 s. The transcripts travel back with the last chunk — this route keeps
// nothing between requests — and the rewrite runs once, on all of it.
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
  mode: "audio" | "part" | "restyle" | "decode" | "live" | "summary" | "?";
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
  /** Chunks in this dictation so far, and how many of them were lost. */
  chunks: number | "?";
  lost: number | "?";
  /** How many "our words" came with the request — the count, never the words. */
  words: number | "?";
  /** How many languages came with a dialect (codes only, and only the count). */
  dialects: number | "?";
  err: string;
}

function logTiming(t: DictateTiming, http: number, started: number): void {
  console.log(
    `[taos-dictate-timing] status=${http < 400 ? "ok" : "error"} http=${http} mode=${t.mode}` +
      ` style=${t.style} src=${t.src} tgt=${t.tgt} audio_bytes=${t.audioBytes}` +
      ` transcribe_ms=${t.transcribeMs} transcribe_model=${getTranscribeModel()}` +
      ` model_ms=${t.modelMs} model=${getTranslateModel()} guard_ms=${t.guardMs}` +
      ` total_ms=${Math.round(performance.now() - started)} src_chars=${t.srcChars}` +
      ` out_chars=${t.outChars} notes=${t.notes} chunks=${t.chunks} lost=${t.lost} words=${t.words} dialects=${t.dialects} err=${t.err}`
  );
}

function intField(form: FormData, name: string): number | null {
  const raw = form.get(name);
  if (typeof raw !== "string") return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
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
  // Identity, then the 401, then the gate — all before the body is read.
  // guardSpend touches Supabase and never a paid provider, so a stranger's
  // upload is refused having cost nothing.
  //
  // 401 comes BEFORE the 404. Tom's brief of 2026-11-27 for the iOS app asks
  // for: missing token 401, bad/expired token 401, non-founder 404. The first
  // build had the gate first, which answered all three 404 — so the order
  // moved. A missing, expired or forged token must read as "sign in again",
  // which a client can act on; the 404 is for someone Supabase vouches for
  // who is not let in.
  const guard = await guardSpend(req);
  if (!guard.ok) return guard.response;
  const email = guard.user?.email ?? null;
  if (!dictateVisibleTo(email)) {
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  }

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
    chunks: "?",
    lost: "?",
    words: "?",
    dialects: "?",
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

      // Live notes, end of session: the transcript in, notes for the reader out.
      if (body.mode === "summarize") {
        t.mode = "summary";
        const reader = code(body.reader);
        if (!reader) return fail("bad_lang", "A reader language is required.", 400);
        t.src = reader;
        t.tgt = reader;
        const transcript = typeof body.raw === "string" ? body.raw.trim() : "";
        t.srcChars = transcript.length;
        if (!transcript) return fail("empty", "There is no text to work on.", 400);
        if (transcript.length > LIVE_MAX_SUMMARY_CHARS) {
          return fail("too_long", "That conversation is too long to summarize.", 413);
        }
        const modelStart = performance.now();
        const notes = await summarizeLive(
          apiKey,
          transcript,
          languageLabel(reader),
          translateTimeoutFor(transcript.length, DICTATE_RESTYLE_TIMEOUT_MS)
        );
        t.modelMs = Math.round(performance.now() - modelStart);
        t.outChars = notes.summary.length;
        t.notes = notes.points.length;
        return done({ mode: "summarize", ...notes });
      }

      const decode = body.mode === "decode";
      t.mode = decode ? "decode" : "restyle";

      const raw = typeof body.raw === "string" ? body.raw.trim() : "";
      const words = parseWords(body.words);
      t.words = words.length;
      const dialects = parseDialects(body.dialects);
      t.dialects = Object.keys(dialects).length;
      t.srcChars = raw.length;
      if (!raw) return fail("empty", "There is no text to work on.", 400);
      // A pasted message and a transcript have different ceilings: a
      // re-style must take back anything a ten-minute dictation produced.
      if (raw.length > (decode ? DICTATE_MAX_TEXT_CHARS : DICTATE_MAX_TRANSCRIPT_CHARS)) {
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
        const decoded = await decodeMessage(
          apiKey,
          raw,
          languageLabel(reader),
          languageLabel(other),
          DICTATE_RESTYLE_TIMEOUT_MS,
          {
            words,
            readerDialect: dialectLabel(dialects, reader),
            otherDialect: dialectLabel(dialects, other)
          }
        );
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
        target ? languageLabel(target) : null,
        translateTimeoutFor(raw.length, DICTATE_RESTYLE_TIMEOUT_MS),
        {
          words,
          sourceDialect: dialectLabel(dialects, source),
          targetDialect: dialectLabel(dialects, target)
        }
      );
      t.modelMs = Math.round(performance.now() - modelStart);
      t.outChars = styled.length;
      return done({ raw, styled, style, lang: target ?? source });
    }

    // ── Multipart: a recording, or one chunk of a long one. ────────────────
    t.mode = "audio";
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return fail("bad_form", "Request body must be multipart form data or JSON.", 400);
    }

    // ── Live notes: one piece of a room, cut at a pause by the phone. ──────
    // Two-way: the piece may be either language of the pair, and comes back
    // with a faithful translation into the other. Same language on both sides
    // is plain note-taking. Silence is 422, which the phone skips quietly.
    if (form.get("mode") === "live") {
      t.mode = "live";
      const mineCode = code(form.get("mine"));
      const theirsCode = code(form.get("theirs"));
      if (!mineCode || !theirsCode) return fail("bad_lang", "Two languages are required.", 400);
      t.src = theirsCode;
      t.tgt = mineCode;
      const audio = form.get("audio");
      if (!(audio instanceof File) || audio.size === 0) {
        return fail("no_audio", "An audio recording is required.", 400);
      }
      t.audioBytes = audio.size;
      if (audio.size > DICTATE_MAX_AUDIO_BYTES) {
        return fail("too_big", "That piece is too large for one request.", 413);
      }
      const words = parseWords(form.get("words"));
      t.words = words.length;
      const dialects = parseDialects(form.get("dialects"));
      t.dialects = Object.keys(dialects).length;
      const side = (c: string): LiveSide => ({
        code: c,
        label: languageLabel(c),
        dialect: dialectLabel(dialects, c)
      });
      const mine = side(mineCode);
      const theirs = side(theirsCode);
      const context = typeof form.get("context") === "string" ? (form.get("context") as string) : "";

      const sttStart = performance.now();
      const heard = await transcribeAudio(apiKey, audio, {
        // One language: a hint sharpens it. Two: let the model hear which.
        sourceLabel: mineCode === theirsCode ? mine.label : undefined,
        extraHint: liveTranscribeHint(mine, theirs, wordsTranscribeHint(words)),
        timeoutMs: TRANSCRIBE_TIMEOUT_MS
      });
      t.transcribeMs = Math.round(performance.now() - sttStart);
      t.srcChars = heard.length;
      if (!heard.trim()) return fail("nothing_heard", NOTHING_HEARD, 422);

      const modelStart = performance.now();
      const piece = await livePiece(apiKey, heard, context, mine, theirs, words);
      t.modelMs = Math.round(performance.now() - modelStart);
      t.src = piece.heardLang;
      t.tgt = piece.textLang;
      t.outChars = piece.text.length;
      return done({ mode: "live", ...piece });
    }

    // The long turn's fields, as /api/translate reads them:
    //   chunk_part=1  an earlier chunk — transcribe it, answer with its text
    //   prior         this is the LAST chunk; these are the earlier ones
    // Neither: a dictation that fit in one recording, handled as it always was.
    const isPart = form.get("chunk_part") === "1";
    const priorRaw = form.get("prior");
    const chunkMs = intField(form, "chunk_ms") ?? 0;
    let prior: ChunkResult[] | null = null;
    if (isPart) t.mode = "part";
    if (isPart || priorRaw !== null) {
      const index = intField(form, "chunk_index") ?? 0;
      t.chunks = index + 1;
      if (index >= DICTATE_MAX_CHUNKS || (isPart && priorRaw !== null)) {
        return fail("bad_chunk", "Malformed long-dictation request.", 400);
      }
      if (!isPart) {
        prior = parsePriorField(priorRaw, DICTATE_MAX_CHUNKS);
        if (!prior) return fail("bad_prior", "Malformed long-dictation request.", 400);
        t.chunks = prior.length + 1;
        const reported = prior.reduce((sum, part) => sum + part.ms, chunkMs);
        if (reported > DICTATE_MAX_REPORTED_MS) {
          return fail("too_long", "That dictation is too long. Keep it under ten minutes.", 413);
        }
      }
    }

    const audioField = form.get("audio");
    // The last request of a long dictation may carry no audio of its own: the
    // speaker stopped in the instant after a chunk rolled. Everything else
    // needs a recording.
    const audio = audioField instanceof File && audioField.size > 0 ? audioField : null;
    if (!audio && !prior) return fail("no_audio", "An audio recording is required.", 400);
    if (audio) {
      t.audioBytes = audio.size;
      if (audio.size > DICTATE_MAX_AUDIO_BYTES) {
        return fail("too_big", "That recording is too large for one request. Send a long dictation in chunks.", 413);
      }
    }
    const source = code(form.get("source"));
    if (!source) return fail("bad_lang", "A spoken language is required.", 400);
    t.src = source;
    const words = parseWords(form.get("words"));
    t.words = words.length;
    const dialects = parseDialects(form.get("dialects"));
    t.dialects = Object.keys(dialects).length;
    const extraHint = wordsTranscribeHint(words);

    // ── An earlier chunk: its transcript, and nothing else. ────────────────
    if (isPart) {
      const sttStart = performance.now();
      const text = await transcribeAudio(apiKey, audio as File, {
        sourceLabel: languageLabel(source),
        extraHint,
        timeoutMs: TRANSCRIBE_TIMEOUT_MS
      });
      t.transcribeMs = Math.round(performance.now() - sttStart);
      t.srcChars = text.length;
      // "" is a quiet chunk, not an error: the dictation goes on around it.
      return done({ chunk: { index: (t.chunks as number) - 1, text, ms: chunkMs } });
    }

    const target = targetOf(form.get("target"), source);
    if (target === "invalid") return fail("bad_lang", "Unknown output language.", 400);
    const style = resolveDictateStyle(form.get("style"));
    t.style = style;
    t.tgt = target ?? source;

    let heard: string | null = "";
    if (audio) {
      const sttStart = performance.now();
      try {
        heard = await transcribeAudio(apiKey, audio, {
          sourceLabel: languageLabel(source),
          extraHint,
          timeoutMs: TRANSCRIBE_TIMEOUT_MS
        });
      } catch (error) {
        // One recording: there is nothing else to write up. A long
        // dictation: this chunk is lost and marked, and the rest goes through.
        if (!prior) throw error;
        heard = null;
      }
      t.transcribeMs = Math.round(performance.now() - sttStart);
    }

    const parts: ChunkResult[] = prior
      ? audio
        ? [...prior, { text: heard, ms: chunkMs }]
        : prior
      : [{ text: heard, ms: chunkMs }];
    const stitched = stitchTranscripts(parts, source);
    const raw = stitched.text;
    t.lost = stitched.failed;
    t.srcChars = raw.length;
    // Nothing usable in any chunk. It stops here: the model step cannot
    // answer "nothing", so it is never asked. (Chunks that were all LOST are
    // a failure, not silence.)
    if (!stitched.heard) {
      if (stitched.failed > 0) return fail("all_lost", "Dictation failed. Please try again.", 502);
      return fail("nothing_heard", NOTHING_HEARD, 422);
    }

    const modelStart = performance.now();
    const sourceLabel = languageLabel(source);
    const targetLabel = target ? languageLabel(target) : null;
    const write = (text: string) =>
      restyle(
        apiKey,
        text,
        style,
        sourceLabel,
        targetLabel,
        translateTimeoutFor(text.length, DICTATE_RESTYLE_TIMEOUT_MS),
        {
          words,
          sourceDialect: dialectLabel(dialects, source),
          targetDialect: dialectLabel(dialects, target)
        }
      );
    // The rewrite runs ONCE over the whole dictation. Only when a chunk was
    // lost is each run of speech written on its own, with the marker placed
    // between them here — a model handed "[audio lost 4:30]" inside the text
    // drops it (measured for home, lib/translate/longTurn.ts).
    const styled =
      stitched.failed === 0
        ? await write(raw)
        : weaveTranslations(
            stitched.pieces,
            await Promise.all(
              stitched.pieces.flatMap((piece) => (piece.kind === "text" ? [write(piece.text)] : []))
            ),
            target ?? source
          );
    t.modelMs = Math.round(performance.now() - modelStart);
    t.outChars = styled.length;
    return done({
      raw,
      styled,
      style,
      lang: target ?? source,
      ...(prior ? { chunks: stitched.chunks, lost: stitched.failed } : {})
    });
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
