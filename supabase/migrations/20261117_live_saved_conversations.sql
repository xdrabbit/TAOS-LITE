-- /live "Save this conversation" (Tom and Liz, 2026-11-17).
--
-- With two-way Auto, /live became something two people sit down and talk
-- through, and they asked to keep what was said. This is where it is kept:
-- TEXT ONLY. No audio is stored by this feature, here or in any bucket.
--
-- ── What is written, and when ──────────────────────────────────────────────
-- Nothing, unless the phone's "Save this conversation" toggle is ON at the
-- moment a line is produced (default off, remembered per device) AND the
-- signed-in user is in the audience TAOS_LIVE_SAVE names (founders |
-- subscribers | all; default founders — lib/live/saveAccess.ts). The session
-- row is created with its first saved line, so a /live session nobody saved
-- leaves no row at all.
--
-- ── Shape ──────────────────────────────────────────────────────────────────
-- taos_lite_live_sessions   one row per saved /live session: whose it is, the
--                           pair, the style, whether it was two-way Auto, and
--                           started/ended (ended_at moves with every line).
-- taos_lite_live_lines      one row per line, in order (`seq`): what was heard
--                           and in which language, what it was rendered as and
--                           in which language, and whether Auto's language tag
--                           was read (`detect` = hit | miss; null outside
--                           Auto). On a miss both languages are null — the
--                           direction is not guessed, here either.
--
-- ── Who can read it ────────────────────────────────────────────────────────
-- RLS on. A signed-in user may SELECT and DELETE their own rows and nothing
-- else. There is NO insert and NO update policy: every write goes through
-- /api/live/saved/* with the service role, after the auth check and the
-- audience check (lib/live/savedStore.ts). Deleting a session deletes its
-- lines (cascade); deleting the account deletes both.
--
-- ── Retention ──────────────────────────────────────────────────────────────
-- Kept until the user deletes them (/live/saved). No sweep, no expiry.
--
-- ── Applying it ────────────────────────────────────────────────────────────
-- NOT applied by the PR that added it. Until it is, the app's status probe
-- sees the tables missing and the toggle stays disabled with a hint
-- (GET /api/live/saved/status → ready:false); nothing errors.
-- Idempotent: safe to run twice.

create table if not exists public.taos_lite_live_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  -- The pair as the phone had it: `mine` is the owner's language.
  lang_mine   text not null,
  lang_theirs text not null,
  style       text not null default 'summary',
  auto        boolean not null default false,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  constraint taos_lite_live_sessions_style check (style in ('summary', 'verbatim'))
);

create index if not exists taos_lite_live_sessions_user_started
  on public.taos_lite_live_sessions (user_id, started_at desc);

create table if not exists public.taos_lite_live_lines (
  id               bigint generated always as identity primary key,
  session_id       uuid not null references public.taos_lite_live_sessions (id) on delete cascade,
  -- Repeated from the session so the owner policy is one comparison, no join.
  user_id          uuid not null references auth.users (id) on delete cascade,
  seq              integer not null,
  heard_text       text not null default '',
  heard_lang       text,
  translation      text not null default '',
  translation_lang text,
  detect           text,
  created_at       timestamptz not null default now(),
  constraint taos_lite_live_lines_detect check (detect is null or detect in ('hit', 'miss')),
  constraint taos_lite_live_lines_seq check (seq >= 0),
  -- A retried write is the same line, not a second one.
  constraint taos_lite_live_lines_order unique (session_id, seq)
);

create index if not exists taos_lite_live_lines_user
  on public.taos_lite_live_lines (user_id);

alter table public.taos_lite_live_sessions enable row level security;
alter table public.taos_lite_live_lines enable row level security;

drop policy if exists taos_lite_live_sessions_own_select on public.taos_lite_live_sessions;
create policy taos_lite_live_sessions_own_select
  on public.taos_lite_live_sessions for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists taos_lite_live_sessions_own_delete on public.taos_lite_live_sessions;
create policy taos_lite_live_sessions_own_delete
  on public.taos_lite_live_sessions for delete to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists taos_lite_live_lines_own_select on public.taos_lite_live_lines;
create policy taos_lite_live_lines_own_select
  on public.taos_lite_live_lines for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists taos_lite_live_lines_own_delete on public.taos_lite_live_lines;
create policy taos_lite_live_lines_own_delete
  on public.taos_lite_live_lines for delete to authenticated
  using ((select auth.uid()) = user_id);

-- Belt and braces: the policies above are the only way in for a browser, and
-- these make sure no table-level grant quietly allows a write that RLS would
-- then have to stop. anon gets nothing at all.
revoke all on public.taos_lite_live_sessions from anon;
revoke all on public.taos_lite_live_lines from anon;
revoke insert, update, truncate, references, trigger on public.taos_lite_live_sessions from authenticated;
revoke insert, update, truncate, references, trigger on public.taos_lite_live_lines from authenticated;

comment on table public.taos_lite_live_sessions is
  '/live saved conversations: one row per session the user chose to save. Text only, kept until the user deletes it. Owner may select/delete; writes are service role only.';
comment on table public.taos_lite_live_lines is
  '/live saved conversation lines, in order: heard text + language, translation + language, auto-detect hit/miss. Text only. Owner may select/delete; writes are service role only.';
