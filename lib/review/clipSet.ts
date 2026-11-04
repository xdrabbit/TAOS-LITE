// The clip-set format: what the transcriber probe reads, and what the review
// export writes. ONE definition, so flagged real turns become the probe's
// test set without anybody re-describing the format by hand.
//
//   <stem>.<ext>    the audio (wav, mp3, m4a, mp4, webm, ogg, flac)
//   <stem>.txt      what was actually said — one line per part, optionally
//                   tagged `en:` / `es:`; two tags = a mixed clip
//   <stem>.json     everything else the review knew (translation, flag,
//                   models, timings). The probe ignores it.
//   manifest.json   the same, for all clips, in one file.
//
// Isomorphic: the export route builds entries here; tests/live-fire/
// transcribe-accuracy.measure.ts reads a directory of them through
// lib/review/clipDir.ts.

import type { TarEntry } from "./tar";

export type ClipLang = "en" | "es";

export interface ClipPart {
  lang: ClipLang;
  text: string;
}

export const CLIP_MIME: Record<string, string> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".webm": "audio/webm",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac"
};

export function clipExtensionFor(mime: string): string {
  if (mime.includes("mp4") || mime.includes("aac") || mime.includes("m4a")) return ".m4a";
  if (mime.includes("ogg")) return ".ogg";
  if (mime.includes("mpeg") || mime.includes("mp3")) return ".mp3";
  if (mime.includes("wav")) return ".wav";
  if (mime.includes("flac")) return ".flac";
  return ".webm";
}

export function guessClipLang(line: string): ClipLang {
  if (/[ñ¿¡áéíóú]/i.test(line)) return "es";
  return /\b(que|el|la|los|las|de|y|es|por|para|con|una?|yo|tu|mi)\b/i.test(line) ? "es" : "en";
}

/** The sidecar's lines, tagged or guessed. Blank lines are skipped. */
export function parseClipScript(text: string): ClipPart[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const tagged = /^(en|es)\s*:\s*(.*)$/i.exec(line);
      return tagged
        ? { lang: tagged[1].toLowerCase() as ClipLang, text: tagged[2] }
        : { lang: guessClipLang(line), text: line };
    });
}

/** What the export knows about one flagged turn. */
export interface ExportTurn {
  id: string;
  created_at: string;
  surface: string;
  mode: string;
  source_lang: string;
  target_lang: string;
  original_text: string;
  translation_text: string;
  segments: unknown | null;
  audio_mime: string | null;
  rec_ms: number | null;
  transcribe_model: string | null;
  translate_model: string | null;
  timings: unknown;
  flag_reason: string | null;
  flag_note: string;
  flagged_at: string | null;
  /** Who spoke — a label for the manifest, never an email. */
  speaker: string;
}

/**
 * The reference script for one turn.
 *
 * The probe scores a transcriber against "what was actually said". When the
 * flag is `words` — the transcript was wrong — and the reviewer wrote the
 * real sentence in the note, THAT is the reference; otherwise the stored
 * transcript is the best we have. Tagged with the language when it is one
 * the probe knows how to tag; other languages go untagged and are guessed.
 */
export function clipScriptFor(turn: Pick<ExportTurn, "source_lang" | "original_text" | "flag_reason" | "flag_note">): string {
  const reference = turn.flag_reason === "words" && turn.flag_note.trim() ? turn.flag_note.trim() : turn.original_text.trim();
  const lines = reference.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const tag = turn.source_lang === "en" || turn.source_lang === "es" ? `${turn.source_lang}: ` : "";
  return `${lines.map((l) => `${tag}${l}`).join("\n")}\n`;
}

/** A stem the shell is happy with: the day, the surface, the id's head. */
export function clipStemFor(turn: Pick<ExportTurn, "id" | "created_at" | "surface">): string {
  const day = turn.created_at.slice(0, 10).replace(/[^0-9]/g, "") || "00000000";
  return `${day}-${turn.surface}-${turn.id.replace(/[^0-9a-f]/gi, "").slice(0, 8)}`;
}

function sidecar(turn: ExportTurn): Record<string, unknown> {
  return {
    id: turn.id,
    created_at: turn.created_at,
    speaker: turn.speaker,
    surface: turn.surface,
    mode: turn.mode,
    source_lang: turn.source_lang,
    target_lang: turn.target_lang,
    transcript: turn.original_text,
    translation: turn.translation_text,
    segments: turn.segments ?? null,
    flag: { reason: turn.flag_reason, note: turn.flag_note, at: turn.flagged_at },
    models: { transcribe: turn.transcribe_model, translate: turn.translate_model },
    timings: turn.timings ?? {},
    rec_ms: turn.rec_ms
  };
}

const encoder = new TextEncoder();

/** Tar entries for a clip set, in a folder named for the day it was built. */
export function clipSetEntries(
  turns: Array<{ turn: ExportTurn; audio: Uint8Array }>,
  builtAt: Date = new Date()
): TarEntry[] {
  const folder = `review-clips-${builtAt.toISOString().slice(0, 10)}`;
  const mtime = Math.floor(builtAt.getTime() / 1000);
  const entries: TarEntry[] = [];
  const manifest: Array<Record<string, unknown>> = [];
  for (const { turn, audio } of turns) {
    const stem = clipStemFor(turn);
    const ext = clipExtensionFor(turn.audio_mime ?? "");
    entries.push({ name: `${folder}/${stem}${ext}`, data: audio, mtime });
    entries.push({ name: `${folder}/${stem}.txt`, data: encoder.encode(clipScriptFor(turn)), mtime });
    const meta = { ...sidecar(turn), audio: `${stem}${ext}` };
    entries.push({ name: `${folder}/${stem}.json`, data: encoder.encode(`${JSON.stringify(meta, null, 2)}\n`), mtime });
    manifest.push(meta);
  }
  entries.push({
    name: `${folder}/manifest.json`,
    data: encoder.encode(`${JSON.stringify({ built_at: builtAt.toISOString(), clips: manifest }, null, 2)}\n`),
    mtime
  });
  return entries;
}
