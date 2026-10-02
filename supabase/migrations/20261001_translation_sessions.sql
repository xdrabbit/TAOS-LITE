-- Conversations, not just turns: a session id on every translation.
--
-- A row in taos_lite_translations is one TURN — one press, one utterance, one
-- translation — and until now nothing tied turns together. The table could
-- say that Liz's phone saved 3,205 rows; it could not say which of them were
-- the same conversation. Reconstructing that after the fact means guessing
-- from timestamps: a 10-minute gap splits Tom and Liz's combined history into
-- 1,089 sessions averaging 6.7 turns, and that guess gets worse the moment
-- usage patterns change. Which turns belonged together is the one fact that is
-- cheap to write at the moment of speaking and impossible to recover later.
--
-- So the client mints a uuid when a conversation starts and sends it with
-- every turn until the conversation goes quiet (lib/translate/session.ts —
-- same 10-minute gap, pinned in tests/translation-sessions.test.ts). This is
-- the foundation for /study (ENHANCEMENTS.md: a lesson from a whole exchange
-- beats one from an orphan line) and, later, for the participant model (who
-- was in a conversation is a property of the conversation, not of the turn).
--
-- What this column does NOT do: it says nothing about who the other person
-- was. docs/data-map.md still reads "Second party: not identified — at all",
-- and that stays true. One phone, one session, both voices.
--
-- Nullable on purpose. Every row written before this ships stays null — Tom's
-- call was that retroactive labelling is not a priority, and a null here is
-- honest where a reconstructed id would be a guess wearing a uuid.
--
-- No RLS change: the existing own-select / own-insert / own-delete policies
-- are on user_id and cover the new column as they cover every other one.

alter table public.taos_lite_translations
  add column if not exists session_id uuid;

comment on column public.taos_lite_translations.session_id is
  'Client-minted id shared by every turn of one conversation on one phone; a new id after 10 minutes of silence. Null on rows written before 2026-10-01. Says nothing about who the second party was.';

-- "Every turn of this conversation, in order" is the query /study will ask,
-- always scoped to the signed-in user first.
create index if not exists taos_lite_translations_user_session_idx
  on public.taos_lite_translations (user_id, session_id, created_at);
