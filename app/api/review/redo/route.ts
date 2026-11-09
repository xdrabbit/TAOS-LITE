import { NextRequest, NextResponse } from "next/server";
import { guardReview } from "@/lib/review/guard";
import {
  downloadReviewAudio,
  readReviewTurn,
  saveReviewRedo,
  ReviewStoreError,
  type ReviewRedo,
  type ReviewTurnRow
} from "@/lib/review/store";
import { getLanguageLabel, isSupportedLanguageCode } from "@/lib/realtime/languages";
import { transcribeAudio } from "@/lib/translate/transcribe";
import { getTranslateModel, paraphrase, paraphraseAuto } from "@/lib/translate/paraphrase";
import { normalizeForStt, sttNormalizeEnabled } from "@/lib/translate/normalize";
import { fallbackTranscribeModel, redoHintFor, retryTranscribeOptions, wordCount } from "@/lib/translate/shortTranscript";
import { parseTone } from "@/lib/translate/prompts";
import { topLevelFromSegments } from "@/lib/translate/segments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// POST /api/review/redo { id } → { turn }
//
// Redo · Rehacer (2026-11-05): run a KEPT clip through the fallback
// transcriber (TAOS_TRANSCRIBE_FALLBACK_MODEL, lib/translate/shortTranscript.ts)
// and the same translation the turn had, and store the result on the row
// beside the first one — so every Redo a founder taps is one more real-clip
// transcriber comparison, and the review row shows both, marked.
//
// Founders only, like every /api/review route, and guardSpend first
// (lib/review/guard.ts): this spends a transcription and a completion.
//
// The hint follows the auto-retry's rule: an auto turn is hinted toward the
// OTHER language of the pair the first transcriber decided on (what it
// locked onto is what it heard first); a manual turn keeps its known
// language. The clip is normalized first when the caller's normalize is on.
//
// Log: `[taos-review] redo mode=… model=… words1=… words2=… ms=…` — counts
// and codes, never text.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await guardReview(req);
  if (!guard.ok) return guard.response;
  const body = (await req.json().catch(() => ({}))) as { id?: unknown };
  if (typeof body.id !== "string" || !UUID.test(body.id)) {
    return NextResponse.json({ error: "id must be a turn id." }, { status: 400 });
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "Server misconfiguration: missing OPENAI_API_KEY." }, { status: 500 });

  const started = performance.now();
  let turn: ReviewTurnRow | null;
  try {
    turn = await readReviewTurn(body.id);
  } catch (error) {
    const code = error instanceof ReviewStoreError ? error.code : "failed";
    console.error(`[taos-review] redo_failed code=${code}`);
    return NextResponse.json({ error: "Could not read the turn." }, { status: 502 });
  }
  if (!turn) return NextResponse.json({ error: "That turn is gone." }, { status: 404 });

  try {
    const bytes = await downloadReviewAudio(turn.audio_path);
    const mime = turn.audio_mime || "audio/webm";
    let audio = new File([bytes.buffer as ArrayBuffer], `turn.${mime.includes("mp4") ? "m4a" : "webm"}`, { type: mime });

    let normGainDb: number | null = null;
    if (sttNormalizeEnabled(guard.user.email)) {
      const norm = await normalizeForStt(audio);
      if (norm) {
        audio = norm.file;
        normGainDb = norm.gainDb;
      }
    }

    const model = fallbackTranscribeModel();
    const hint = redoHintFor(turn);
    const t0 = performance.now();
    const original = await transcribeAudio(apiKey, audio, retryTranscribeOptions(model, hint));
    const transcribeMs = Math.round(performance.now() - t0);

    const tone = parseTone("detailed");
    let translation = "";
    let sourceLang = turn.source_lang;
    let targetLang = turn.target_lang;
    let segments: unknown | null = null;
    let translateMs = 0;
    if (original) {
      const t1 = performance.now();
      if (turn.mode === "auto" && isSupportedLanguageCode(turn.source_lang) && isSupportedLanguageCode(turn.target_lang)) {
        const segs = await paraphraseAuto(
          apiKey,
          original,
          tone,
          { code: turn.source_lang, label: getLanguageLabel(turn.source_lang) },
          { code: turn.target_lang, label: getLanguageLabel(turn.target_lang) },
          null
        );
        const top = topLevelFromSegments(segs);
        translation = top.translation;
        sourceLang = top.sourceLanguage;
        targetLang = top.targetLanguage;
        segments = segs.length > 1 ? segs : null;
      } else if (isSupportedLanguageCode(turn.source_lang) && isSupportedLanguageCode(turn.target_lang)) {
        translation = await paraphrase(
          apiKey,
          original,
          getLanguageLabel(turn.source_lang),
          getLanguageLabel(turn.target_lang),
          tone,
          null
        );
      }
      translateMs = Math.round(performance.now() - t1);
    }

    const redo: ReviewRedo = {
      model,
      language_hint: hint?.code ?? null,
      source_lang: sourceLang,
      target_lang: targetLang,
      original_text: original,
      translation_text: translation,
      segments,
      norm_gain_db: normGainDb,
      timings: {
        transcribe_ms: transcribeMs,
        translate_ms: translateMs,
        total_ms: Math.round(performance.now() - started)
      },
      at: new Date().toISOString()
    };
    const saved = await saveReviewRedo(turn.id, redo);
    if (!saved) return NextResponse.json({ error: "That turn is gone." }, { status: 404 });
    console.log(
      `[taos-review] redo mode=${turn.mode} model=${model} hint=${hint?.code ?? "none"} words1=${wordCount(
        turn.original_text
      )} words2=${wordCount(original)} norm_gain_db=${normGainDb ?? "?"} translate_model=${getTranslateModel()} ms=${
        redo.timings.total_ms
      }`
    );
    return NextResponse.json({ turn: saved }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof ReviewStoreError ? error.code : "failed";
    console.error(`[taos-review] redo_failed code=${code}`);
    return NextResponse.json({ error: "Could not redo." }, { status: 502 });
  }
}
