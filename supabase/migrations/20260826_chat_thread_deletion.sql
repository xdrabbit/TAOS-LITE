-- Either partner can burn the chat.
--
-- Until this file, nobody could delete anything in /chat. No DELETE policy on
-- the messages table, no DELETE policy on the threads table, and no route
-- that removed either — the only DELETE in the whole codebase was the invite
-- route rolling back a thread whose first member insert had failed. A couple's
-- entire corpus was write-once, keep-forever, with exactly one deletion mode
-- available to them: delete an ACCOUNT, which cascaded that person's messages
-- away by sender_id and left the other person's half sitting in a thread with
-- half a dialogue in it, permanently readable by whoever stayed.
--
-- `docs/reflections-plan.md` promises couples that either partner may revoke
-- at any time, and `docs/data-map.md` (2026-08-26) named this as one of the
-- three things to settle before any of that gets built. This is the semantic
-- Tom chose, and it is the one the Reflections constitution implies:
--
--     A 1:1 private thread belongs to BOTH of them. Either member may delete
--     the WHOLE thread — the thread row, every message in it from either
--     sender, and the voice audio behind those messages. Not "my half".
--
-- ── Why the whole thread, and not per-message or per-sender ────────────────
-- Because half a conversation is not a smaller conversation, it is a
-- misleading one, and that is precisely the artifact the sender_id cascade
-- already produces. A thread is two people talking; a message of mine only
-- means anything sitting next to the message of theirs it answered. "Delete
-- my messages" would leave the other person holding their own words with the
-- replies removed — a worse record than either deleting nothing or deleting
-- everything.
--
-- The cost is real and is the point: this is destructive to somebody else's
-- copy too. There is no undo, no tombstone, and no notification to the
-- partner. That is what "either partner can revoke" MEANS when the thing being
-- revoked is jointly authored — and it is why the UI in front of this
-- (components/ChatShell.tsx) makes you confirm, in both languages, and says
-- out loud that it removes the chat for both people.
--
-- ── The cascade already existed ────────────────────────────────────────────
-- Nothing below has to delete a message. Every FK into a thread is already
-- ON DELETE CASCADE and has been since chat tier 1:
--
--   taos_lite_chat_members.thread_id  -> threads  ON DELETE CASCADE
--   taos_lite_chat_messages.thread_id -> threads  ON DELETE CASCADE
--   taos_lite_chat_invites.thread_id  -> threads  ON DELETE CASCADE
--
-- So deleting the THREAD row is the whole operation, and the messages of both
-- senders go with it. Checked against pg_constraint before this was written,
-- the lesson from 20260819_chat_members_lang_catalog.sql: the schema is where
-- the truth is, and it does not always match what the TypeScript implies.
create policy "members delete their thread"
  on public.taos_lite_chat_threads
  for delete
  to authenticated
  using (public.taos_lite_is_chat_member(id));

-- ── What this policy deliberately does NOT cover: the audio ────────────────
-- A voice note is two things — a row in taos_lite_chat_messages and an object
-- in the private `chat-voice` bucket — and only the first one is reachable
-- from here. Postgres cannot delete the second one at all: storage.objects
-- carries Supabase's own `protect_objects_delete` trigger, which raises
--
--     Direct deletion from storage tables is not allowed. Use the Storage API
--
-- on any SQL DELETE. So there is no trigger, anywhere, that can make the audio
-- follow the row. It has to be done by something holding the Storage API, and
-- that something is DELETE /api/chat/thread/[id]: it removes the thread's
-- objects FIRST, and only deletes the thread row if that succeeded. Order
-- matters — audio left behind is the privacy failure, a message row pointing
-- at an already-deleted object is a broken play button.
--
-- Which leaves this policy as a way to delete rows and strand audio, if a
-- browser calls supabase.from('taos_lite_chat_threads').delete() directly
-- instead of using the route. Nothing in the app does (lib/chat.ts calls the
-- route), and the policy is still worth having: it is the database itself
-- saying who may revoke, rather than a rule that lives only in a route and
-- evaporates the day somebody writes a second one. The safety net for every
-- path that cannot reach the bucket is the orphan sweep,
-- /api/chat/voice/orphans — an object with no message row pointing at it is
-- garbage by definition, and the sweep is what says so out loud.
--
-- No DELETE policy is added on storage.objects for the same reason, inverted:
-- a member who could delete audio directly could silence a voice note while
-- leaving its message row in the thread, which is a lie in the shape of a
-- broken player. Audio is removed by the route, together with its row.

-- ── Account deletion: no more stranded halves ──────────────────────────────
-- Deleting an account cascades a person's membership row (members.user_id)
-- and their messages (messages.sender_id) — and leaves the THREAD, with the
-- other person's messages in it, and now only one member. From the survivor's
-- phone that is a chat with a partner who has vanished, holding their own
-- unanswered words, which they still cannot delete.
--
-- With the policy above they could delete it by hand, but they should not have
-- to, and they may never open it again. So the thread goes when either member
-- goes, which is the same rule as the policy: it belongs to both, and it
-- lasts exactly as long as both of them want it to.
--
-- BEFORE DELETE, so this runs ahead of the FK cascades and deletes whole
-- threads rather than racing the sender_id cascade that would otherwise empty
-- them first. SECURITY DEFINER because auth.users is deleted by the auth
-- service, not by the owner of these tables — the same shape as
-- handle_new_user, which has been the AFTER INSERT trigger on this table
-- since the first day of the project.
create or replace function public.taos_lite_chat_purge_for_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.taos_lite_chat_threads t
   where exists (
     select 1 from public.taos_lite_chat_members m
      where m.thread_id = t.id and m.user_id = old.id
   );
  return old;
end
$$;

-- Trigger functions have no business being callable over PostgREST. The
-- Supabase linter flags the three that already are (handle_new_user,
-- taos_lite_chat_members_cap, taos_lite_is_chat_member) — harmless in their
-- case, but a SECURITY DEFINER function whose job is "delete threads" should
-- not join the list on the way in.
revoke execute on function public.taos_lite_chat_purge_for_user() from public;
revoke execute on function public.taos_lite_chat_purge_for_user() from anon, authenticated;

drop trigger if exists taos_lite_chat_purge_trg on auth.users;
create trigger taos_lite_chat_purge_trg
  before delete on auth.users
  for each row execute function public.taos_lite_chat_purge_for_user();

-- Storage, again, and the honest caveat this migration ends on: an account
-- deleted through the Supabase dashboard takes its threads and messages with
-- it now, but the voice audio of those threads stays in the bucket, because
-- SQL cannot touch it (see above). Run /api/chat/voice/orphans afterwards —
-- that is the sweep, and it is the only path from a SQL-side deletion to an
-- empty bucket. It is listed as a manual step wherever an account deletion is.
