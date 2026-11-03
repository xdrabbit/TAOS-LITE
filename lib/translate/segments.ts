// Mixed-language turns on the home screen (Tom + Liz, 2026-10-27).
//
// One recording can hold two people: English, then a Spanish interruption.
// Auto-detect used to ask the model for ONE source_lang and ONE translation
// per recording, so a mixed turn came back however the model felt like it —
// sometimes each half translated on its own (never asked for), sometimes one
// language picked and the other half mangled — and the readout always played
// in one clone, because the server reported one speaker.
//
// Now the model returns ordered SEGMENTS, each in its own speaker's language
// (lib/translate/prompts.ts → buildAutoDetectInstructions). This file holds
// the pure halves of that:
//
//   * parseAutoSegments — the route's reading of the model's JSON: which
//     segments to trust, what to do with a bad one, and the fallback to the
//     old single-source shape when nothing parses.
//   * speechForSegments — the client's readout: one /api/tts call per segment
//     with THAT segment's source language (voice-follows-speaker picks the
//     clone, lib/tts/voice.ts), joined once into one mp3 for Play and Share.
//
// A single-language recording is exactly one segment, and one segment is
// today's turn byte for byte: same response, one TTS call, no join.

import { audioFrames, concatBytes, frameBytes, joinMp3 } from "@/lib/tts/mp3";

export interface TranslatedSegment<Code extends string = string> {
  /** The language this segment was SPOKEN in — picks the clone. */
  sourceLanguage: Code;
  /** The other language of the pair: what the translation is written in. */
  targetLanguage: Code;
  original: string;
  translation: string;
}

export interface ParsedAutoSegments<Code extends string> {
  segments: TranslatedSegment<Code>[];
  /** Segments whose source_lang was not one of the pair, folded into a neighbour. */
  folded: number;
  /** True when the reply was the old single-source shape (or no usable segments). */
  fallback: boolean;
}

type Warn = (message: string) => void;

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// The model's code goes into the log, never its text: a source_lang that is a
// sentence would otherwise carry the transcript into Vercel's logs.
function codeForLog(value: unknown): string {
  return JSON.stringify(typeof value === "string" ? value.slice(0, 12) : (value ?? null));
}

/**
 * The model's JSON reply, read into segments.
 *
 * - A segment whose source_lang is not one of the pair's two codes is logged
 *   and folded into its neighbour's language (the one before it, else the one
 *   after) rather than guessed at. Neighbours that end up in the same language
 *   merge, so the readout never switches clone to say one language twice.
 * - A reply with no usable `segments` falls back to today's single-source
 *   shape: top-level source_lang + translation, the pair's first language
 *   when the code is missing (logged, as before).
 * - One segment always carries the full transcript as its original, exactly
 *   as the single-source turn always did.
 *
 * Throws "Translation response was empty." when there is no translation at
 * all — the same failure the route has always raised.
 */
export function parseAutoSegments<Code extends string>(
  content: string,
  transcript: string,
  a: Code,
  b: Code,
  warn: Warn = (m) => console.warn(m)
): ParsedAutoSegments<Code> {
  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(content) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    /* fall through to the single-source fallback */
  }
  const other = (code: Code): Code => (code === a ? b : a);
  const valid = (code: unknown): code is Code => code === a || code === b;

  const raw = Array.isArray(parsed.segments) ? parsed.segments : [];
  const usable = raw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .map((s) => ({ code: s.source_lang, original: str(s.original), translation: str(s.translation) }))
    .filter((s) => s.translation);

  if (usable.length === 0) {
    // Today's single-source behavior, kept verbatim as the fallback.
    if (!valid(parsed.source_lang)) {
      warn(
        `[translate] auto-detect returned no usable source_lang (got ${codeForLog(parsed.source_lang)}); defaulting to ${a}`
      );
    }
    const detected: Code = parsed.source_lang === b ? b : a;
    const translation = str(parsed.translation);
    if (!translation) throw new Error("Translation response was empty.");
    return {
      segments: [{ sourceLanguage: detected, targetLanguage: other(detected), original: transcript, translation }],
      folded: 0,
      fallback: true
    };
  }

  // Fold: a bad code takes the language of the nearest good segment before it,
  // else after it. With no good segment anywhere, the pair's first language —
  // the same coin flip the single-source path logs.
  let folded = 0;
  const codes: Code[] = usable.map((s, i) => {
    if (valid(s.code)) return s.code;
    folded += 1;
    const before = usable.slice(0, i).reverse().find((t) => valid(t.code))?.code;
    const after = usable.slice(i + 1).find((t) => valid(t.code))?.code;
    const into = (valid(before) ? before : valid(after) ? after : a) as Code;
    warn(
      `[translate] auto-detect segment ${i + 1} returned no usable source_lang (got ${codeForLog(s.code)}); folded into ${into}`
    );
    return into;
  });

  const segments: TranslatedSegment<Code>[] = [];
  usable.forEach((s, i) => {
    const code = codes[i];
    const last = segments[segments.length - 1];
    if (last && last.sourceLanguage === code) {
      last.original = [last.original, s.original].filter(Boolean).join(" ");
      last.translation = `${last.translation} ${s.translation}`;
      return;
    }
    segments.push({ sourceLanguage: code, targetLanguage: other(code), original: s.original, translation: s.translation });
  });
  if (segments.length === 1) segments[0].original = transcript;
  return { segments, folded, fallback: false };
}

/**
 * The route's top-level fields from the segments: one segment is today's
 * response exactly; several join with a newline, in order, and take their
 * direction from the FIRST segment.
 */
export function topLevelFromSegments<Code extends string>(
  segments: TranslatedSegment<Code>[]
): { original: string; translation: string; sourceLanguage: Code; targetLanguage: Code } {
  return {
    original: segments.map((s) => s.original).join("\n"),
    translation: segments.map((s) => s.translation).join("\n"),
    sourceLanguage: segments[0].sourceLanguage,
    targetLanguage: segments[0].targetLanguage
  };
}

/**
 * The `segments` array of an /api/translate reply, kept only when every
 * entry is one of the pair's two languages and there is more than one —
 * anything else is a single-language turn and renders exactly as before.
 */
export function segmentsFromPayload<Code extends string>(
  value: unknown,
  pair: readonly [Code, Code]
): TranslatedSegment<Code>[] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const out: TranslatedSegment<Code>[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const s = item as Record<string, unknown>;
    const src = s.sourceLanguage;
    if (src !== pair[0] && src !== pair[1]) return null;
    const translation = str(s.translation);
    if (!translation) return null;
    const code = src as Code;
    out.push({
      sourceLanguage: code,
      targetLanguage: code === pair[0] ? pair[1] : pair[0],
      original: str(s.original),
      translation
    });
  }
  return out;
}

/** Silence between two speakers in a joined readout. */
export const SEGMENT_GAP_MS = 300;

/**
 * One readout for a mixed turn: each segment spoken by `speakOne` (the
 * caller's /api/tts request, made with THAT segment's source language),
 * all requested at once, then joined ONCE, in order. A segment with no
 * audio (a text-only language) is left out; a turn with none is null.
 */
export async function speechForSegments<Code extends string>(
  segments: TranslatedSegment<Code>[],
  speakOne: (segment: TranslatedSegment<Code>) => Promise<Blob | null>,
  join: (blobs: Blob[]) => Promise<Blob> = joinMp3Blobs
): Promise<Blob | null> {
  const blobs = (await Promise.all(segments.map((s) => speakOne(s)))).filter(
    (b): b is Blob => !!b
  );
  if (blobs.length === 0) return null;
  if (blobs.length === 1) return blobs[0];
  return join(blobs);
}

/**
 * Several mp3 blobs as one, through the app's one joiner (lib/tts/mp3.ts).
 * Both clips come from the same engine in the same format, so the rates
 * match; should they not, joinMp3 refuses, and the parts' bare audio frames
 * go end to end with no gap and no Xing frame (no tag or header from part
 * one claiming to be the whole file). A player may misjudge the length;
 * it still plays every frame.
 */
export async function joinMp3Blobs(blobs: Blob[], gapMs = SEGMENT_GAP_MS): Promise<Blob> {
  const parts = await Promise.all(blobs.map(async (b) => new Uint8Array(await b.arrayBuffer())));
  const joined = joinMp3(parts, gapMs) ?? concatBytes(parts.map((p) => frameBytes(p, audioFrames(p))));
  return new Blob([joined as BlobPart], { type: "audio/mpeg" });
}
