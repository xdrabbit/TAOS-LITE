-- Tutor phase 2 — the cash register.
--
-- Phase 1 shipped the curriculum and a metering SEAM (lib/tutor/meter.ts): a
-- start line and an end line in the runtime log, and nothing that could refuse
-- a session or remember a minute. This migration is the durable half.
--
-- Four decisions are baked into the DDL below, so read them before changing it.
--
--   1. THE PERIOD IS THE CALENDAR MONTH IN UTC ('YYYY-MM').
--      Not the Stripe billing anniversary. Two reasons: the free tier has no
--      subscription and therefore no anniversary at all, and every other
--      quota in this app already resets on the calendar month
--      (`lib/supabase.ts` getMonthlyUsage / QUOTAS, shipped since the trial).
--      A tutor month that drifted away from the translation month would be a
--      second reset date to explain on the pricing page. UTC rather than a
--      local zone because the server has no opinion about where the learner
--      is standing, and a month boundary that moves with a plane is worse
--      than one that is an hour early in California.
--
--   2. PACK MINUTES ROLL OVER; PLAN MINUTES DO NOT.
--      Plan minutes are what the subscription rents each month and they are
--      gone at the boundary — the standard SaaS expectation, and the one the
--      pricing page already implies with "/ month". Packs are a one-time
--      PURCHASE, so they credit a persistent balance that survives the
--      rollover: money spent does not evaporate on the 1st. That is a change
--      from what shipped — `profiles.bonus_seconds` + `bonus_period` scoped a
--      bought pack to the month it was bought in, which meant a pack bought
--      on the 30th was mostly a donation. Those two columns are backfilled
--      into the new balance below and then left alone (see the note there).
--
--   3. USAGE IS SERVER-AUTHORITATIVE AND RESERVED AT MINT.
--      `tutor_sessions` was written FROM THE BROWSER under RLS
--      (lib/supabase.ts startTutorSession/endTutorSession), which is the open
--      question lib/tutor/meter.ts left for phase 2: the duration was a number
--      the client chose about its own usage. It moves server-side here — the
--      insert/update policies are dropped, the row is written with the service
--      role by POST /api/tutor/realtime, and `granted_seconds` is a
--      RESERVATION held against the balance from the moment the session is
--      minted. An unsettled row therefore costs its full grant, so closing the
--      tab, killing the beacon, or opening a second one cannot buy free
--      minutes. `tutor_reap_open_sessions` collects the ones whose end never
--      arrived.
--
--   4. FOUNDERS ARE LOGGED, NOT LEDGERED.
--      `metered = false` rows exist so a cost query still sees the minutes
--      (they are a real OpenAI bill), while the ledger — which is what the
--      allowance is computed from — never sees them. isFounder() in
--      lib/release.ts is the source of truth for who that is.

-- ── profiles: the persistent pack balance ──────────────────────────────────

alter table public.profiles
  add column if not exists pack_seconds integer not null default 0;

comment on column public.profiles.pack_seconds is
  'Add-on tutor-minute pack balance, in seconds. PERSISTENT: a one-time '
  'purchase, so it rolls over month to month and is only spent by tutor use '
  'after the month''s plan minutes are gone. Credited by the Stripe webhook '
  '(checkout.session.completed, metadata.kind = pack), debited by '
  'public.tutor_accrue().';

-- One-time backfill: whatever an existing pack still had for THIS month
-- becomes the opening persistent balance. A pack bought for a previous month
-- was already forfeit under the old rule and is not resurrected here — that
-- would be inventing a credit nobody was promised.
update public.profiles
   set pack_seconds = greatest(coalesce(bonus_seconds, 0), 0)
 where coalesce(bonus_seconds, 0) > 0
   and bonus_period = to_char(now() at time zone 'utc', 'YYYY-MM')
   and pack_seconds = 0;

-- The old columns are DEAD but not dropped, deliberately and for one release.
-- A browser tab still holding the previously deployed bundle selects them by
-- name in getProfile(); dropping them makes that select error, getProfile()
-- return null, and a signed-in user look signed out until they reload. They
-- are dropped in the follow-up migration once prod has cycled.
comment on column public.profiles.bonus_seconds is
  'DEPRECATED 2026-08-28 (tutor phase 2) — superseded by profiles.pack_seconds, '
  'which is persistent instead of month-scoped. Read by nothing; kept one '
  'release so an un-reloaded client bundle''s getProfile() select still resolves.';
comment on column public.profiles.bonus_period is
  'DEPRECATED 2026-08-28 (tutor phase 2) — see profiles.bonus_seconds.';

-- ── tutor_usage: the ledger ────────────────────────────────────────────────
-- One row per (user, calendar month UTC). `seconds_used` is the number the
-- allowance is computed from; the four source columns are the breakdown and
-- must sum to it.

create table if not exists public.tutor_usage (
  user_id          uuid not null references auth.users(id) on delete cascade,
  period           text not null,
  seconds_used     integer not null default 0,
  -- Source breakdown. crawl is Azure pronunciation scoring (the assessed
  -- audio's own duration — see app/api/tutor/assess); walk, run and partner
  -- are realtime sessions.
  crawl_seconds    integer not null default 0,
  walk_seconds     integer not null default 0,
  run_seconds      integer not null default 0,
  partner_seconds  integer not null default 0,
  -- Of `seconds_used`, how much came out of the persistent pack balance
  -- rather than the month's plan allowance. Plan is always spent first.
  pack_seconds_used integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (user_id, period),
  constraint tutor_usage_period_format check (period ~ '^\d{4}-\d{2}$')
);

comment on table public.tutor_usage is
  'Tutor minutes consumed, per user per calendar month (UTC). Written ONLY by '
  'public.tutor_accrue() with the service role; the browser may read its own '
  'rows and nothing else. Founder sessions are deliberately absent (see '
  'tutor_sessions.metered).';

alter table public.tutor_usage enable row level security;

-- Read-your-own only. There is no user-facing write: a quota a user can edit
-- is not a quota.
drop policy if exists tutor_usage_own_select on public.tutor_usage;
create policy tutor_usage_own_select on public.tutor_usage
  for select to authenticated using (auth.uid() = user_id);

-- ── tutor_sessions: server-owned now ───────────────────────────────────────

alter table public.tutor_sessions
  add column if not exists phase           text,
  add column if not exists module_id       text,
  add column if not exists learner_lang    text,
  -- What the mint reserved. The hold against the balance while unsettled, and
  -- the ceiling on what the session can ever be billed for.
  add column if not exists granted_seconds integer not null default 0,
  -- The tier's PLAN allowance for the period, as it stood at mint. -1 means
  -- unlimited (comp). Stamped on the row rather than looked up at settle time
  -- so the reaper — which runs long after, knowing only the session — splits
  -- plan-vs-pack the same way the live path would have.
  add column if not exists cap_plan_seconds integer not null default -1,
  add column if not exists end_reason      text,
  -- What the browser SAID it used. Recorded for drift, never billed.
  add column if not exists client_seconds  integer,
  -- False for founders: a real cost, deliberately not a ledger entry.
  add column if not exists metered         boolean not null default true,
  -- The split actually debited, once settled.
  add column if not exists plan_seconds    integer not null default 0,
  add column if not exists pack_seconds    integer not null default 0,
  add column if not exists settled_at      timestamptz;

-- Everything already in the table predates metering: 15 rows, both founders,
-- written from the browser. They are HISTORY, not open reservations — leaving
-- settled_at null would hand every one of them to the reaper, which would
-- charge each user their (zero-second) grant and write a ledger row for a
-- month that has nothing to do with the new rules. Close them where they sit.
update public.tutor_sessions
   set settled_at = coalesce(ended_at, created_at),
       metered    = false
 where settled_at is null;

comment on column public.tutor_sessions.granted_seconds is
  'Seconds reserved at mint = min(requested cap, remaining balance). While '
  'settled_at is null this is held against the balance in full, so a session '
  'whose end never arrives cannot become free minutes.';
comment on column public.tutor_sessions.client_seconds is
  'Duration the browser reported. Kept to measure drift against the server '
  'clock; NEVER the number that is billed.';

-- Open reservations, which every allowance check sums.
create index if not exists tutor_sessions_open_idx
  on public.tutor_sessions (user_id, settled_at)
  where settled_at is null;

create index if not exists tutor_sessions_user_created_idx
  on public.tutor_sessions (user_id, created_at desc);

-- The browser no longer writes this table (decision 3 above). Select and
-- delete stay: a user can still see their own history, and delete-means-delete
-- (docs/data-map.md, PR #37) needs the delete policy to remain.
drop policy if exists tutor_sessions_insert_own on public.tutor_sessions;
drop policy if exists tutor_sessions_update_own on public.tutor_sessions;

-- While here: the two surviving policies were granted to {public} rather than
-- {authenticated}, the inconsistency docs/data-map.md finding 10 names. It is
-- harmless (auth.uid() is null for anon, so the USING clause never matches)
-- but it reads as if a signed-out caller has a seat at the table. Re-created
-- against the role the rest of the schema uses.
drop policy if exists tutor_sessions_select_own on public.tutor_sessions;
create policy tutor_sessions_select_own on public.tutor_sessions
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists tutor_sessions_delete_own on public.tutor_sessions;
create policy tutor_sessions_delete_own on public.tutor_sessions
  for delete to authenticated using (auth.uid() = user_id);

-- ── stripe_pack_credits: webhook replay safety ─────────────────────────────
-- Stripe redelivers checkout.session.completed on any non-2xx, on a manual
-- resend from the dashboard, and after a timeout it decided about on its own.
-- Crediting a persistent balance is not idempotent by nature, so the checkout
-- session id is the idempotency key: insert first, and a conflict means this
-- purchase has already been paid out.

create table if not exists public.stripe_pack_credits (
  checkout_session_id text primary key,
  user_id             uuid not null references auth.users(id) on delete cascade,
  seconds             integer not null,
  created_at          timestamptz not null default now()
);

comment on table public.stripe_pack_credits is
  'Idempotency ledger for add-on pack purchases. One row per Stripe checkout '
  'session; its presence means the minutes are already on profiles.pack_seconds.';

alter table public.stripe_pack_credits enable row level security;
-- No policies: service role only. A user has no reason to read this and every
-- reason not to write it.

-- ── tutor_mastery: dropped ─────────────────────────────────────────────────
-- Zero rows, zero call sites in the repo, and a CHECK pinning course_id to
-- ('tom-spanish-1', 'liz-english-1') — a two-course ceiling from a tutor
-- design that no longer exists. The shipped curriculum is fourteen
-- language-agnostic modules (lib/tutor/modules.ts), so every real course_id
-- would be REJECTED by that constraint: the table is not a head start on
-- server-side progress, it is a trap that looks like one. Flagged in
-- docs/data-map.md finding 5.
--
-- Progress tracking is NOT landing in this PR — it stays in localStorage
-- (lib/tutor/progress.ts, keyed module × target × learner) and stays on the
-- backlog. When it lands it wants a table keyed the way the code is keyed,
-- which is not this one.
drop table if exists public.tutor_mastery;

-- ── tutor_accrue: the atomic debit ─────────────────────────────────────────
-- Settling a session touches three things — the session row, the month's
-- ledger row, and the persistent pack balance — and two sessions ending at the
-- same instant must not read-modify-write over each other. So it is one
-- function, one statement each, no round trip in between.
--
-- Returns the settled session's billed seconds, or null if there was nothing
-- to settle (already settled, or not this user's session). Both of those are
-- normal: the end beacon retries, and `keepalive` requests get replayed.

create or replace function public.tutor_accrue(
  p_session_id     uuid,
  p_user_id        uuid,
  p_billed_seconds integer,
  p_client_seconds integer,
  p_reason         text,
  p_period         text
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sess        record;
  v_billed      integer;
  v_plan_cap    integer;
  v_plan_used   integer;
  v_plan_part   integer;
  v_pack_part   integer;
  v_pack_avail  integer;
begin
  -- Lock the session row so a duplicate beacon serializes behind us and then
  -- finds settled_at already set.
  select * into v_sess
    from public.tutor_sessions
   where id = p_session_id and user_id = p_user_id
   for update;

  if not found or v_sess.settled_at is not null then
    return null;
  end if;

  v_billed := least(greatest(coalesce(p_billed_seconds, 0), 0),
                    greatest(v_sess.granted_seconds, 0));

  -- Founder (metered = false): stamp the session so the reservation is
  -- released, and leave the ledger untouched. Logged, not charged.
  if v_sess.metered is not true then
    update public.tutor_sessions
       set seconds        = v_billed,
           client_seconds = p_client_seconds,
           end_reason     = p_reason,
           ended_at       = now(),
           settled_at     = now()
     where id = p_session_id;
    return v_billed;
  end if;

  -- Plan minutes first, then the pack. The tier allowance was stamped on the
  -- session at mint (cap_plan_seconds); -1 means unlimited (comp).
  v_plan_cap := coalesce(v_sess.cap_plan_seconds, -1);

  select coalesce(seconds_used, 0) - coalesce(pack_seconds_used, 0)
    into v_plan_used
    from public.tutor_usage
   where user_id = p_user_id and period = p_period
   for update;
  v_plan_used := coalesce(v_plan_used, 0);

  if v_plan_cap < 0 then
    v_plan_part := v_billed;
    v_pack_part := 0;
  else
    v_plan_part := least(v_billed, greatest(v_plan_cap - v_plan_used, 0));
    v_pack_part := v_billed - v_plan_part;
    select greatest(coalesce(pack_seconds, 0), 0) into v_pack_avail
      from public.profiles where id = p_user_id for update;
    -- Never debit more pack than exists. The overshoot is real usage that
    -- nothing paid for (a session that ran past its grant is capped above, so
    -- this is a narrow case) and it is still recorded in seconds_used — the
    -- ledger tells the truth about consumption even when the balance cannot.
    v_pack_part := least(v_pack_part, coalesce(v_pack_avail, 0));
  end if;

  insert into public.tutor_usage (
    user_id, period, seconds_used,
    crawl_seconds, walk_seconds, run_seconds, partner_seconds,
    pack_seconds_used
  ) values (
    p_user_id, p_period, v_billed,
    case when v_sess.phase = 'crawl'   then v_billed else 0 end,
    case when v_sess.phase = 'walk'    then v_billed else 0 end,
    case when v_sess.phase = 'run'     then v_billed else 0 end,
    case when v_sess.phase = 'partner' then v_billed else 0 end,
    v_pack_part
  )
  on conflict (user_id, period) do update set
    seconds_used      = public.tutor_usage.seconds_used      + excluded.seconds_used,
    crawl_seconds     = public.tutor_usage.crawl_seconds     + excluded.crawl_seconds,
    walk_seconds      = public.tutor_usage.walk_seconds      + excluded.walk_seconds,
    run_seconds       = public.tutor_usage.run_seconds       + excluded.run_seconds,
    partner_seconds   = public.tutor_usage.partner_seconds   + excluded.partner_seconds,
    pack_seconds_used = public.tutor_usage.pack_seconds_used + excluded.pack_seconds_used,
    updated_at        = now();

  if v_pack_part > 0 then
    update public.profiles
       set pack_seconds = greatest(coalesce(pack_seconds, 0) - v_pack_part, 0),
           updated_at   = now()
     where id = p_user_id;
  end if;

  update public.tutor_sessions
     set seconds        = v_billed,
         client_seconds = p_client_seconds,
         end_reason     = p_reason,
         plan_seconds   = v_plan_part,
         pack_seconds   = v_pack_part,
         ended_at       = now(),
         settled_at     = now()
   where id = p_session_id;

  return v_billed;
end;
$$;

revoke all on function public.tutor_accrue(uuid, uuid, integer, integer, text, text) from public, anon, authenticated;

-- ── tutor_reap_open_sessions: the end that never arrived ───────────────────
-- The end beacon is `keepalive` and best-effort, so it can be lost: airplane
-- mode mid-session, a hard app kill, a crashed tab. Those rows would otherwise
-- hold their reservation forever and lock the learner out of their own
-- minutes. Anything past its grant plus a grace window is settled at the full
-- grant — the pessimistic answer, because the session really was minted and
-- OpenAI really did bill for as long as it ran.

create or replace function public.tutor_reap_open_sessions(
  p_user_id uuid,
  p_grace_seconds integer default 120
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r      record;
  n      integer := 0;
  period text;
begin
  for r in
    select id, started_at, granted_seconds
      from public.tutor_sessions
     where user_id = p_user_id
       and settled_at is null
       and started_at < now() - make_interval(secs => granted_seconds + greatest(p_grace_seconds, 0))
  loop
    period := to_char(r.started_at at time zone 'utc', 'YYYY-MM');
    perform public.tutor_accrue(r.id, p_user_id, r.granted_seconds, null, 'lost', period);
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke all on function public.tutor_reap_open_sessions(uuid, integer) from public, anon, authenticated;
