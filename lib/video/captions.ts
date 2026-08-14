// Pure caption helpers for the /video feature (upload a video, get translated
// closed captions). Extracted so tests/video-captions.test.ts can fence in the
// SRT/VTT formats — a caption file that's off by a comma-vs-dot in the
// timestamps silently fails to load in some players, which is exactly the kind
// of bug a field test won't attribute correctly.
//
// These run on BOTH sides: the API route returns plain JSON segments, and
// VideoShell builds the downloadable .srt/.vtt files and the <track> blob in
// the browser. Keep this module dependency-free.

export interface CaptionSegment {
  /** Segment start, in seconds from the beginning of the video. */
  start: number;
  /** Segment end, in seconds. */
  end: number;
  /** Transcript text in the spoken language. */
  text: string;
  /** Translated text; absent when the video was already in the target language. */
  translation?: string;
}

function clampTime(seconds: number): number {
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

function formatTimestamp(seconds: number, millisSeparator: "," | "."): string {
  const total = clampTime(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${millisSeparator}${pad(ms, 3)}`;
}

/** SRT timestamps use a COMMA before the milliseconds: 00:01:02,345 */
export function formatSrtTimestamp(seconds: number): string {
  return formatTimestamp(seconds, ",");
}

/** VTT timestamps use a DOT before the milliseconds: 00:01:02.345 */
export function formatVttTimestamp(seconds: number): string {
  return formatTimestamp(seconds, ".");
}

// A literal "-->" inside cue text would terminate the cue early in strict
// parsers; soften it the way WhisperX's writers do.
function cueText(raw: string): string {
  return raw.trim().replace(/-->/g, "->");
}

// A zero- or negative-length cue is invalid; give it a minimal visible window
// rather than dropping the words on the floor.
function cueEnd(start: number, end: number): number {
  const s = clampTime(start);
  const e = clampTime(end);
  return e > s ? e : s + 0.5;
}

function pickText(segment: CaptionSegment, track: "original" | "translation"): string {
  const text =
    track === "translation" && typeof segment.translation === "string" && segment.translation.trim()
      ? segment.translation
      : segment.text;
  return cueText(text);
}

/** Render segments as an SRT file (translated track by default). */
export function toSrt(
  segments: CaptionSegment[],
  track: "original" | "translation" = "translation"
): string {
  const cues: string[] = [];
  let index = 1;
  for (const segment of segments) {
    const text = pickText(segment, track);
    if (!text) continue;
    const start = clampTime(segment.start);
    cues.push(
      `${index}\n${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(cueEnd(segment.start, segment.end))}\n${text}\n`
    );
    index += 1;
  }
  return cues.join("\n");
}

/** Render segments as a WebVTT file (translated track by default). */
export function toVtt(
  segments: CaptionSegment[],
  track: "original" | "translation" = "translation"
): string {
  const cues: string[] = ["WEBVTT\n"];
  for (const segment of segments) {
    const text = pickText(segment, track);
    if (!text) continue;
    const start = clampTime(segment.start);
    cues.push(
      `${formatVttTimestamp(start)} --> ${formatVttTimestamp(cueEnd(segment.start, segment.end))}\n${text}\n`
    );
  }
  return cues.join("\n");
}

// ---------------------------------------------------------------------------
// Batching for translation.
//
// The whole transcript can't go to the translation model as one blob — the
// response must map back to segments 1:1 so each caption keeps its timestamp.
// Segments are sent in numbered batches and the model returns a JSON array of
// the same length. Batches are capped by character budget (model attention and
// output-token limits) rather than a fixed count, since segments vary wildly.

export interface SegmentBatch {
  /** Index into the full segment array where this batch starts. */
  offset: number;
  /** The segment texts in this batch, in order. */
  texts: string[];
}

export const BATCH_CHAR_BUDGET = 4000;
export const BATCH_MAX_SEGMENTS = 60;

export function batchSegments(
  texts: string[],
  charBudget: number = BATCH_CHAR_BUDGET,
  maxSegments: number = BATCH_MAX_SEGMENTS
): SegmentBatch[] {
  const batches: SegmentBatch[] = [];
  let current: string[] = [];
  let currentChars = 0;
  let offset = 0;
  texts.forEach((text, i) => {
    // A batch always accepts at least one segment, even one over budget —
    // otherwise a single long monologue segment would loop forever.
    if (current.length > 0 && (currentChars + text.length > charBudget || current.length >= maxSegments)) {
      batches.push({ offset, texts: current });
      offset = i;
      current = [];
      currentChars = 0;
    }
    current.push(text);
    currentChars += text.length;
  });
  if (current.length > 0) {
    batches.push({ offset, texts: current });
  }
  return batches;
}

// Whisper's verbose_json reports the detected language as a lowercase English
// name ("english", "spanish"). Map the ones the app supports onto its codes;
// unknown names fall back to English so the auto direction rule stays sane.
const WHISPER_LANGUAGE_NAMES: Record<string, string> = {
  english: "en",
  spanish: "es",
  french: "fr",
  german: "de",
  italian: "it",
  portuguese: "pt",
  japanese: "ja",
  korean: "ko",
  chinese: "zh",
  cantonese: "yue",
  hindi: "hi",
  arabic: "ar",
  russian: "ru"
};

export function whisperLanguageToCode(name: string | undefined): string {
  if (!name) return "en";
  return WHISPER_LANGUAGE_NAMES[name.trim().toLowerCase()] ?? "en";
}
