-- Tabletop "Interpreter mode" (Tom, 2026-11-09): the founder-editable context
-- block the interpreter is briefed with at session start — who is at the
-- table, what they call each other, the regional words the model would
-- otherwise get wrong.
--
-- ── Why a table and not a file ─────────────────────────────────────────────
-- It is personal: names, relationships, nicknames. None of it belongs in the
-- repository, so THIS FILE SEEDS NOTHING — the row is written from the edit
-- box on /tabletop (PUT /api/tabletop/interpreter/context), by a founder,
-- through the service role.
--
-- ── Shape ──────────────────────────────────────────────────────────────────
-- ONE row, shared by the founders: it describes the table they both sit at,
-- so either of them editing it edits what the interpreter hears for both.
-- `id` is pinned to 'founders' by a CHECK, which makes "the row" a primary-key
-- upsert and makes a second row impossible rather than merely unexpected.
-- 4,000 characters is the same ceiling lib/interpreter/briefing.ts enforces:
-- a briefing is read at the start of every session and re-read (from cache)
-- on every response, so it stays a briefing.
--
-- ── Who can read it ────────────────────────────────────────────────────────
-- RLS enabled, NO policies: service role only, through
-- lib/interpreter/contextStore.ts, behind lib/interpreter/guard.ts (flag +
-- session + founder). Same shape as taos_lite_review_turns /
-- taos_lite_walkie_messages / taos_leads.
--
-- ADDITIVE ONLY: one new table, nothing altered, nothing dropped. Until it is
-- applied the mode still runs — the briefing just carries no context block,
-- and the edit box says the table is not there yet.

create table if not exists public.taos_lite_interpreter_context (
  id         text primary key default 'founders',
  context    text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  constraint taos_lite_interpreter_context_single check (id = 'founders'),
  constraint taos_lite_interpreter_context_length check (char_length(context) <= 4000)
);

comment on table public.taos_lite_interpreter_context is
  'Tabletop Interpreter mode: the one founder-editable context block (names, '
  'relationships, regional vocabulary) read into the interpreter''s briefing at '
  'session start. Personal — never seeded from the repo. Service role only.';

alter table public.taos_lite_interpreter_context enable row level security;
