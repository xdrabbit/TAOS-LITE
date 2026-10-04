-- A monthly cap on paid lesson generation, per user (2026-10-04).
--
-- POST /api/tutor/lesson and POST /api/study/lesson each mint a completion on
-- a cache miss, and until now nothing counted them: any signed-in free account
-- could generate without limit, and Study's `force: true` skips the cache, so
-- every forced call was a fresh paid call. Tom's standing rule is never to sell
-- unlimited anything on a product with per-unit costs.
--
-- Neither existing table can be the meter. tutor_lessons is course content with
-- no user on it (20260825_tutor_lessons), and taos_lite_study_lessons UPSERTS
-- on (user_id, lesson_key), so a forced regeneration overwrites its row and
-- leaves no trace of having been paid for. Hence a ledger: one row per real
-- generation, nothing else.
--
-- Same shape as the /fast and tutor meters:
--   * THE ROW IS THE RESERVATION, taken before the provider is called, so a
--     refusal costs nothing. lesson_generation_release() deletes it when the
--     generation fails — nobody spends their month on a lesson they never got.
--   * Founders are not counted, but ARE recorded (metered = false), the way a
--     founder's tutor session is: their generations are a real OpenAI bill and
--     a cost query should see them.
--   * Cache hits never reach this table. The route checks the cache first.
--
-- The month is the UTC calendar month, the same period tutor_usage uses
-- (lib/tutor/meter.ts tutorPeriod).

create table if not exists public.lesson_generations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  -- Which route paid. Each has its own cap (lib/lessonCap.ts).
  kind       text not null check (kind in ('tutor', 'study')),
  -- False for founders: recorded for the cost report, never counted.
  metered    boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.lesson_generations is
  'One row per paid lesson generation (POST /api/tutor/lesson, /api/study/lesson). '
  'The per-user monthly cap counts metered rows in the current UTC month. Written '
  'ONLY by lesson_generation_reserve()/release() with the service role.';

create index if not exists lesson_generations_user_kind_created_idx
  on public.lesson_generations (user_id, kind, created_at);

alter table public.lesson_generations enable row level security;
-- No policies: service role only. A counter the counted party can edit is not
-- a counter.

-- Count and reserve in one statement, under a per-(user, kind) lock, so two
-- tabs cannot both take the last lesson of the month.
create or replace function public.lesson_generation_reserve(
  p_user_id uuid,
  p_kind text,
  p_cap integer,
  p_unlimited boolean
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month_start timestamptz := date_trunc('month', now() at time zone 'utc') at time zone 'utc';
  v_used integer;
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('lesson_generation:' || p_user_id::text || ':' || p_kind));

  select count(*) into v_used
    from public.lesson_generations
   where user_id = p_user_id
     and kind = p_kind
     and metered
     and created_at >= v_month_start;

  if not p_unlimited and v_used >= p_cap then
    return jsonb_build_object('ok', false, 'used', v_used, 'cap', p_cap);
  end if;

  insert into public.lesson_generations (user_id, kind, metered)
  values (p_user_id, p_kind, not p_unlimited)
  returning id into v_id;

  return jsonb_build_object(
    'ok', true,
    'id', v_id,
    'used', v_used + case when p_unlimited then 0 else 1 end,
    'cap', p_cap
  );
end;
$$;

revoke all on function public.lesson_generation_reserve(uuid, text, integer, boolean)
  from public, anon, authenticated;

-- Hand a reservation back when the generation it paid for never arrived.
create or replace function public.lesson_generation_release(
  p_user_id uuid,
  p_id uuid
) returns void
language sql
security definer
set search_path = public
as $$
  delete from public.lesson_generations where id = p_id and user_id = p_user_id;
$$;

revoke all on function public.lesson_generation_release(uuid, uuid)
  from public, anon, authenticated;
