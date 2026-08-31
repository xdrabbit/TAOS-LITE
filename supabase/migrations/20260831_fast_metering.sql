-- /fast metering — moving the cash register out of the browser.
--
-- What shipped in #46 metered /fast from the CLIENT, and re-reading it after
-- the fact the hole is plain:
--
--   * POST /api/fast never asked about the monthly allowance at all. Its own
--     comment said so and gave a reason — the route sees each preview
--     individually and cannot know which one was the last, so it cannot tell
--     a settled thought from a keystroke.
--   * The bill was `saveTranslation(...).catch(() => {})` in FastShell, 1500ms
--     after the typing stopped. In the browser, best-effort, fail-open.
--   * So a caller who never runs that code — a curl with a valid session, a
--     tab closed at 1400ms, an offline write that failed — translated for
--     free, forever, against an allowance that never moved.
--   * The only server-side bound was lib/fast/rateLimit.ts, a fixed window in
--     module scope. Fluid Compute reuses instances, so the effective ceiling
--     was the limit TIMES the number of warm instances, and it reset on every
--     cold start.
--
-- The premise that the route cannot see a settle was the wrong one. The
-- client's 1500ms settle measures a PAUSE IN TYPING, and the server watches
-- the same typing: the gap between two requests from one account is the same
-- pause, measured on the clock that cannot be edited. So the unit of billing
-- becomes a BURST — a contiguous run of previews with no gap longer than the
-- settle window — and it is decided here rather than trusted from a browser.
--
-- Three decisions are baked into the DDL below.
--
--   1. THE ALLOWANCE METER IS STILL `taos_lite_translations`.
--      Not a private /fast counter. The free tier's 25 a month is a count of
--      rows in that table (lib/supabase.ts, getMonthlyUsage / QUOTAS), and the
--      home screen, /translate and /fast all spend from it. A second counter
--      would be a second number to reconcile, and the first support email
--      about it would be right. What changes is WHO writes the row: the
--      service role, inside `fast_begin`, instead of the browser.
--
--   2. THE ROW IS THE RESERVATION, TAKEN BEFORE THE PROVIDER IS CALLED.
--      Exactly the shape lib/tutor/meter.ts settled on for a realtime session,
--      and for the same reason: a refusal has to cost nothing, so the
--      allowance is checked and consumed BEFORE any money is spent, not after.
--      The row is inserted with the source text and an EMPTY translation, and
--      `fast_record` fills it in when the engine answers. If the engine falls
--      over, `fast_abandon` deletes it — nobody is billed for a translation
--      they never received.
--
--   3. THE RATE LIMIT IS DURABLE, AND IT IS A BOUND, NOT A FENCE.
--      `fast_rate` is a fixed-window counter in Postgres, shared by every
--      instance, surviving cold starts. It is aligned to the wall clock
--      (date_trunc) rather than to a caller's first hit, which is a real
--      difference from the in-memory version it backs: a burst straddling a
--      minute boundary gets two windows' worth. That is fine for a spend
--      bound. The FENCE is still guardSpend — every hit counted here already
--      belongs to a known, founder-gated account.

-- ── fast_rate: the durable ceiling ─────────────────────────────────────────

create table if not exists public.fast_rate (
  user_id     uuid not null references auth.users(id) on delete cascade,
  -- 'minute' | 'hour'. Named rather than derived from the bucket width so a
  -- future third window does not need a migration to tell them apart.
  window_name text not null,
  -- Start of the fixed window, truncated to the wall clock.
  bucket      timestamptz not null,
  count       integer not null default 0,
  primary key (user_id, window_name, bucket)
);

comment on table public.fast_rate is
  'Per-user request counters for POST /api/fast, per fixed wall-clock window. '
  'Durable and shared across Vercel instances, which is the whole point: the '
  'predecessor (lib/fast/rateLimit.ts) counted in module scope, so the real '
  'ceiling was the limit times the number of warm instances. Written ONLY by '
  'public.fast_begin() with the service role.';

alter table public.fast_rate enable row level security;
-- No policies: service role only. A counter the counted party can edit is not
-- a counter.

-- ── fast_quickies: the open burst ──────────────────────────────────────────
-- One row per user, holding the quickie currently being typed. `last_seen_at`
-- is what the settle window is measured against, and `row_id` is the
-- taos_lite_translations row this burst already bought — so every preview
-- after the first updates that row instead of buying another.

create table if not exists public.fast_quickies (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  -- The direction AS REQUESTED ('en>es'), not as detected. Stable across a
  -- burst even in auto mode, where the detected source can change from one
  -- preview to the next while the person is still typing the first word.
  -- Tapping swap changes it, which ends the burst: asking for the same words
  -- the other way round is a different question and is billed as one.
  pair         text not null,
  last_seen_at timestamptz not null default now(),
  row_id       uuid references public.taos_lite_translations(id) on delete set null
);

comment on table public.fast_quickies is
  'The /fast quickie each user is currently typing. A request within the '
  'settle window of last_seen_at, in the same requested direction, is the '
  'SAME billable quickie and updates row_id rather than buying a new row.';

alter table public.fast_quickies enable row level security;
-- No policies: service role only.

-- ── fast_begin: rate, allowance, and the burst decision, in one round trip ─
-- One function because this runs on the hot path of somebody typing — the
-- route already spends a debounce and a provider call, and three separate
-- round trips to decide whether to spend them would be felt.
--
-- Returns jsonb:
--   { ok: true,  billed: bool, row_id: uuid, used: int, cap: int }
--   { ok: false, reason: 'rate_minute' | 'rate_hour' | 'quota', used, cap }
--
-- `p_caps` is the tier -> monthly translation allowance map, passed in as
-- jsonb so the numbers stay in TypeScript beside the ones the pricing page
-- and the browser read (lib/supabase.ts QUOTAS). -1 means unlimited.
-- `p_unlimited` is the founder bypass, which is an EMAIL question
-- (lib/release.ts isFounder) and therefore not one the database can answer.

create or replace function public.fast_begin(
  p_user_id      uuid,
  p_source_lang  text,
  p_target_lang  text,
  p_text         text,
  p_caps         jsonb,
  p_unlimited    boolean,
  p_window_ms    integer,
  p_minute_limit integer,
  p_hour_limit   integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now     timestamptz := now();
  v_pair    text := p_source_lang || '>' || p_target_lang;
  v_count   integer;
  v_q       record;
  v_profile record;
  v_tier    text;
  v_cap     integer;
  v_used    integer;
  v_row     uuid;
begin
  -- Sweep this user's expired windows. Cheap: it is an index scan over the
  -- two or three rows under their own primary-key prefix, and without it a
  -- long-lived table accumulates a row per user per minute forever.
  delete from public.fast_rate
   where user_id = p_user_id and bucket < v_now - interval '2 hours';

  -- ── the durable rate limit ───────────────────────────────────────────────
  -- Minute first, then hour, short-circuiting on the first that trips — the
  -- same ordering lib/fast/rateLimit.ts documents, and for the same reason:
  -- burning the hour's budget on requests the minute already refused turns a
  -- fast typist into an hour-long lockout.
  insert into public.fast_rate as r (user_id, window_name, bucket, count)
       values (p_user_id, 'minute', date_trunc('minute', v_now), 1)
  on conflict (user_id, window_name, bucket)
    do update set count = r.count + 1
    returning r.count into v_count;
  if v_count > greatest(p_minute_limit, 1) then
    return jsonb_build_object('ok', false, 'reason', 'rate_minute');
  end if;

  insert into public.fast_rate as r (user_id, window_name, bucket, count)
       values (p_user_id, 'hour', date_trunc('hour', v_now), 1)
  on conflict (user_id, window_name, bucket)
    do update set count = r.count + 1
    returning r.count into v_count;
  if v_count > greatest(p_hour_limit, 1) then
    return jsonb_build_object('ok', false, 'reason', 'rate_hour');
  end if;

  -- ── is this preview a continuation of the open quickie? ──────────────────
  -- Locked, so two tabs typing at once serialize here rather than each
  -- deciding it is the one that opened the burst.
  select * into v_q from public.fast_quickies
   where user_id = p_user_id
     for update;

  if found
     and v_q.pair = v_pair
     and v_q.row_id is not null
     and v_now - v_q.last_seen_at <= make_interval(secs => greatest(p_window_ms, 0) / 1000.0)
  then
    update public.fast_quickies
       set last_seen_at = v_now
     where user_id = p_user_id;
    -- The burst already bought its row; keep the source text current so the
    -- History entry reads as the finished phrase rather than its first word.
    update public.taos_lite_translations
       set original_text = p_text
     where id = v_q.row_id and user_id = p_user_id;
    return jsonb_build_object('ok', true, 'billed', false, 'row_id', v_q.row_id);
  end if;

  -- ── a new quickie: the allowance ─────────────────────────────────────────
  if p_unlimited then
    v_cap := -1;
  else
    select subscription_status, tier into v_profile
      from public.profiles where id = p_user_id;
    -- Mirrors getTier() in lib/supabase.ts. A canceled or expired subscriber
    -- falls back to free — they keep the monthly allowance rather than being
    -- locked out.
    if v_profile.subscription_status = 'comp' then
      v_tier := 'comp';
    elsif v_profile.subscription_status = 'active' then
      v_tier := case when v_profile.tier = 'premium' then 'premium' else 'basic' end;
    else
      v_tier := 'free';
    end if;
    v_cap := coalesce((p_caps ->> v_tier)::integer, (p_caps ->> 'free')::integer, 25);
  end if;

  if v_cap >= 0 then
    select count(*) into v_used
      from public.taos_lite_translations
     where user_id = p_user_id
       and created_at >= (date_trunc('month', v_now at time zone 'utc') at time zone 'utc');
    if v_used >= v_cap then
      return jsonb_build_object('ok', false, 'reason', 'quota', 'used', v_used, 'cap', v_cap);
    end if;
  end if;

  -- ── reserve ──────────────────────────────────────────────────────────────
  -- The row is inserted BEFORE the engine is called, with an empty
  -- translation that fast_record fills in. That ordering is the fix: the
  -- allowance moves first, so a refusal costs nothing and a caller who
  -- disappears mid-request has still spent what they started. fast_abandon
  -- deletes it when the engine itself fails.
  --
  -- user_id is passed explicitly. The column defaults to auth.uid(), which is
  -- null under the service role — the browser's insert relied on that default
  -- and this one cannot.
  insert into public.taos_lite_translations
    (user_id, source_lang, target_lang, tone, original_text, translation_text, engine)
  values
    (p_user_id, p_source_lang, p_target_lang, 'literal', p_text, '', 'fast')
  returning id into v_row;

  insert into public.fast_quickies (user_id, pair, last_seen_at, row_id)
       values (p_user_id, v_pair, v_now, v_row)
  on conflict (user_id) do update
     set pair = excluded.pair,
         last_seen_at = excluded.last_seen_at,
         row_id = excluded.row_id;

  -- `used` is null for an unlimited caller: the count above was never taken,
  -- and a number nobody measured is worse than no number.
  return jsonb_build_object(
    'ok', true, 'billed', true, 'row_id', v_row,
    'used', case when v_cap >= 0 then coalesce(v_used, 0) + 1 else null end,
    'cap', v_cap
  );
end;
$$;

revoke all on function public.fast_begin(uuid, text, text, text, jsonb, boolean, integer, integer, integer)
  from public, anon, authenticated;

-- ── fast_record: the engine answered ───────────────────────────────────────
-- Fills in the reserved row. The languages are re-stated because auto mode
-- only learns which side was typed from the engine's reply, and the reserved
-- row was written with the direction as REQUESTED.

create or replace function public.fast_record(
  p_user_id     uuid,
  p_row_id      uuid,
  p_source_lang text,
  p_target_lang text,
  p_text        text,
  p_translation text,
  p_engine      text
) returns void
language sql
security definer
set search_path = public
as $$
  update public.taos_lite_translations
     set source_lang      = p_source_lang,
         target_lang      = p_target_lang,
         original_text    = p_text,
         translation_text = p_translation,
         engine           = coalesce(nullif(p_engine, ''), 'fast')
   where id = p_row_id and user_id = p_user_id;
$$;

revoke all on function public.fast_record(uuid, uuid, text, text, text, text, text)
  from public, anon, authenticated;

-- ── fast_abandon: the engine did not ───────────────────────────────────────
-- Refunds the reservation. Guarded on the empty translation so a retry that
-- races a successful record cannot delete a real answer, and it ends the
-- burst, so the next request re-asks the allowance rather than inheriting a
-- hold that bought nothing.

create or replace function public.fast_abandon(
  p_user_id uuid,
  p_row_id  uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.fast_quickies
   where user_id = p_user_id and row_id = p_row_id;
  delete from public.taos_lite_translations
   where id = p_row_id and user_id = p_user_id and translation_text = '';
end;
$$;

revoke all on function public.fast_abandon(uuid, uuid) from public, anon, authenticated;

-- The allowance query above counts a user's rows for the current month on
-- every NEW quickie. 2,575 rows today, so it is a small scan either way, but
-- it runs on a typing path and it is the one query here that grows with use.
create index if not exists taos_lite_translations_user_created_idx
  on public.taos_lite_translations (user_id, created_at desc);
