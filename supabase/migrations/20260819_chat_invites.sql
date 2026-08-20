-- How a second person gets into a /chat thread.
--
-- Until this migration there was no way. Threads and memberships had SELECT
-- policies and nothing else, and no route ever inserted one — the single row
-- in taos_lite_chat_threads ("Tom & Liz", 2026-07-18) was typed into the SQL
-- editor by hand. So /chat worked for exactly the two accounts that were
-- seeded and dead-ended for every other account that has ever opened it,
-- including the founder's second Google account during the RC1 walkthrough.
--
-- The entry path is an invite TOKEN, because the alternative — "start a chat
-- with someone" — needs a directory of users to search, and there isn't one
-- (and shouldn't be: the whole screen is two people who already know each
-- other). One person mints a link, the other opens it signed in, and the
-- membership is written by the service role after the token checks out.
--
-- Three things this table is careful about:
--   * The token is the ONLY credential. Nobody may read this table through
--     the anon key, so RLS is on with no policies at all — the same shape as
--     the threads/members tables, which have no INSERT policy for the same
--     reason: /chat's writes belong to the routes, not to the browser.
--   * Single use. accepted_at is claimed with a conditional UPDATE, so two
--     phones racing on the same link produce one member and one honest
--     "this link has already been used".
--   * It expires. A QR photographed off someone's screen stops working.
create table if not exists public.taos_lite_chat_invites (
  token text primary key,
  thread_id uuid not null references public.taos_lite_chat_threads(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz,
  -- Shape only, mirroring lib/chatInvite.ts. The column ends up in a URL that
  -- somebody follows, so "url-safe base64, long enough to be unguessable" is
  -- the property worth pinning in the schema; WHICH tokens are live is the
  -- table's job, not a constraint's.
  constraint taos_lite_chat_invites_token_shape check (token ~ '^[A-Za-z0-9_-]{22,64}$')
);

create index if not exists taos_lite_chat_invites_thread_idx
  on public.taos_lite_chat_invites (thread_id);

alter table public.taos_lite_chat_invites enable row level security;
-- Deliberately no policies. A signed-in browser has no business listing
-- tokens, and the routes reach this table with the service role.

-- ── The two-person cap ─────────────────────────────────────────────────────
-- lib/chat.ts reads a thread as "me and the one other member" (it calls
-- find(), not filter()) and app/api/chat/send translates into exactly one
-- partner language. A third member would not make a group chat; it would make
-- a thread where a third of the messages are invisible to somebody.
--
-- The route checks this too, and the route's check is the one that produces a
-- readable error. This trigger is here for the case the route cannot see: two
-- invites for the same thread redeemed at the same instant, where both
-- requests count one member and both insert. The SELECT ... FOR UPDATE on the
-- thread row is what makes the count trustworthy — it serializes joins per
-- thread, so the second one waits and then fails.
create or replace function public.taos_lite_chat_members_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform 1 from public.taos_lite_chat_threads where id = new.thread_id for update;
  if (select count(*) from public.taos_lite_chat_members where thread_id = new.thread_id) >= 2 then
    raise exception 'chat thread % already has two members', new.thread_id
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

drop trigger if exists taos_lite_chat_members_cap_trg on public.taos_lite_chat_members;
create trigger taos_lite_chat_members_cap_trg
  before insert on public.taos_lite_chat_members
  for each row execute function public.taos_lite_chat_members_cap();
