-- A credential that was never issued must not hold a live-token slot.
--
-- 20260831_fast_speech_tokens.sql split "a reservation" from "a credential"
-- and added the only bound Azure's fixed, unrevokable ten-minute JWT leaves:
-- a ceiling on how many of an account's tokens may be ALIVE at once
-- (fast_speech_mint's p_live_token_limit, default 6). It counts rows whose
-- `token_expires_at` is still in the future.
--
-- The external review found the hole in that, and it is a good one:
--
--   POST /api/fast/speech-token RESERVES BEFORE IT MINTS. The row is written
--   with token_expires_at = now + 10 min, and only then does the route call
--   Azure's issueToken. When that call fails — an unconfigured resource, a
--   401 on a rotated key, a timeout, an empty body — the route hands the
--   RESERVATION back (settle, zero seconds, reason 'error') and the person
--   gets the batch mic. But the row it settled still says a token of its own
--   is alive for ten minutes.
--
--   So a failed mint holds a slot it never filled. Six failures in ten
--   minutes and the ceiling refuses the seventh press, and the streaming mic
--   silently becomes the batch mic for the life of a JWT that does not exist.
--   The exact shape of an outage at Microsoft turning into a quiet, sticky
--   degradation here — and on the day AZURE_SPEECH_KEY is rotated, six
--   presses is one field test.
--
-- The fix is a fact, not a policy: nothing was issued, so nothing is alive.
-- `fast_speech_settle` gains p_release_token, which nulls token_expires_at,
-- and only the token route passes it — on the paths where the server itself
-- knows no credential ever left the building.
--
-- ── What this deliberately does NOT do ────────────────────────────────────
-- It does not free a slot because a CLIENT says its session died early. A
-- credential that reached a browser is live for the rest of its ten minutes
-- whatever happens next, and "I did not use it" is not checkable — a caller
-- willing to say it after every mint would lift the ceiling entirely, and the
-- ceiling is the only bound there is. POST /api/fast/speech-settle therefore
-- never passes this flag, and tests/fast-speech-metering.test.ts pins that
-- the reported end of a session frees a reservation and NOT a slot.
--
-- ORDERING. A defaulted parameter makes a SECOND function in Postgres rather
-- than replacing the first, so the old four-argument signature is dropped
-- explicitly, in the same transaction as the create. Nothing deployed calls
-- this function: /fast's speech routes exist only on the #49 branch.

drop function if exists public.fast_speech_settle(uuid, uuid, integer, text);

create or replace function public.fast_speech_settle(
  p_user_id       uuid,
  p_id            uuid,
  p_seconds       integer,
  p_reason        text,
  -- True only when the SERVER knows no JWT was ever issued against this row.
  -- Never set from a client-reported end of session; see the header.
  p_release_token boolean default false
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
         end_reason       = coalesce(nullif(p_reason, ''), 'user'),
         -- Null means "this row issued no credential", which is exactly what
         -- a mint that failed at Azure left behind. The live-token count
         -- ignores nulls, so the slot is free the moment this commits.
         token_expires_at = case when p_release_token then null else token_expires_at end
   where id = p_id;

  return v_billed;
end;
$$;

revoke all on function public.fast_speech_settle(uuid, uuid, integer, text, boolean)
  from public, anon, authenticated;
