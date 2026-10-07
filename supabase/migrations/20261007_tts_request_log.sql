-- One row per POST /api/tts (2026-10-07). Additive: a new table, nothing else
-- changed or dropped.
--
-- Tom's report: with Fish Audio selected, his phone spoke a DIFFERENT voice
-- than his computer; ElevenLabs sounded the same on both. The route logged
-- nothing on success, so "which voice id, when, from what device" had no
-- answer. Written by app/api/tts/route.ts via lib/tts/requestLog.ts.
--
-- Deliberately absent: the text (text_chars is a count), the email (user_id
-- is the auth uuid), and the raw User-Agent (device_family/browser are parsed
-- from it, ua_hash is 12 hex chars of its SHA-256 — enough to tell two
-- devices apart, nothing more).
--
-- `engine` is the provider that ACTUALLY spoke; `requested_engine` is what the
-- client asked for. They differ when Fish has no clone for the line (a locked
-- device, a guest speaker, an unset voice variable) and the line goes to the
-- ElevenLabs stock voice — exactly the case worth seeing.

create table if not exists public.taos_lite_tts_log (
  id               bigint generated always as identity primary key,
  ts               timestamptz not null default now(),
  -- null for the anonymous /try funnel. Deleted with the account.
  user_id          uuid references auth.users(id) on delete cascade,
  surface          text not null default 'unknown',
  engine           text,
  requested_engine text,
  voice_id         text,
  voice_role       text not null default 'none'
                   check (voice_role in ('tom', 'liz', 'stock', 'none')),
  unlocked         boolean not null default false,
  lang             text,
  source_lang      text,
  text_chars       integer not null default 0,
  device_family    text not null default 'other',
  browser          text not null default 'other',
  standalone       boolean not null default false,
  ua_hash          text,
  status           text not null check (status in ('ok', 'error')),
  http_status      integer,
  error_code       text,
  latency_ms       integer,
  audio_bytes      integer,
  audio_mime       text
);

comment on table public.taos_lite_tts_log is
  'One row per POST /api/tts: engine, voice id, voice role, device family. No text, '
  'no email, no raw User-Agent. Written ONLY by the route with the service role.';

create index if not exists taos_lite_tts_log_ts_idx on public.taos_lite_tts_log (ts desc);
create index if not exists taos_lite_tts_log_user_ts_idx on public.taos_lite_tts_log (user_id, ts desc);

alter table public.taos_lite_tts_log enable row level security;
-- No policies: service role only, no client reads or writes. The grants are
-- revoked too, so even a future permissive policy would not open it by itself.
revoke all on public.taos_lite_tts_log from anon, authenticated;
