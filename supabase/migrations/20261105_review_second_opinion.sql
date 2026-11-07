-- Founder review, second opinion (Tom, 2026-11-04 20:27 MT): "have a model
-- check each kept turn — transcription quality and A→B translation quality —
-- so he and Liz can verify the suspects by ear instead of reading every row."
--
-- Three nullable columns on the review turn, nothing else. A turn that was
-- never checked has all three null. Nothing here is a flag: a grader's issue
-- only highlights, and only a founder's tap sets flag_reason.
--
-- ── opinion ────────────────────────────────────────────────────────────────
-- One jsonb (lib/review/opinion.ts ReviewOpinion):
--   stt   — { model, alt_transcript, agreement (0..1), diff: [{start, end,
--             original, alt}] } — a SECOND transcriber's reading of the same
--             clip, word-diffed against the transcript the turn shipped with;
--             start/end are character offsets into original_text.
--   grade — { model, meaning (1..5), tone (1..5), issues: [{span, kind, why}],
--             suggested_translation } — a strong text model's strict JSON
--             reading of the translation against the transcript.
--   errors — { stt?: code, grade?: code } — codes only, when a half failed.
--
-- ── opinion_score ──────────────────────────────────────────────────────────
-- The lowest of agreement, meaning/5 and tone/5 — one number so the page can
-- order "suspects first" in the database. Null = unreviewed.
--
-- ── opinion_at ─────────────────────────────────────────────────────────────
-- When the check ran. Null = unreviewed; the batch and the nightly job pick
-- rows where this is null and never re-check on their own.
--
-- Retention, RLS and the bucket are unchanged: these columns go with the row
-- when its expires_at passes, and the table still has NO policies.

alter table public.taos_lite_review_turns
  add column if not exists opinion       jsonb,
  add column if not exists opinion_score real,
  add column if not exists opinion_at    timestamptz;

comment on column public.taos_lite_review_turns.opinion is
  'Second opinion (lib/review/opinion.ts): a second transcriber word-diffed '
  'against the transcript, and a grader''s meaning/tone/issues on the '
  'translation. Highlights only; never sets the flag.';

comment on column public.taos_lite_review_turns.opinion_score is
  'min(agreement, meaning/5, tone/5) in 0..1; null = unreviewed. Lower = more suspect.';

create index if not exists taos_lite_review_turns_opinion_score
  on public.taos_lite_review_turns (opinion_score asc nulls last, created_at desc);
