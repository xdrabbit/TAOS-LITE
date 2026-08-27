-- The lesson cache (tutor phase 1).
--
-- A tutor lesson is generated from three inputs — module, target language,
-- learner language — and from nothing else. No user, no session, no clock. So
-- the lesson for (needs-wants, es, en) is the same page for every traveler who
-- ever opens it, and generating it per visit would be paying a model to
-- reproduce a file we already had. lib/tutor/lessonStore.ts caches in process
-- memory first; this table is what survives a deploy or a cold start.
--
-- Nothing user-identifying is stored here, which is the point: the rows are
-- course content, not history. Progress and pronunciation attempts already
-- have their own tables (tutor_attempts, tutor_sessions) and keep their RLS.
--
-- RLS is on with NO policies, matching taos_lite_chat_invites: the browser has
-- no business reading the whole course out of the database, and the route that
-- serves a lesson reaches this table with the service role after the tutor
-- flag and the spend guard have both had their say.
create table if not exists public.tutor_lessons (
  -- lessonCacheKey(): "<module>:<target>:<learner>:v<promptVersion>". The
  -- prompt version is IN the key so a prompt change retires the old rows
  -- instead of serving yesterday's shape to today's parser.
  cache_key text primary key,
  module_id text not null,
  target_lang text not null,
  learner_lang text not null,
  prompt_version integer not null default 0,
  model text,
  lesson jsonb not null,
  created_at timestamptz not null default now()
);

-- "Which pairs have we already paid to generate?" — the question phase 2 will
-- ask when it wants to know what the curriculum actually costs.
create index if not exists tutor_lessons_pair_idx
  on public.tutor_lessons (target_lang, learner_lang);

alter table public.tutor_lessons enable row level security;
-- Deliberately no policies. Service role only; see the comment above.
