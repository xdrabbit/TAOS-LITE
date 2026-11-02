-- Taokie — the push-to-talk translation walkie (founders-only P0 spike,
-- 2026-11-01). One table, one private bucket, one profiles column.
--
-- ── The table ──────────────────────────────────────────────────────────────
-- One row per hold-talk-release turn: the room (a /call-style five-character
-- code — the pairing), the sender, both languages, the transcript and the
-- translation, and the paths of two objects in the bucket below (the
-- sender's recording, the spoken translation). Modelled on
-- taos_lite_chat_messages' voice notes, kept separate from them: a chat
-- thread is two named members with a delete route and membership policies;
-- a channel is a room code and a clock.
--
-- ── The clock ──────────────────────────────────────────────────────────────
-- `expires_at` is stamped at insert (TAOS_WALKIE_RETENTION_DAYS, default 30,
-- lib/walkie/flag.ts). GET /api/walkie/sweep — Vercel Cron, daily — deletes
-- the storage objects FIRST and the rows second, because Postgres cannot
-- delete from storage.objects (supabase/migrations/20260826_chat_thread_deletion.sql
-- learned that the hard way) and a row-only delete would strand the audio.
--
-- ── Who can read it ────────────────────────────────────────────────────────
-- RLS enabled, NO policies: service role only, through lib/walkie/store.ts,
-- behind the flag + founder gate in lib/walkie/guard.ts. Same shape as
-- taos_leads / taos_lite_chat_invites / tutor_lessons.

create table if not exists public.taos_lite_walkie_messages (
  id               uuid primary key default gen_random_uuid(),
  room             text not null,
  sender_id        uuid not null references auth.users (id) on delete cascade,
  source_lang      text not null,
  target_lang      text not null,
  original_text    text not null default '',
  translation_text text not null default '',
  -- walkie-audio/<room>/<id>.rec.<ext> — what the sender said
  audio_path       text,
  -- walkie-audio/<room>/<id>.say.mp3 — the translation, spoken in their voice
  speech_path      text,
  speech_engine    text,
  rec_ms           integer,
  -- Server phase timings in ms (numbers only; never text). The played ack
  -- reads these back to log the complete [taos-walkie-timing] line.
  timings          jsonb not null default '{}'::jsonb,
  released_at      timestamptz,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  delivered_at     timestamptz,
  played_at        timestamptz,
  constraint taos_lite_walkie_room_shape check (room ~ '^[0-9A-Z-]{4,12}$')
);

comment on table public.taos_lite_walkie_messages is
  'Taokie walkie turns. Product data for TAOS_WALKIE_RETENTION_DAYS (30), '
  'then deleted by GET /api/walkie/sweep (objects first, rows second). '
  'Service role only — no RLS policies on purpose.';

create index if not exists taos_lite_walkie_messages_room_created
  on public.taos_lite_walkie_messages (room, created_at desc);

create index if not exists taos_lite_walkie_messages_expires
  on public.taos_lite_walkie_messages (expires_at);

alter table public.taos_lite_walkie_messages enable row level security;

-- ── The bucket ─────────────────────────────────────────────────────────────
-- Private. No storage policies: every read is a signed URL minted by the
-- service role in lib/walkie/store.ts, every write is the turn route.
-- 15 MB per object — a 30-second opus recording is well under 200 KB, and a
-- five-minute one (the knob's ceiling) about 1.2 MB; the limit is a fence,
-- not a target.
insert into storage.buckets (id, name, public, file_size_limit)
values ('walkie-audio', 'walkie-audio', false, 15728640)
on conflict (id) do nothing;

-- ── The one user setting ───────────────────────────────────────────────────
-- "Show message text in notifications", default ON (Tom, 2026-11-01).
-- INERT until the PWA has push: nothing sends a notification today. Written
-- by the service role from /api/walkie/settings like every other profiles
-- column; readable by its owner under the existing profiles_own_select.
alter table public.profiles
  add column if not exists walkie_notify_text boolean not null default true;

comment on column public.profiles.walkie_notify_text is
  'Taokie: show the translated text in a push notification (default on). '
  'Inert until web push exists.';
