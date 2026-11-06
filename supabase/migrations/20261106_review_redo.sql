-- Redo · Rehacer (2026-11-05): a founder re-runs a KEPT clip through the
-- fallback transcriber and the same translation, and both results stay on
-- the row — the turn's own transcript/translation as "first", the redo as
-- "redo" — so every Redo is one more real-clip transcriber comparison
-- without anybody building a test set. Latest redo wins; the pair is the
-- row's original columns beside this one.
--
-- Shape of `redo` (lib/review/store.ts ReviewRedo):
--   { model, language_hint, source_lang, target_lang, original_text,
--     translation_text, segments, norm_gain_db, timings: { transcribe_ms,
--     translate_ms, total_ms }, at }
-- Nothing here can touch flag_reason / flag_note or the first result.

alter table public.taos_lite_review_turns
  add column if not exists redo    jsonb,
  add column if not exists redo_at timestamptz;

comment on column public.taos_lite_review_turns.redo is
  'Redo (lib/review/store.ts ReviewRedo): the kept clip re-run through the '
  'fallback transcriber + the same translation. Latest only; the first '
  'result stays in original_text / translation_text.';
