-- Study: lessons made from your own conversations.
--
-- The tutor's lessons are course content — one row per (module, target,
-- learner), identical for everyone, service-role only (20260825_tutor_lessons).
-- A Study lesson is the opposite kind of thing: it is made from ONE person's
-- own translation history, so it belongs to that person the way their history
-- does, and it is read by the browser the way their history is. Hence a
-- user_id, and RLS that says "yours and only yours".
--
-- lesson_key is what the viewer prototype called lessonId: the source rows'
-- ids, the exact selection, and the language pair, hashed. Re-opening the same
-- line gets the saved lesson instead of paying for a new one; the same line
-- explained in the other direction is a different lesson (Spanish explained in
-- English is not English explained in Spanish).
--
-- session_id is carried from the source rows (20261001_translation_sessions)
-- so "every lesson from that dinner" is a query, not a reconstruction. Null
-- when the source rows predate sessions.
--
-- The route writes with the service role and stamps user_id from the verified
-- session (lib/study/lessonStore.ts); the browser never inserts here. It does
-- update (a note) and delete, under its own policies, exactly as history does.

create table if not exists public.taos_lite_study_lessons (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  lesson_key text not null,
  session_id uuid,
  source_ids uuid[] not null default '{}',
  selection text not null default '',
  target_lang text not null,
  explain_lang text not null,
  model text,
  lesson jsonb not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, lesson_key)
);

comment on table public.taos_lite_study_lessons is
  'Study lessons generated from a user''s own taos_lite_translations rows. One row per (user, sources+selection+language pair). Owner-only via RLS.';

-- "My lessons, newest first" — the library screen.
create index if not exists taos_lite_study_lessons_user_created_idx
  on public.taos_lite_study_lessons (user_id, created_at desc);

-- "Every lesson from that conversation."
create index if not exists taos_lite_study_lessons_user_session_idx
  on public.taos_lite_study_lessons (user_id, session_id);

alter table public.taos_lite_study_lessons enable row level security;

drop policy if exists study_own_select on public.taos_lite_study_lessons;
create policy study_own_select on public.taos_lite_study_lessons
  for select using (auth.uid() = user_id);

drop policy if exists study_own_update on public.taos_lite_study_lessons;
create policy study_own_update on public.taos_lite_study_lessons
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists study_own_delete on public.taos_lite_study_lessons;
create policy study_own_delete on public.taos_lite_study_lessons
  for delete using (auth.uid() = user_id);

-- Deliberately no INSERT policy: generation costs money and happens on the
-- server, after the study flag and the spend guard have both had their say.
