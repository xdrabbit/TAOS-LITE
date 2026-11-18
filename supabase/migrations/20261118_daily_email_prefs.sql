-- The daily study reminder (Tom, 2026-11-18: "we want them to invite us into
-- their lives every day").
--
-- One row per person who has ever turned "Remind me every day" on, on /study
-- or /tutor. It holds the SETTING and the bookkeeping the hourly cron needs —
-- and nothing a person said. There is no text column here for a phrase, a
-- translation or a lesson, and the email is built from built-in course
-- content only (lib/email/phrases.ts).
--
-- ── What is written, and when ──────────────────────────────────────────────
-- Nothing, until somebody opts in (default OFF). The row is created by
-- /api/email/prefs with the service role, after the auth check and the
-- audience check (TAOS_DAILY_EMAIL = off | founders | all; default founders —
-- lib/email/config.ts).
--
-- ── Columns ────────────────────────────────────────────────────────────────
-- opted_in           the toggle.
-- time_zone          the browser's IANA zone at opt-in ("America/Denver").
-- send_hour          0–23, in that zone. Default 8.
-- lang               the person's own language: what the email is written in
--                    (English and Spanish today; the app decides, not a CHECK).
-- last_sent_day      the LOCAL day (in time_zone) the last email went out.
--                    This is the idempotency stamp: the cron claims a day by
--                    moving it forward, and only the run that moved it sends.
-- last_visit_at      last time they opened /study or /tutor.
-- visit_days         the local days they visited, last seven only. Feeds the
--                    "you practiced N days this week" line. Dates, no content.
-- opted_in_at        when they (last) turned it on. Starts the 21-day clock
--                    for someone who never comes back.
-- paused             set by the cron after 21 days without a visit, with one
--                    last email. A visit clears it.
-- unsubscribed_at    set by the email's unsubscribe link, or a spam
--                    complaint. Cleared only by the person turning the toggle
--                    on again themselves.
-- bounced            set by the provider's webhook. Never cleared by the app:
--                    an address that bounced is not mailed again.
-- unsubscribe_token  random, per row, server-side only. The unsubscribe link
--                    is signed over it (lib/email/token.ts); rotating it
--                    kills that person's old links.
-- last_message_id    the provider's id for the last email, so a bounce event
--                    can be matched to a row without reading an address.
--
-- ── Who can read and change it ─────────────────────────────────────────────
-- RLS on. A signed-in user may SELECT and UPDATE their own row and nobody
-- else's. No insert policy and no delete policy: rows are created by the
-- server, and removed when the account is (cascade).
--
-- The UPDATE is narrowed further by column grants: through the API a user can
-- change only the four columns that are theirs to choose (opted_in,
-- time_zone, send_hour, lang). `bounced`, `unsubscribed_at`, `paused` and the
-- send bookkeeping are not writable from a browser, so nobody can un-bounce
-- themselves or reset their own "already sent today". The cron trusts those
-- columns; that is why they are fenced.
--
-- ── Retention ──────────────────────────────────────────────────────────────
-- Kept while the account exists, so that "unsubscribed" and "bounced" are
-- remembered. Deleted with the account.
--
-- ── Applying it ────────────────────────────────────────────────────────────
-- NOT applied by the PR that added it. Until it is, every read in
-- lib/email/store.ts answers "unavailable": the toggle is not drawn, the cron
-- logs `state=no_table` and stops, and nothing errors.
-- Idempotent: safe to run twice.

create table if not exists public.daily_email_prefs (
  user_id           uuid primary key references auth.users (id) on delete cascade,
  opted_in          boolean not null default false,
  time_zone         text not null default 'UTC',
  send_hour         smallint not null default 8,
  lang              text not null default 'en',
  last_sent_day     date,
  last_visit_at     timestamptz,
  visit_days        date[] not null default '{}',
  opted_in_at       timestamptz,
  paused            boolean not null default false,
  unsubscribed_at   timestamptz,
  bounced           boolean not null default false,
  unsubscribe_token text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  last_message_id   text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint daily_email_prefs_hour check (send_hour between 0 and 23),
  -- No list of codes here, on purpose: a CHECK naming languages is a ceiling
  -- nobody remembers (the /chat one cost a day in August). The app decides
  -- which languages the email can be written in (lib/email/copy.ts).
  constraint daily_email_prefs_lang_len check (char_length(lang) between 2 and 12),
  constraint daily_email_prefs_zone check (char_length(time_zone) between 1 and 64)
);

-- What the hourly cron reads: only rows that may be mailed at all.
create index if not exists daily_email_prefs_sendable
  on public.daily_email_prefs (user_id)
  where opted_in and not paused and not bounced and unsubscribed_at is null;

-- The bounce webhook's fallback lookup.
create index if not exists daily_email_prefs_last_message
  on public.daily_email_prefs (last_message_id)
  where last_message_id is not null;

alter table public.daily_email_prefs enable row level security;

drop policy if exists daily_email_prefs_select_own on public.daily_email_prefs;
create policy daily_email_prefs_select_own on public.daily_email_prefs
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists daily_email_prefs_update_own on public.daily_email_prefs;
create policy daily_email_prefs_update_own on public.daily_email_prefs
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Column fence (see "Who can read and change it" above).
revoke all on public.daily_email_prefs from anon, authenticated;
grant select on public.daily_email_prefs to authenticated;
grant update (opted_in, time_zone, send_hour, lang) on public.daily_email_prefs to authenticated;
