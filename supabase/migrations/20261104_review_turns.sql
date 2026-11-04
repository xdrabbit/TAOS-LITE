-- Founder translation review (Tom, 2026-11-04): "pretty horrible mistakes"
-- between him and Liz, and no way to tell from the text whether the
-- transcript or the translation went wrong. So, for founders who opt in,
-- keep the audio clip beside the transcript and the translation for a short
-- while, and let a founder flag the bad turns.
--
-- ── The opt-in ─────────────────────────────────────────────────────────────
-- One profiles column, default OFF. Only the SPEAKER's own setting governs
-- the speaker's audio: a turn is kept when the person who said it has this
-- on, and nobody else's setting is consulted. Written by the service role
-- from /api/review/settings (lib/review/store.ts) like every other profiles
-- column; readable by its owner under the existing profiles_own_select.
--
-- ── The table ──────────────────────────────────────────────────────────────
-- One row per kept turn — home (/api/translate) or Taokie (/api/walkie/turn)
-- — with the speaker, both languages, the transcript, the translation, the
-- models that produced them, the phase timings, and the path of ONE object in
-- the private bucket below: the speaker's recording, copied at turn time.
-- The flag (reason + note) lives on the same row, so a flagged turn and its
-- audio are one thing to export and one thing to delete.
--
-- ── The clock ──────────────────────────────────────────────────────────────
-- `expires_at` is stamped at insert (TAOS_REVIEW_RETENTION_DAYS, default 14,
-- lib/review/flag.ts). The sweep deletes the storage objects FIRST and the
-- rows second — Postgres cannot delete from storage.objects
-- (supabase/migrations/20260826_chat_thread_deletion.sql), and a row-only
-- delete would strand the audio. Run from the existing daily walkie cron
-- (/api/walkie/sweep), from /api/review/sweep by hand, and best-effort when
-- a founder opens /review.
--
-- ── Who can read it ────────────────────────────────────────────────────────
-- RLS enabled, NO policies: service role only, through lib/review/store.ts,
-- behind the founder gate in lib/review/guard.ts. Same shape as
-- taos_lite_walkie_messages / taos_leads / tutor_lessons.

alter table public.profiles
  add column if not exists review_keep_audio boolean not null default false;

comment on column public.profiles.review_keep_audio is
  'Founder review: keep this person''s own home/Taokie audio for '
  'TAOS_REVIEW_RETENTION_DAYS (14). Default off. Governs only their own turns.';

create table if not exists public.taos_lite_review_turns (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  surface          text not null,
  mode             text not null default 'manual',
  source_lang      text not null,
  target_lang      text not null,
  original_text    text not null default '',
  translation_text text not null default '',
  -- An auto turn that came back as several per-language segments.
  segments         jsonb,
  -- review-audio/<user_id>/<id>.<ext> — what the speaker said
  audio_path       text not null,
  audio_mime       text,
  audio_bytes      integer,
  rec_ms           integer,
  transcribe_model text,
  translate_model  text,
  -- Server phase timings in ms (numbers only; never text).
  timings          jsonb not null default '{}'::jsonb,
  -- The flag. One per turn; null = not flagged.
  flag_reason      text,
  flag_note        text not null default '',
  flagged_at       timestamptz,
  flagged_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  constraint taos_lite_review_surface check (surface in ('home', 'taokie')),
  constraint taos_lite_review_mode check (mode in ('manual', 'auto')),
  constraint taos_lite_review_flag_reason
    check (flag_reason is null or flag_reason in ('words', 'meaning', 'tone', 'other'))
);

comment on table public.taos_lite_review_turns is
  'Founder review turns: audio + transcript + translation, kept only when the '
  'speaker opted in (profiles.review_keep_audio), for TAOS_REVIEW_RETENTION_DAYS '
  '(14), then deleted (objects first, rows second). Service role only.';

create index if not exists taos_lite_review_turns_created
  on public.taos_lite_review_turns (created_at desc);

create index if not exists taos_lite_review_turns_user_created
  on public.taos_lite_review_turns (user_id, created_at desc);

create index if not exists taos_lite_review_turns_expires
  on public.taos_lite_review_turns (expires_at);

alter table public.taos_lite_review_turns enable row level security;

-- ── The bucket ─────────────────────────────────────────────────────────────
-- Private. No storage policies: every read is a signed URL minted by the
-- service role in lib/review/store.ts, every write is a turn route. 15 MB
-- per object, the same fence as walkie-audio — a five-minute home turn is
-- about 1.2 MB of opus.
insert into storage.buckets (id, name, public, file_size_limit)
values ('review-audio', 'review-audio', false, 15728640)
on conflict (id) do nothing;
