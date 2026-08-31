-- The streaming mic's meter, and one repair to the typed one.
--
-- ── Part 1: the repeat that #51 started charging for ───────────────────────
--
-- Before #51, /fast held a `billedRef` set for the life of a visit, and
-- lib/fast/settle.ts said what it was for: "someone deleting a word and
-- putting it back has not asked for a second translation". #49's Clear button
-- was built on that promise and pinned it as its money test — clear the box,
-- retype the same phrase, pay nothing more.
--
-- #51 moved billing to the server and keyed it on a BURST, which is right for
-- everything except this: two bursts of the same words are two rows. The set
-- was a decided behaviour and it was lost by accident, so `fast_begin` gets it
-- back — durably, which is strictly better than the browser had it. A repeat
-- of a question already asked recently ADOPTS the row it already bought,
-- rather than buying a second one.
--
-- Scoped to a window rather than the whole month for two reasons: it bounds
-- the lookup (a subscriber's month can be thousands of rows), and "the same
-- question, still in front of me" is a session-shaped idea, not a calendar
-- one. Six hours is many times any visit.
--
-- Matched on a PREFIX, which is the part that took a second attempt to get
-- right. Billing happens at the START of a burst now, and the start of a burst
-- is somebody's first few letters — so an exact-match rule never fires while
-- a phrase is being retyped: it sees "how much", not "how much is this". The
-- test for a repeat is therefore "what has been typed so far is the beginning
-- of something already answered", and an adopted burst keeps checking that as
-- it grows. The moment the typing diverges — "water" adopted, then "water
-- fountain" — it stops being the same question and buys its own row.
--
-- Direction is part of the key, and auto is why it is not a plain equality.
-- The row is stored with the DETECTED direction, so a lookup requested en→es
-- whose text turned out to be Spanish is on file as es→en. In AUTO the engine
-- will resolve those same words the same way again, so either orientation is
-- the same question. With the direction PINNED it is not — somebody who
-- tapped swap is asking for the other translation, which is what the old
-- client meant by keying `billingKey` on the resolved direction.
--
-- ── Part 2: the streaming mic ──────────────────────────────────────────────
--
-- The live mic streams audio from the PHONE to Azure over a websocket, so the
-- server never sees a byte of it. What the server can control is the
-- CREDENTIAL, and #49 shipped that credential the wrong way twice:
--
--   * `useLiveDictation` minted one ON MOUNT. Opening /fast — not pressing
--     anything — bought a ten-minute Azure Speech JWT. That is nine minutes of
--     standing authority for a screen somebody opened to type a word.
--   * Nothing counted the audio. `POST /api/fast/speech-token` took one chip
--     from the 60/min typing bucket and returned a token good for ten minutes
--     of continuous recognition. The 30-second cap was a `setTimeout` in a
--     browser, which is not where a spend bound belongs — the same sentence
--     lib/fast/dictation.ts already uses about the batch mic's byte ceiling.
--
-- So: a token is minted per PRESS and reserves one utterance's worth of audio
-- seconds, exactly as a tutor session reserves minutes at mint
-- (lib/tutor/meter.ts). The browser reports what it actually streamed when the
-- stream stops; the settle bills the smaller of that and the reservation. An
-- unsettled session — a closed tab, a killed app — is reaped at its full
-- reservation on the owner's next press, so disappearing is never cheaper than
-- finishing.
--
-- ── What this does NOT close, said out loud ────────────────────────────────
--
-- Azure's issueToken TTL is TEN MINUTES and is not configurable; there is no
-- narrower scope to ask for either. So somebody who lifts a live JWT out of
-- their own browser can stream for its full ten minutes, and the server will
-- only ever hear about the seconds the client chose to report. What changed is
-- the size and the visibility of that: from an unbounded, uncounted hole
-- opened by every page view, to a bounded number of tokens an hour, each one
-- minted against a ledger, each one reaped if it never settles.
--
-- The only fix that would make streamed audio as auditable as typed text is to
-- proxy it through a Vercel function, and that is precisely what /fast trades
-- away to put partial transcripts on the screen while somebody is still
-- talking. Filed in ENHANCEMENTS.md rather than pretended away here.

-- ── Part 1: fast_begin adopts a recent repeat ──────────────────────────────

-- Null on an ordinary burst, and the adopted row's text when this burst is
-- riding an answer somebody already paid for. It is what tells a continuation
-- whether it may rewrite the row it points at: its own, yes; an earlier
-- lookup's, never.
alter table public.fast_quickies
  add column if not exists adopted_text text;

-- Dropped rather than replaced: adding a parameter to a Postgres function
-- creates an OVERLOAD, and two fast_begins — one of which quietly charges for
-- repeats — is the kind of pair that gets called by accident for a year. The
-- new parameter carries a DEFAULT, so a caller still sending the old nine
-- named arguments resolves to this one; nothing has to deploy in lockstep.
drop function if exists public.fast_begin(uuid, text, text, text, jsonb, boolean, integer, integer, integer);
drop function if exists public.fast_begin(uuid, text, text, text, jsonb, boolean, integer, integer, integer, integer);

create or replace function public.fast_begin(
  p_user_id      uuid,
  p_source_lang  text,
  p_target_lang  text,
  p_text         text,
  p_caps         jsonb,
  p_unlimited    boolean,
  p_window_ms    integer,
  p_minute_limit integer,
  p_hour_limit   integer,
  p_repeat_ms    integer default 0,
  p_auto         boolean default false
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
  v_repeat  record;
begin
  delete from public.fast_rate
   where user_id = p_user_id and bucket < v_now - interval '2 hours';

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

  select * into v_q from public.fast_quickies
   where user_id = p_user_id
     for update;

  if found
     and v_q.pair = v_pair
     and v_q.row_id is not null
     and v_now - v_q.last_seen_at <= make_interval(secs => greatest(p_window_ms, 0) / 1000.0)
  then
    if v_q.adopted_text is null then
      -- An ordinary burst: this row was bought by these keystrokes, so it
      -- follows them.
      update public.fast_quickies set last_seen_at = v_now where user_id = p_user_id;
      update public.taos_lite_translations
         set original_text = p_text
       where id = v_q.row_id and user_id = p_user_id;
      return jsonb_build_object('ok', true, 'billed', false, 'row_id', v_q.row_id);
    elsif position(btrim(p_text) in v_q.adopted_text) = 1 then
      -- Riding an answer somebody already paid for, and still inside it. The
      -- row is NOT rewritten: it belongs to the earlier lookup, and letting
      -- these keystrokes edit it would quietly delete that history entry.
      update public.fast_quickies set last_seen_at = v_now where user_id = p_user_id;
      return jsonb_build_object('ok', true, 'billed', false, 'row_id', v_q.row_id,
                                'repeat', true);
    end if;
    -- Diverged from what was adopted: a different question now. Fall through.
  end if;

  -- The visit-long billed set, restored durably. A settled row for these exact
  -- words, between these exact two languages, inside the repeat window is the
  -- SAME question — so adopt it rather than charging for it twice. Only a
  -- settled row (a non-empty translation) counts: adopting a reservation still
  -- in flight would let two tabs share one row.
  if greatest(p_repeat_ms, 0) > 0 then
    select id, original_text into v_repeat
      from public.taos_lite_translations
     where user_id = p_user_id
       and translation_text <> ''
       -- What has been typed so far is the beginning of something already
       -- answered. Equality is the case where the whole phrase arrives at
       -- once; the prefix is every other case, because a burst bills on its
       -- first few letters.
       and position(btrim(p_text) in btrim(original_text)) = 1
       -- Direction matters, and auto is why it is not a simple equality. The
       -- row was stored with the DETECTED direction, so a lookup requested
       -- en→es whose text turned out to be Spanish is on file as es→en; in
       -- auto the engine will resolve these same words the same way again, so
       -- either orientation is the same question. A PINNED request is not:
       -- somebody who tapped swap is asking for the other translation, and
       -- the old client keyed on the resolved direction for exactly that
       -- reason (lib/fast/settle.ts, billingKey, before #51).
       and (   (source_lang = p_source_lang and target_lang = p_target_lang)
            or (p_auto and source_lang = p_target_lang and target_lang = p_source_lang))
       and created_at >= v_now - make_interval(secs => greatest(p_repeat_ms, 0) / 1000.0)
     order by created_at desc
     limit 1;

    if v_repeat.id is not null then
      insert into public.fast_quickies (user_id, pair, last_seen_at, row_id, adopted_text)
           values (p_user_id, v_pair, v_now, v_repeat.id, btrim(v_repeat.original_text))
      on conflict (user_id) do update
         set pair = excluded.pair,
             last_seen_at = excluded.last_seen_at,
             row_id = excluded.row_id,
             adopted_text = excluded.adopted_text;
      return jsonb_build_object('ok', true, 'billed', false, 'row_id', v_repeat.id,
                                'repeat', true);
    end if;
  end if;

  if p_unlimited then
    v_cap := -1;
  else
    select subscription_status, tier into v_profile
      from public.profiles where id = p_user_id;
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

  insert into public.taos_lite_translations
    (user_id, source_lang, target_lang, tone, original_text, translation_text, engine)
  values
    (p_user_id, p_source_lang, p_target_lang, 'literal', p_text, '', 'fast')
  returning id into v_row;

  insert into public.fast_quickies (user_id, pair, last_seen_at, row_id, adopted_text)
       values (p_user_id, v_pair, v_now, v_row, null)
  on conflict (user_id) do update
     set pair = excluded.pair,
         last_seen_at = excluded.last_seen_at,
         row_id = excluded.row_id,
         adopted_text = null;

  return jsonb_build_object(
    'ok', true, 'billed', true, 'row_id', v_row,
    'used', case when v_cap >= 0 then coalesce(v_used, 0) + 1 else null end,
    'cap', v_cap
  );
end;
$$;

revoke all on function public.fast_begin(uuid, text, text, text, jsonb, boolean, integer, integer, integer, integer, boolean)
  from public, anon, authenticated;

-- ── Part 2: the streaming ledger ───────────────────────────────────────────

create table if not exists public.fast_speech_sessions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  minted_at        timestamptz not null default now(),
  -- When the Azure JWT stops working. Ten minutes, Microsoft's number.
  expires_at       timestamptz not null,
  -- Audio seconds HELD from mint until settle. One utterance's worth: while
  -- this row is open it costs its full reservation, so a tab that closes
  -- mid-sentence is never cheaper than one that finishes.
  granted_seconds  integer not null,
  -- What the browser said it streamed. Recorded, never trusted past the grant.
  reported_seconds integer,
  billed_seconds   integer not null default 0,
  settled_at       timestamptz,
  end_reason       text
);

comment on table public.fast_speech_sessions is
  'One row per Azure Speech token minted for /fast''s live mic. The audio '
  'never touches this server (the phone streams straight to Azure), so this '
  'is the only ledger there is: granted_seconds is held from mint to settle, '
  'reported_seconds is what the browser claimed, billed_seconds is the lesser '
  'of the two. Written ONLY by the service role.';

alter table public.fast_speech_sessions enable row level security;
-- No policies: service role only.

create index if not exists fast_speech_sessions_open_idx
  on public.fast_speech_sessions (user_id, settled_at)
  where settled_at is null;

create index if not exists fast_speech_sessions_user_minted_idx
  on public.fast_speech_sessions (user_id, minted_at desc);

-- fast_speech_mint — may this person open another socket, and for how long?
--
-- Returns { ok: true, session_id, granted_seconds, used_seconds, budget }
--      or { ok: false, reason: 'budget', used_seconds, budget }
--
-- Reaps first, and the reap is the honest half: any open session whose token
-- has expired is settled at its FULL grant. Azure was reachable for that whole
-- time with a credential we issued, and pretending otherwise would make
-- "close the tab" the cheapest way to use the mic.
create or replace function public.fast_speech_mint(
  p_user_id         uuid,
  p_ttl_ms          integer,
  p_grant_seconds   integer,
  p_budget_seconds  integer,
  p_unlimited       boolean
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now    timestamptz := now();
  v_since  timestamptz := v_now - interval '1 hour';
  v_used   integer;
  v_held   integer;
  v_grant  integer := greatest(p_grant_seconds, 1);
  v_id     uuid;
begin
  update public.fast_speech_sessions
     set settled_at       = v_now,
         billed_seconds   = granted_seconds,
         end_reason       = 'lost'
   where user_id = p_user_id
     and settled_at is null
     and expires_at < v_now;

  if not p_unlimited and p_budget_seconds >= 0 then
    -- The rolling hour: what has been billed, plus what open sessions are
    -- still holding. Both, because a budget that ignored open holds would let
    -- a handful of tabs mint their way past it in the same second.
    select coalesce(sum(billed_seconds), 0) into v_used
      from public.fast_speech_sessions
     where user_id = p_user_id and settled_at is not null and minted_at >= v_since;

    select coalesce(sum(granted_seconds), 0) into v_held
      from public.fast_speech_sessions
     where user_id = p_user_id and settled_at is null;

    if v_used + v_held + v_grant > p_budget_seconds then
      return jsonb_build_object('ok', false, 'reason', 'budget',
                                'used_seconds', v_used + v_held,
                                'budget', p_budget_seconds);
    end if;
  end if;

  insert into public.fast_speech_sessions (user_id, expires_at, granted_seconds)
       values (p_user_id, v_now + make_interval(secs => greatest(p_ttl_ms, 0) / 1000.0), v_grant)
    returning id into v_id;

  return jsonb_build_object('ok', true, 'session_id', v_id,
                            'granted_seconds', v_grant,
                            'used_seconds', coalesce(v_used, 0) + coalesce(v_held, 0),
                            'budget', p_budget_seconds);
end;
$$;

revoke all on function public.fast_speech_mint(uuid, integer, integer, integer, boolean)
  from public, anon, authenticated;

-- fast_speech_settle — the stream stopped; bill what it actually used.
--
-- Idempotent: a beacon delivered twice, or replayed after the reaper already
-- collected the row, settles once. Capped at the grant for the reason
-- lib/tutor/meter.ts caps its own — the reporting party is the one with an
-- interest in the number being small.
create or replace function public.fast_speech_settle(
  p_user_id  uuid,
  p_id       uuid,
  p_seconds  integer,
  p_reason   text
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sess   record;
  v_billed integer;
begin
  select * into v_sess
    from public.fast_speech_sessions
   where id = p_id and user_id = p_user_id
     for update;

  if not found or v_sess.settled_at is not null then
    return null;
  end if;

  v_billed := least(greatest(coalesce(p_seconds, 0), 0), greatest(v_sess.granted_seconds, 0));

  update public.fast_speech_sessions
     set settled_at       = now(),
         reported_seconds = greatest(coalesce(p_seconds, 0), 0),
         billed_seconds   = v_billed,
         end_reason       = coalesce(nullif(p_reason, ''), 'user')
   where id = p_id;

  return v_billed;
end;
$$;

revoke all on function public.fast_speech_settle(uuid, uuid, integer, text)
  from public, anon, authenticated;
