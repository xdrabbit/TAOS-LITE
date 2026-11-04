// Keeping a turn for review — the one call a turn route makes, after it has
// answered the phone. Server-only.
//
// Two questions, both answered here and nowhere else:
//
//   1. Is this speaker a founder who turned their OWN opt-in on? Only the
//      speaker's setting is read (profiles.review_keep_audio). A non-founder's
//      profile is never consulted; an anonymous /try caller has none.
//   2. If so: copy the recording into the private review-audio bucket and
//      write the row — object first, row second, and the object removed again
//      if the row fails, so nothing is stranded.
//
// Never throws. A turn that was spoken and delivered is not undone over its
// review copy; a failure is one log line of codes.
//
// ── What the log may say ───────────────────────────────────────────────────
// `[taos-review] kept surface=home bytes=N` or `keep_failed code=…`. Never
// the transcript, the translation, an email or a user agent — lengths and
// codes only (the [taos-translate-timing] rule).

import { reviewVisibleTo, type ReviewSurface } from "./flag";

/** Who spoke: the two fields of a validated session this module reads. */
export interface Speaker {
  id: string;
  email?: string | null;
}
import {
  insertReviewTurn,
  readReviewKeepAudio,
  removeReviewAudio,
  reviewAudioPath,
  ReviewStoreError,
  uploadReviewAudio,
  type ReviewTimings
} from "./store";

/**
 * Should this speaker's audio be kept? False for anyone who is not a
 * founder — without touching the database — and false on any error.
 */
export async function speakerKeepsAudio(user: Speaker | null | undefined): Promise<boolean> {
  if (!user || !reviewVisibleTo(user.email)) return false;
  try {
    return await readReviewKeepAudio(user.id);
  } catch {
    return false;
  }
}

export interface KeepTurnInput {
  user: Speaker;
  surface: ReviewSurface;
  mode: "manual" | "auto";
  audio: ArrayBuffer | Uint8Array;
  audioMime: string;
  sourceLang: string;
  targetLang: string;
  originalText: string;
  translationText: string;
  segments?: unknown | null;
  recMs?: number | null;
  transcribeModel?: string | null;
  translateModel?: string | null;
  timings: ReviewTimings;
}

const MAX_TEXT_CHARS = 4000;

/** Copy the clip and write the row. Resolves to the new row id, or null. */
export async function keepTurnForReview(input: KeepTurnInput): Promise<string | null> {
  const id = crypto.randomUUID();
  const mime = input.audioMime || "audio/webm";
  const path = reviewAudioPath(input.user.id, id, mime);
  const bytes = input.audio.byteLength;
  try {
    await uploadReviewAudio(path, input.audio, mime);
    try {
      await insertReviewTurn({
        id,
        userId: input.user.id,
        surface: input.surface,
        mode: input.mode,
        sourceLang: input.sourceLang,
        targetLang: input.targetLang,
        originalText: input.originalText.slice(0, MAX_TEXT_CHARS),
        translationText: input.translationText.slice(0, MAX_TEXT_CHARS),
        segments: input.segments ?? null,
        audioPath: path,
        audioMime: mime,
        audioBytes: bytes,
        recMs: input.recMs ?? null,
        transcribeModel: input.transcribeModel ?? null,
        translateModel: input.translateModel ?? null,
        timings: input.timings
      });
    } catch (e) {
      await removeReviewAudio([path]).catch(() => undefined);
      throw e;
    }
    console.log(`[taos-review] kept surface=${input.surface} mode=${input.mode} bytes=${bytes}`);
    return id;
  } catch (error) {
    const code = error instanceof ReviewStoreError ? error.code : "failed";
    console.error(`[taos-review] keep_failed surface=${input.surface} code=${code}`);
    return null;
  }
}
