-- /fast round two — History defended at the database, and adoption given a floor.
--
-- Two findings from the external review, and they are the same finding seen
-- from two sides: `public.fast_begin` can hand a caller the id of a row it did
-- not buy, and `public.fast_record` will then blind-UPDATE whatever id it is
-- handed.
--
-- ── 1. The refusal was real and it was in the wrong language ───────────────
-- When a burst ADOPTS an earlier answer, lib/fast/meter.ts skips the write:
--
--     export async function recordFastQuickie(input) {
--       if (input.repeat) return;
--
-- That is correct, and it is one `if` in TypeScript standing between somebody
-- else's paid History entry and being overwritten by whatever is in the box
-- now. A refactor that drops it, an exception path that misses it, or any
-- caller that reaches `fast_record` by another road, and a row that reads
-- "where is the pharmacy" quietly becomes "asdf". Nothing in the database
-- would refuse, and nothing in the database would notice.
--
-- So the rule moves down here. A row that has been adopted is SEALED, and a
-- sealed row's content cannot be rewritten by anybody — not fast_record, not
-- a hand-typed UPDATE in the SQL editor, not a future surface that has never
-- heard of any of this. The JS check stays exactly where it is; it is now an
-- optimisation rather than the fence.
--
-- Note what is NOT sealed: deletion. `fast_abandon` still deletes, an account
-- deletion still cascades, and docs/data-hygiene has one rule that outranks
-- every other rule in this file — delete means delete.
--
-- ── 2. "I" is not a question anybody already answered ──────────────────────
-- The repeat window matches on a PREFIX, and it has to: billing happens at
-- the start of a burst, which is somebody's first few letters, so an exact
-- match would never fire while a phrase was being retyped.
--
-- But an unbounded prefix rule makes every short opener a key to somebody
-- else's row. Typing "I" matched "I need a doctor"; "the" matched anything
-- starting with "the"; "where" matched "where is the bank" — for six hours,
-- because that was the window. Two costs, and the second is the real one:
-- those lookups were free when they should not have been, AND they never
-- reached History at all, because an adopted burst deliberately writes
-- nothing. Somebody's actual question vanished into a stranger's older row.
--
-- The floor, and every number in it is a trade rather than a discovery:
--
--   * at least 4 characters. "I" and "the" stop being keys.
--   * the prefix must span a word boundary, or BE the whole stored phrase.
--     This is what stops "where" from opening "where is the bank" while still
--     letting somebody retype the single-word quickie "where" for free. In a
--     language that does not put spaces between words the boundary test can
--     never pass, so only whole-phrase equality adopts there — which is the
--     common retype anyway, and is the honest failure direction: it charges
--     for a repeat rather than hiding a question.
--   * and either 12 characters (long enough to mean something by itself) or
--     60% of the stored phrase (short enough that retyping "how much" is
--     still free at "how m").
--
--   "I"      -> 1 char                         -> no
--   "the"    -> 3 chars                        -> no
--   "where"  -> no space, ≠ "where is the bank" -> no
--   "how m"  -> 5 chars, has a space, 62%      -> YES, and that is the point
--
-- The window comes in from six hours to thirty minutes at the same time. Six
-- hours was never the promise: what FastShell held before #51 was a set for
-- the life of a VISIT, and a visit is not an afternoon.
--
-- ── 3. Which breaks the retype promise, so the burst re-checks ─────────────
-- A floor and a burst that bills on its first letter cannot both hold: by the
-- time there is enough text to recognise the question, the row is already
-- bought. So the burst now looks again as it grows, and when it finds that it
-- has been retyping something already answered it adopts that answer and
-- DELETES the row it opened seconds ago. Its own row, its own reservation,
-- nobody has seen it. The allowance goes back where it came from.
--
-- ORDERING, and it is the same warning as the file above it. `fast_begin`'s
-- `p_repeat_ms integer` becomes `p_repeat jsonb`, which is a different
-- signature and therefore a second function unless the old one is dropped
-- explicitly. `main` calls `fast_begin` with its first NINE arguments by name
-- and is unaffected either way — everything after them defaults — but that
-- only stays true if exactly one overload exists. Apply this to the shared
-- database BEFORE the branch that calls it reaches any environment.

-- ───────────────────────────────────────────────────────────────────────────
-- The seal
-- ───────────────────────────────────────────────────────────────────────────

alter table public.taos_lite_translations
  add column if not exists fast_sealed_at timestamptz;

comment on column public.taos_lite_translations.fast_sealed_at is
  'Set when public.fast_begin hands this row to a LATER /fast burst as an '
  'already-answered question. From then on it is history rather than a live '
  'draft, and the trigger below refuses to let its content be rewritten. '
  'Null on every row no /fast burst has ever adopted, which is almost all of '
  'them.';

create or replace function public.fast_guard_sealed()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.fast_sealed_at is null then
    return new;
  end if;

  -- A no-op rather than an exception, and the choice is deliberate.
  -- `fast_record` is fire-and-forget on a request the person is still waiting
  -- on: raising here would turn a defended row into a failed translation for
  -- somebody who did nothing wrong. The write is dropped, the warning goes to
  -- the Postgres log where a real one can be investigated, and the caller
  -- gets the answer it was owed.
  if new.original_text    is distinct from old.original_text
  or new.translation_text is distinct from old.translation_text
  or new.source_lang      is distinct from old.source_lang
  or new.target_lang      is distinct from old.target_lang
  or new.tone             is distinct from old.tone
  or new.engine           is distinct from old.engine then
    raise warning 'taos.fast: refused a content rewrite of sealed translation %', old.id;
    new.original_text    := old.original_text;
    new.translation_text := old.translation_text;
    new.source_lang      := old.source_lang;
    new.target_lang      := old.target_lang;
    new.tone             := old.tone;
    new.engine           := old.engine;
  end if;

  -- And it cannot be un-sealed, or the defence would be one UPDATE deep.
  new.fast_sealed_at := old.fast_sealed_at;
  return new;
end;
$$;

drop trigger if exists fast_guard_sealed_trg on public.taos_lite_translations;
create trigger fast_guard_sealed_trg
  before update on public.taos_lite_translations
  for each row execute function public.fast_guard_sealed();

-- ───────────────────────────────────────────────────────────────────────────
-- The adoption floor, as one function both lookups share
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.fast_repeat_match(
  -- Both are expected pre-trimmed by the caller.
  p_typed        text,
  p_stored       text,
  p_min_chars    integer,
  p_min_ratio    numeric,
  p_strong_chars integer
) returns boolean
language sql
immutable
as $$
  select p_typed is not null
     and p_stored is not null
     and length(p_typed) >= greatest(p_min_chars, 1)
     -- What has been typed so far is the beginning of something already
     -- answered. Equality is the case where the whole phrase arrives at once;
     -- the prefix is every other case, because a burst bills on its first few
     -- letters.
     and position(p_typed in p_stored) = 1
     -- A whole word, or the whole thing. This is the rule that stops a short
     -- opener from being a key to a longer stranger.
     and (p_typed = p_stored or position(' ' in p_typed) > 0)
     -- Long enough to mean something on its own, or far enough through the
     -- stored phrase to be recognisably the same question.
     and (length(p_typed) >= greatest(p_strong_chars, 1)
          or length(p_typed) >= ceil(length(p_stored) * greatest(p_min_ratio, 0)));
$$;

revoke all on function public.fast_repeat_match(text, text, integer, numeric, integer)
  from public, anon, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- fast_begin, with the floor and the burst re-check
-- ───────────────────────────────────────────────────────────────────────────

drop function if exists public.fast_begin(uuid, text, text, text, jsonb, boolean, integer, integer, integer, integer, boolean);

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
  -- Every repeat-window knob in one bag, so the next one to move does not
  -- change this function's signature again. Keys: ms, min_chars, min_ratio,
  -- strong_chars. Null or absent means the repeat window is off, which is
  -- what `main`'s nine-argument call gets and why its behaviour is unchanged.
  p_repeat       jsonb default null,
  p_auto         boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now       timestamptz := now();
  v_pair      text := p_source_lang || '>' || p_target_lang;
  v_text      text := btrim(p_text);
  v_count     integer;
  v_q         record;
  v_profile   record;
  v_tier      text;
  v_cap       integer;
  v_used      integer;
  v_row       uuid;
  v_repeat    record;
  v_repeat_ms bigint  := coalesce((p_repeat ->> 'ms')::bigint, 0);
  v_min_chars integer := coalesce((p_repeat ->> 'min_chars')::integer, 4);
  v_min_ratio numeric := coalesce((p_repeat ->> 'min_ratio')::numeric, 0.6);
  v_strong    integer := coalesce((p_repeat ->> 'strong_chars')::integer, 12);
  v_since     timestamptz;
begin
  v_since := v_now - make_interval(secs => greatest(v_repeat_ms, 0) / 1000.0);

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
      -- The burst bought its row on its first few letters, before there was
      -- enough text to recognise it as a question already answered. There may
      -- be enough now — so look again, and if this turns out to be a retype,
      -- take the older answer and hand this burst's own reservation back. It
      -- is this account's own row, seconds old, and nobody has seen it.
      if v_repeat_ms > 0 then
        select id, original_text into v_repeat
          from public.taos_lite_translations
         where user_id = p_user_id
           and id <> v_q.row_id
           and translation_text <> ''
           and public.fast_repeat_match(v_text, btrim(original_text),
                                        v_min_chars, v_min_ratio, v_strong)
           and (   (source_lang = p_source_lang and target_lang = p_target_lang)
                or (p_auto and source_lang = p_target_lang and target_lang = p_source_lang))
           and created_at >= v_since
         order by created_at desc
         limit 1;

        if v_repeat.id is not null then
          -- The refund. Guarded on the seal for the same reason everything
          -- else here is: a row somebody else's burst adopted is not this
          -- burst's to delete either.
          delete from public.taos_lite_translations
           where id = v_q.row_id and user_id = p_user_id and fast_sealed_at is null;

          update public.taos_lite_translations
             set fast_sealed_at = coalesce(fast_sealed_at, v_now)
           where id = v_repeat.id and user_id = p_user_id;

          update public.fast_quickies
             set last_seen_at = v_now,
                 row_id       = v_repeat.id,
                 adopted_text = btrim(v_repeat.original_text)
           where user_id = p_user_id;

          return jsonb_build_object('ok', true, 'billed', false,
                                    'row_id', v_repeat.id, 'repeat', true);
        end if;
      end if;

      -- An ordinary burst: this row was bought by these keystrokes, so it
      -- follows them.
      update public.fast_quickies set last_seen_at = v_now where user_id = p_user_id;
      update public.taos_lite_translations
         set original_text = v_text
       where id = v_q.row_id and user_id = p_user_id;
      return jsonb_build_object('ok', true, 'billed', false, 'row_id', v_q.row_id);
    elsif position(v_text in v_q.adopted_text) = 1 then
      -- Riding an answer somebody already paid for, and still inside it. The
      -- row is NOT rewritten: it belongs to the earlier lookup, and letting
      -- these keystrokes edit it would quietly delete that history entry.
      -- Since the seal above, the database refuses that rewrite outright, so
      -- this branch is the cheap path rather than the fence.
      update public.fast_quickies set last_seen_at = v_now where user_id = p_user_id;
      return jsonb_build_object('ok', true, 'billed', false, 'row_id', v_q.row_id,
                                'repeat', true);
    end if;
    -- Diverged from what was adopted: a different question now. Fall through.
  end if;

  -- The visit-long billed set, restored durably. A settled row whose text
  -- this one is a MEANINGFUL prefix of, between these exact two languages,
  -- inside the repeat window is the SAME question — so adopt it rather than
  -- charging for it twice. Only a settled row (a non-empty translation)
  -- counts: adopting a reservation still in flight would let two tabs share
  -- one row.
  if v_repeat_ms > 0 then
    select id, original_text into v_repeat
      from public.taos_lite_translations
     where user_id = p_user_id
       and translation_text <> ''
       and public.fast_repeat_match(v_text, btrim(original_text),
                                    v_min_chars, v_min_ratio, v_strong)
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
       and created_at >= v_since
     order by created_at desc
     limit 1;

    if v_repeat.id is not null then
      update public.taos_lite_translations
         set fast_sealed_at = coalesce(fast_sealed_at, v_now)
       where id = v_repeat.id and user_id = p_user_id;

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
    (p_user_id, p_source_lang, p_target_lang, 'literal', v_text, '', 'fast')
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

revoke all on function public.fast_begin(uuid, text, text, text, jsonb, boolean, integer, integer, integer, jsonb, boolean)
  from public, anon, authenticated;
