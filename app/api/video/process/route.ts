import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegStatic from "ffmpeg-static";
import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authServer";
import {
  getLanguageLabel,
  isSupportedLanguageCode,
  type SupportedLanguageCode
} from "@/lib/realtime/languages";
import { hasServiceRoleKey, supabaseAdmin } from "@/lib/supabaseAdmin";
import { buildCaptionTranslationInstructions, STT_NO_GUESS_RULE } from "@/lib/translate/prompts";
import { chatCompletion, getOpenAIKey } from "@/lib/translateProvider";
import { batchSegments, whisperLanguageToCode, type CaptionSegment } from "@/lib/video/captions";
import { MAX_VIDEO_BYTES, VIDEO_BUCKET } from "@/lib/video/storage";

export const runtime = "nodejs";
// Same ceiling as /api/translate: 300s is the max on Vercel Pro. The stage
// timeouts below must sum comfortably under it so a stall becomes a fast JSON
// error, not a dead socket (see the 7/19 incident note in that route).
export const maxDuration = 300;

const FFMPEG_TIMEOUT_MS = 90000;
const TRANSCRIBE_TIMEOUT_MS = 180000;

// whisper-1's upload cap is 25 MB. At the 64 kbps mono encode below that is
// ~52 minutes of audio, so the practical video-length ceiling is ~50 minutes —
// far past the 300 MB upload cap for phone footage anyway.
const MAX_AUDIO_BYTES = 24.5 * 1024 * 1024;

// ffmpeg-static covers Vercel (no system ffmpeg); on blackbird either works.
function ffmpegBinary(): string {
  return (typeof ffmpegStatic === "string" && ffmpegStatic) || "ffmpeg";
}

// WHISTLER's proven extraction settings: 64 kbps mono 16 kHz mp3 is plenty for
// speech recognition and keeps ~50 min of audio under whisper's 25 MB cap.
function extractAudio(videoPath: string, audioPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-nostdin",
      "-i", videoPath,
      "-vn",
      "-acodec", "libmp3lame",
      "-ab", "64k",
      "-ar", "16000",
      "-ac", "1",
      "-y",
      audioPath
    ];
    const child = spawn(ffmpegBinary(), args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderrTail = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("ffmpeg timed out extracting audio."));
    }, FFMPEG_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderrTail}`));
    });
  });
}

interface WhisperSegment {
  start: number;
  end: number;
  text: string;
}

interface WhisperResult {
  languageCode: string;
  duration: number;
  segments: WhisperSegment[];
}

// Timestamped transcription. This is deliberately NOT the transcribe() helper
// from /api/translate: captions need segment timestamps, which only whisper-1
// supports (verbose_json + timestamp_granularities) — gpt-4o-transcribe
// returns plain text only. Separate env var so tuning the spoken-turn model
// never silently strips the timestamps out of this route.
async function transcribeWithTimestamps(apiKey: string, audioBytes: Buffer): Promise<WhisperResult> {
  const model = process.env.OPENAI_CAPTION_STT_MODEL?.trim() || "whisper-1";
  const form = new FormData();
  form.append(
    "file",
    new File([new Uint8Array(audioBytes)], "audio.mp3", { type: "audio/mpeg" })
  );
  form.append("model", model);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  // Same no-guess fence as every other transcription in the app (Liz, 7/27):
  // dropouts become gaps, never invented words.
  form.append("prompt", `Transcribe verbatim with natural punctuation. ${STT_NO_GUESS_RULE}`);

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    cache: "no-store",
    signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS)
  });
  const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const detail =
      payload && typeof payload === "object" ? JSON.stringify(payload) : `HTTP ${res.status}`;
    throw new Error(`Transcription failed: ${detail}`);
  }

  const rawSegments = Array.isArray(payload?.segments) ? payload.segments : [];
  const segments: WhisperSegment[] = [];
  for (const raw of rawSegments) {
    const seg = raw as Record<string, unknown>;
    const start = typeof seg.start === "number" ? seg.start : NaN;
    const end = typeof seg.end === "number" ? seg.end : NaN;
    const text = typeof seg.text === "string" ? seg.text.trim() : "";
    if (Number.isFinite(start) && Number.isFinite(end) && text) {
      segments.push({ start, end, text });
    }
  }
  return {
    languageCode: whisperLanguageToCode(
      typeof payload?.language === "string" ? payload.language : undefined
    ),
    duration: typeof payload?.duration === "number" ? payload.duration : 0,
    segments
  };
}

// Translate one batch of caption lines; the model must return the same count.
async function translateBatch(
  apiKey: string,
  lines: string[],
  sourceLabel: string,
  targetLabel: string
): Promise<string[]> {
  // Full gpt-4.1, not mini — same fidelity rationale as /api/translate's
  // paraphrase(): captions of a conversation that mattered enough to record.
  const model = process.env.OPENAI_TRANSLATE_MODEL?.trim() || "gpt-4.1";
  const out = await chatCompletion(apiKey, {
    model,
    temperature: 0.2,
    jsonMode: true,
    messages: [
      { role: "system", content: buildCaptionTranslationInstructions(sourceLabel, targetLabel) },
      { role: "user", content: JSON.stringify({ lines }) }
    ]
  });
  const parsed = JSON.parse(out) as { lines?: unknown };
  const translated = Array.isArray(parsed.lines)
    ? parsed.lines.map((l) => (typeof l === "string" ? l : ""))
    : [];
  if (translated.length !== lines.length) {
    throw new Error(`Batch came back with ${translated.length} lines, expected ${lines.length}.`);
  }
  return translated;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  }
  if (!hasServiceRoleKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: missing SUPABASE_SERVICE_ROLE_KEY." },
      { status: 500 }
    );
  }
  const apiKey = getOpenAIKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: missing OPENAI_API_KEY." },
      { status: 500 }
    );
  }

  const body = (await req.json().catch(() => null)) as {
    path?: string;
    targetLanguage?: string;
  } | null;
  const path = typeof body?.path === "string" ? body.path : "";
  const targetRaw = typeof body?.targetLanguage === "string" ? body.targetLanguage : "auto";

  // The path must be inside the caller's own namespace — anything else would
  // let one signed-in user transcribe another user's upload.
  if (!path.startsWith(`${user.id}/`) || path.includes("..")) {
    return NextResponse.json({ error: "Invalid video path." }, { status: 400 });
  }
  if (targetRaw !== "auto" && !isSupportedLanguageCode(targetRaw)) {
    return NextResponse.json({ error: "Unsupported target language." }, { status: 400 });
  }

  let workDir: string | null = null;
  try {
    const { data: blob, error: downloadErr } = await supabaseAdmin.storage
      .from(VIDEO_BUCKET)
      .download(path);
    if (downloadErr || !blob) {
      return NextResponse.json(
        { error: "Could not read the uploaded video. Try uploading again." },
        { status: 404 }
      );
    }
    if (blob.size > MAX_VIDEO_BYTES) {
      return NextResponse.json({ error: "That video is too large (300 MB max)." }, { status: 413 });
    }

    workDir = await mkdtemp(join(tmpdir(), "taos-video-"));
    const videoPath = join(workDir, "input");
    const audioPath = join(workDir, "audio.mp3");
    await writeFile(videoPath, new Uint8Array(await blob.arrayBuffer()));

    await extractAudio(videoPath, audioPath);
    const audioInfo = await stat(audioPath).catch(() => null);
    if (!audioInfo || audioInfo.size < 1024) {
      return NextResponse.json(
        {
          error:
            "No audio track was found in that video. · No se encontró audio en ese video."
        },
        { status: 422 }
      );
    }
    if (audioInfo.size > MAX_AUDIO_BYTES) {
      return NextResponse.json(
        {
          error:
            "That video is too long to caption in one pass (about 50 minutes max). · " +
            "Ese video es demasiado largo (máx. ~50 minutos)."
        },
        { status: 413 }
      );
    }

    const audioBytes = await readFile(audioPath);
    const whisper = await transcribeWithTimestamps(apiKey, audioBytes);
    if (whisper.segments.length === 0) {
      return NextResponse.json(
        { error: "No speech was heard in that video. · No se escuchó voz en ese video." },
        { status: 422 }
      );
    }

    const detected = whisper.languageCode as SupportedLanguageCode;
    // Auto direction is the EN↔ES promise: English videos get Spanish
    // captions; Spanish (or anything else) gets English.
    const target: SupportedLanguageCode =
      targetRaw === "auto" ? (detected === "en" ? "es" : "en") : targetRaw;

    const segments: CaptionSegment[] = whisper.segments.map((s) => ({
      start: s.start,
      end: s.end,
      text: s.text
    }));

    const warnings: string[] = [];
    if (target !== detected) {
      const sourceLabel = getLanguageLabel(detected);
      const targetLabel = getLanguageLabel(target);
      const batches = batchSegments(segments.map((s) => s.text));
      await Promise.all(
        batches.map(async (batch) => {
          let translated: string[] | null = null;
          // One retry per batch; a batch that fails twice ships untranslated
          // (original text) rather than sinking the whole video.
          for (let attempt = 0; attempt < 2 && !translated; attempt += 1) {
            try {
              translated = await translateBatch(apiKey, batch.texts, sourceLabel, targetLabel);
            } catch {
              translated = null;
            }
          }
          if (translated) {
            translated.forEach((line, i) => {
              segments[batch.offset + i].translation = line;
            });
          } else {
            warnings.push(
              `Captions ${batch.offset + 1}–${batch.offset + batch.texts.length} could not be translated and are shown in the original language.`
            );
          }
        })
      );
    }

    return NextResponse.json({
      detectedLanguage: detected,
      targetLanguage: target,
      sameLanguage: target === detected,
      duration: whisper.duration,
      segments,
      warnings
    });
  } catch (error) {
    if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return NextResponse.json(
        { error: "Transcription took too long. Try a shorter video." },
        { status: 504 }
      );
    }
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    return NextResponse.json({ error: "Video caption pipeline failed.", details: message }, {
      status: 502
    });
  } finally {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
    // The upload was transport, not storage — clean it up regardless of
    // outcome so the bucket never accumulates cost.
    await supabaseAdmin.storage.from(VIDEO_BUCKET).remove([path]).catch(() => {});
  }
}
