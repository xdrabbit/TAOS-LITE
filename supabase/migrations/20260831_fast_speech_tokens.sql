-- /fast streaming mic, round two — separating the reservation from the token.
--
-- 20260831_fast_speech_metering.sql built one row per Azure Speech token and
-- treated "a token" and "an utterance" as the same event. They are not, and
-- the external review is what made the difference matter:
--
--   * A JWT lives ten minutes. Microsoft's number, not configurable, no
--     narrower scope on offer, and — the part that bites — NO REVOCATION. A
--     token the browser stops using is not a token that stopped working.
--   * So minting one per press did not replace the old credential, it added
--     one. A ten-minute visit with twenty presses left twenty live tokens,
--     each good for the rest of its own ten minutes. The ledger recorded
--     twenty rows and honestly reported thirty seconds of audio each, which
--     was true about the BILL and quiet about the AUTHORITY.
--   * Meanwhile `expires_at` — the reaping deadline — was set to that same
--     ten minutes, so a tab that died mid-sentence kept thirty seconds of the
--     hourly budget encumbered for ten times longer than the utterance it was
--     reserving could possibly have lasted.
--
-- Two columns' worth of change, and the whole shape moves:
--
--   1. `expires_at` now means what the reaper needs it to mean — when this
--      RESERVATION may be collected. The route passes FAST_SPEECH_HOLD_MS
--      (the utterance cap plus a minute), not the token TTL.
--   2. `token_expires_at` is new, and is null on a reservation that issued no
--      credential. It is what the live-token ceiling counts.
--
-- The ceiling is the only lever an unrevokable fixed TTL leaves: not how long
-- a stolen token lasts, but how many can exist. lib/fast/speechMeter.ts states
-- the residual exposure in minutes and dollars rather than calling it closed.
--
-- ORDERING. `fast_speech_mint` is gaining three defaulted parameters, and in
-- Postgres that means a SECOND function rather than a replacement — so the old
-- signature is dropped explicitly below (the repo has paid for this once
-- already). Nothing deployed calls this function today: /fast's speech routes
-- exist only on the #49 branch, and `main` has never shipped them. Apply this
-- before that branch reaches any environment sharing this database.

alter table public.fast_speech_sessions
  add column if not exists token_expires_at timestamptz;

comment on column public.fast_speech_sessions.expires_at is
  'When this RESERVATION may be reaped — one utterance plus slack, not the '
  'token TTL. A reservation left open by a closed tab is billed its full '
  'grant once this passes, and stops holding down the hourly budget.';

comment on column public.fast_speech_sessions.token_expires_at is
  'When the Azure JWT issued for this row stops working, or NULL when this '
  'row issued no credential at all (the caller reused one it already held). '
  'Counting the rows where this is still in the future is the only bound '
  'available on an unrevokable ten-minute token: how many exist at once.';

-- Rows written before this migration each carried their own freshly-minted
-- token, and expires_at was that token's clock. Preserve the fact rather than
-- inventing one: the old value WAS the token expiry.
update public.fast_speech_sessions
   set token_expires_at = expires_at
 where token_expires_at is null;

create index if not exists fast_speech_sessions_live_token_idx
  on public.fast_speech_sessions (user_id, token_expires_at)
  where token_expires_at is not null;

drop function if exists public.fast_speech_mint(uuid, integer, integer, integer, boolean);

create or replace function public.fast_speech_mint(
  p_user_id          uuid,
  -- How long this RESERVATION stays open before the reaper collects it.
  p_ttl_ms           integer,
  p_grant_seconds    integer,
  p_budget_seconds   integer,
  p_unlimited        boolean,
  -- False when the caller already holds a live JWT and wants only a hold.
  p_issue            boolean default true,
  p_token_ttl_ms     integer default 600000,
  p_live_token_limit integer default 6
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
  v_live   integer;
  v_grant  integer := greatest(p_grant_seconds, 1);
  v_id     uuid;
begin
  -- Reap first, so an abandoned hold cannot refuse the press that would have
  -- cleared it. Billed at the full grant deliberately: the reservation was
  -- taken and nobody came back to say it was not used.
  update public.fast_speech_sessions
     set settled_at       = v_now,
         billed_seconds   = granted_seconds,
         end_reason       = 'lost'
   where user_id = p_user_id
     and settled_at is null
     and expires_at < v_now;

  -- The live-token ceiling, and it is NOT conditioned on p_unlimited. Every
  -- other number in this function is about a bill, and a founder's bill is
  -- the founder's business. This one is about how much recognition authority
  -- is loose in the world under one account's name, and a founder's stolen
  -- credential spends exactly the same money as a stranger's.
  --
  -- Checked only when a credential would actually be issued: a caller taking
  -- a reservation against a token it already holds is adding nothing to the
  -- count, and refusing it would push the client back to the batch mic for
  -- being well-behaved.
  if p_issue and p_live_token_limit > 0 then
    select count(*) into v_live
      from public.fast_speech_sessions
     where user_id = p_user_id
       and token_expires_at is not null
       and token_expires_at > v_now;
    if v_live >= p_live_token_limit then
      return jsonb_build_object('ok', false, 'reason', 'live_tokens',
                                'live', v_live, 'limit', p_live_token_limit);
    end if;
  end if;

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

  insert into public.fast_speech_sessions
    (user_id, expires_at, granted_seconds, token_expires_at)
  values
    (p_user_id,
     v_now + make_interval(secs => greatest(p_ttl_ms, 0) / 1000.0),
     v_grant,
     case when p_issue
          then v_now + make_interval(secs => greatest(p_token_ttl_ms, 0) / 1000.0)
          else null end)
    returning id into v_id;

  return jsonb_build_object('ok', true, 'session_id', v_id,
                            'granted_seconds', v_grant,
                            'issued', p_issue,
                            'used_seconds', coalesce(v_used, 0) + coalesce(v_held, 0),
                            'budget', p_budget_seconds);
end;
$$;

revoke all on function public.fast_speech_mint(uuid, integer, integer, integer, boolean, boolean, integer, integer)
  from public, anon, authenticated;
