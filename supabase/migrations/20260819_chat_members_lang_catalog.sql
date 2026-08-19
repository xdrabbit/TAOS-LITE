-- /chat could not leave English and Spanish, and the schema was the reason.
--
-- taos_lite_chat_members.lang carried `check (lang in ('en','es'))` from the
-- day chat tier 1 landed (20260718161757), when two codes was the whole app.
-- When the catalog went 13 -> 100 (1711a3f4) every language ceiling in the
-- CODE came down — lib/languages/catalog.ts became the one allow-list, and
-- /api/chat/language validates against it through isSupportedLanguageCode.
-- This constraint was the last ceiling, and it was in the database where no
-- amount of reading TypeScript would find it: tapping PL on /chat passed
-- validation, reached Postgres, and came back 23514, which the route reports
-- as "Could not save the language."
--
-- The replacement is deliberately a SHAPE check, not a membership list. A
-- hundred codes enumerated here would be a SECOND catalog that has to be
-- migrated every time someone adds a row to the first one — which is exactly
-- the failure this file is cleaning up. The app owns which languages exist;
-- the database only insists the column holds something language-code shaped,
-- so a bug or a bad client cannot park prose in a field the translation
-- prompts interpolate. Every catalog code is 2 or 3 lowercase letters
-- (Whisper's ids — 'en', 'es', 'pl', 'yue'), and tests/chat-language.test.ts
-- fences that against the catalog so the two can never disagree.
alter table public.taos_lite_chat_members
  drop constraint if exists taos_lite_chat_members_lang_check;

alter table public.taos_lite_chat_members
  add constraint taos_lite_chat_members_lang_check
  check (lang ~ '^[a-z]{2,3}$');
