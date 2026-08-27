# The data map — who speaks to whom

*Read-only audit, 2026-08-26. Groundwork for Reflections
(`docs/reflections-plan.md`). Nothing here changed the schema, the data, or
the app; the only writes in this PR are this file and one line in the
Reflections plan.*

**Method.** The repo's `supabase/migrations/` holds four files and covers four
objects — most of this schema was applied by hand in the SQL editor and exists
only in the database. So this map was read from the **live schema** of
`duqkmuaceklnfgvoufrz` (`pg_policies`, `pg_constraint`, `storage.buckets`,
`information_schema`) and cross-checked against every `.from(...)`,
`.insert/.update/.delete`, and `storage.from(...)` call site in `app/` and
`lib/`. That is the same lesson as
`20260819_chat_members_lang_catalog.sql`: a ceiling can live in Postgres where
no amount of reading TypeScript will find it. Row counts are as of the audit.

---

## The short answer

**The database tracks WHO speaks to WHOM in exactly one place: `/chat`.** A
chat thread is a real, account-linked edge — `taos_lite_chat_members` puts two
`auth.users` ids on the same `thread_id`, and every message carries a
`sender_id`, so the corpus is genuinely attributable to a *pair* and to each
side of it. Everywhere else, the answer is "user X had a session": `/translate`
saves one row per turn with `user_id`, the two language codes, and the full
text of both sides of the utterance — but the **second person is never
identified, not even anonymously**. There is no partner column, no session id,
no device id, no stable "other side of the pair" handle; a Tom↔Liz dinner and a
Tom↔stranger-at-a-counter exchange are the same shape of row, distinguishable
only by the language pair. `/live`, `/tabletop` and `/call` persist **nothing
at all** — not a row, not a transcript, not an audio file. Tutor is
single-account by construction (a learner and a machine). Net: today the app
holds **one** couple-attributable corpus (42 chat messages across 2 threads)
and **1,857** single-account translation turns whose partner is unknowable
from the data.

---

## Table by table

Fourteen tables in `public`. Every one has RLS **enabled**; the column that
matters is whether it has any *policies* (no policies = service-role only, a
deliberate pattern here, not an oversight).

### 1. `taos_lite_translations` — /translate saved history

| | |
|---|---|
| **Rows** | 1,857 (2026-08-18 → 2026-08-26), 8 distinct users |
| **Content** | `original_text` **and** `translation_text` in full — the verbatim utterance and its translation. Plus `source_lang`, `target_lang`, `tone`, `engine`. |
| **Audio** | None. Audio is transcribed in-flight by `/api/translate` and never stored. |
| **User ids** | `user_id` only, defaulted to `auth.uid()`. **One id per row.** |
| **Second party** | **Not identified — at all.** Not account-linked, not pseudonymous. The only trace of the other person is `target_lang`. |
| **Retention** | Forever, until the user deletes. No TTL, no expiry job. |
| **Deletion** | `taos_own_delete` (self), plus `clearHistory()` in the drawer. `ON DELETE CASCADE` from `auth.users`. |
| **RLS** | `taos_own_select` / `taos_own_insert` / `taos_own_delete`, all `auth.uid() = user_id`. No UPDATE policy — rows are immutable once written. Correct and tight. |

Written client-side by `saveTranslation()` (`lib/supabase.ts:47`) from
`components/TranslatorShell.tsx:792`, one row per completed turn. In auto-detect
mode the row records the *resolved* direction, so `source_lang` is who actually
spoke — which is the closest thing to a speaker identity in this table, and it
is a language, not a person.

### 2. `taos_lite_translations_bak_20260706` — orphaned archive ⚠️

| | |
|---|---|
| **Rows** | 2,081 (2026-06-16 → 2026-07-06), 5 distinct users |
| **Content** | A full column-for-column copy of the above, including both texts. |
| **Overlap with live** | **Zero.** Not one of the 2,081 rows exists in `taos_lite_translations` by id, and none matches by (user, text, timestamp) either. This is a standalone corpus of user utterances that the app cannot see and the owners cannot reach. |
| **Retention** | Indefinite. Nothing reads it, nothing writes it, nothing deletes it. |
| **RLS** | Enabled, **no policies** — invisible to `anon` and `authenticated`, readable only by the service role. No FK to `auth.users`, so **account deletion does not cascade here.** |

### 3. `taos_lite_translations_bak_20260825` — redundant snapshot ⚠️

| | |
|---|---|
| **Rows** | 1,718 (2026-08-18 → 2026-08-26 01:17) |
| **Overlap with live** | Total — all 1,718 are still present in `taos_lite_translations`. This is a snapshot taken the night before the tutor migration. |
| **Retention / RLS** | Same as above: indefinite, no policies, no FK, no cascade. |

Both backups are flagged in **Surprises** below. They are the single largest
gap between what the product promises and what the database does.

### 4. `taos_lite_chat_threads` — the couple container

| | |
|---|---|
| **Rows** | 2 |
| **Content** | `id`, optional `title`, `created_at`. No content. |
| **User ids** | None directly — membership is the join table. |
| **Retention** | Permanent. No user-facing delete; the only `DELETE` in the codebase is `app/api/chat/invite/route.ts:124`, rolling back a thread whose first member insert failed. Cascades away only when *both* members' accounts are gone (via members → thread? no — see below). |
| **RLS** | `members read their threads` (SELECT) via `taos_lite_is_chat_member(id)`. No INSERT/UPDATE/DELETE policies — thread creation is the invite route's job, with the service role. |

### 5. `taos_lite_chat_members` — **the one real "who speaks to whom" edge**

| | |
|---|---|
| **Rows** | 4 (2 threads × 2 people) |
| **Content** | `thread_id`, `user_id`, `lang`, `created_at`. |
| **User ids** | `user_id` → `auth.users`. PK is `(thread_id, user_id)`. |
| **Second party** | **Account-linked and explicit.** Given a thread, the partner is `members.find(m => m.user_id !== me)` — that is literally how `/api/chat/send:87` picks the translation target. |
| **Cap** | Two per thread, enforced by the `taos_lite_chat_members_cap` trigger (`SECURITY DEFINER`, `SELECT … FOR UPDATE` on the thread row so racing joins serialize). Many threads per person; two people per thread. |
| **Retention** | Permanent. `ON DELETE CASCADE` from `auth.users` — deleting an account removes that person's membership row. |
| **RLS** | `members read membership` (SELECT) only. No INSERT policy: joins go through `/api/chat/join` with the service role after the token checks out. |
| **Constraint** | `lang ~ '^[a-z]{2,3}$'` — a shape check, not a catalog copy (see `20260819_chat_members_lang_catalog.sql`). |

Current data (identifying only by role, not address):

| thread | created | members | langs | messages | senders | voice |
|---|---|---|---|---|---|---|
| `b38aa6a4…` "Tom & Liz" | 2026-07-18 | 2 | **`bs`**, `es` | 35 | 2 | 20 |
| `c60e7b0d…` (untitled) | 2026-08-19 | 2 | **`bs`**, `en` | 7 | 2 | 7 |

Tom's row reads `bs` (Bosnian) in the real couple thread — see **Surprises**.

### 6. `taos_lite_chat_messages` — the couple corpus

| | |
|---|---|
| **Rows** | 42 (35 + 7), 27 of them voice |
| **Content** | `body` (original, ≤4000 chars) **and** `body_translated`, plus `source_lang` / `target_lang`, `kind` (`text`\|`voice`), `read_at`, and `audio_path`. |
| **Audio** | `audio_path` points into the private `chat-voice` bucket. **27 message rows, 27 stored objects** — every voice note ever sent is still there. |
| **User ids** | `sender_id` → `auth.users`, plus `thread_id` which resolves to the pair. **Both ends of every utterance are knowable.** |
| **Retention** | **Permanent and undeletable by users.** There is no DELETE policy on this table and no route that deletes a message. Nothing expires. |
| **Deletion** | `sender_id` is `ON DELETE CASCADE` — see the asymmetry flagged below. |
| **RLS** | `members read messages` (SELECT, thread-scoped), `members send their own messages` (INSERT, `sender_id = auth.uid()` **and** membership), `members mark partner messages read` (UPDATE, membership **and** `sender_id <> auth.uid()` — you can only stamp *their* messages read, not your own). Genuinely well-shaped. |

Writes go through `/api/chat/send` and `/api/chat/voice` with the service role
(translation happens between the read and the insert). Reads are live over
Supabase Realtime `postgres_changes` on `taos-chat-<threadId>`, which is
RLS-filtered.

### 7. `taos_lite_chat_invites` — how the second person arrives

| | |
|---|---|
| **Rows** | 1 |
| **Content** | `token` (the only credential), `thread_id`, `created_by`, `expires_at`, `accepted_by`, `accepted_at`. |
| **User ids** | `created_by` (CASCADE) and `accepted_by` (**SET NULL**). |
| **Second party** | This table is where the pair is *formed* — `accepted_by` is the moment an anonymous "other side" becomes an account-linked partner. |
| **Retention** | Rows persist after acceptance; `/api/chat/invite` deletes prior invites for a thread before minting a new one. Single-use via a conditional `accepted_at` claim. |
| **RLS** | Enabled, **no policies**, deliberately (documented in the migration). A browser has no business listing tokens. |

### 8. `profiles` — account + billing

| | |
|---|---|
| **Rows** | 17 (= `auth.users`; created by the `handle_new_user` trigger) |
| **Content** | `email`, `plan`, `tier`, `subscription_status`, `stripe_customer_id`, `stripe_subscription_id`, `trial_ends_at`, `current_period_end`, `usage_chars`, `usage_period_start`, `bonus_seconds`, `bonus_period`. |
| **User ids** | `id` = `auth.users.id`. |
| **Second party** | None. No partner column, no household, no shared plan. |
| **Retention** | CASCADE from `auth.users`. |
| **RLS** | `profiles_own_select` only. All writes are the Stripe webhook / checkout routes with the service role — a user cannot edit their own tier. Correct. |

Distribution: 12 free/trialing, 2 basic active, 1 premium active, 1 comp, 1
canceled-with-Stripe-ids. No stale *test-mode* customer ids remain — every
`stripe_customer_id` present belongs to a live-mode row.

### 9. `tutor_sessions` — tutor minutes

| | |
|---|---|
| **Rows** | 15, **2 distinct users** (both founders) |
| **Content** | `mode`, `learn_lang`, `focus`, `level`, `model`, `seconds`, `started_at`, `ended_at`. **No transcript, no audio, no utterances.** |
| **User ids** | `user_id`, default `auth.uid()`. Single-account by nature. |
| **Retention** | Indefinite; CASCADE from `auth.users`. |
| **RLS** | own select/insert/update/delete, all `auth.uid() = user_id`. Note the roles are `{public}` rather than `{authenticated}` — harmless, since `auth.uid()` is null for `anon`, but inconsistent with the `taos_*` tables. |

**Written from the browser today** (`lib/supabase.ts:262`/`275`, called by
`components/TutorShell.tsx:608`), which is exactly the open phase-2 question in
`lib/tutor/meter.ts`: the duration currently comes from a number the client
chose to report. `getMonthlyUsage()` sums `seconds` from this table for the
quota meter.

### 10. `tutor_attempts` — pronunciation scoring

| | |
|---|---|
| **Rows** | 0 |
| **Content** | `target_phrase`, **`transcript`** (what the learner actually said), `course`, `lesson_id`, `target_lang`, five Azure scores, `word_scores` jsonb. |
| **User ids** | `user_id`, default `auth.uid()`. |
| **Second party** | None — learner and machine. |
| **Retention** | Indefinite; CASCADE from `auth.users`. |
| **RLS** | own select/insert/delete (`{authenticated}`). No UPDATE — attempts are immutable. |

Empty despite phase-1 verification runs, because the Crawl path scores through
Azure and writes only on the client paths in `TutorShell.tsx:348` /
`tutor/ModulesShell.tsx:495`. This will start holding learner speech
transcripts the moment the flag goes on.

### 11. `tutor_mastery` — dead table ⚠️

| | |
|---|---|
| **Rows** | 0 |
| **Referenced by code** | **Nowhere.** Zero call sites in the repo. |
| **Constraint** | `course_id = ANY (ARRAY['tom-spanish-1', 'liz-english-1'])` — a hardcoded two-course ceiling from a tutor design that no longer exists. The shipped curriculum is fourteen language-agnostic modules (`lib/tutor/modules.ts`). |
| **RLS** | Full own-row CRUD, roles `{public}`. |

Phase 1 keeps progress in `localStorage` (`TUTOR_PROGRESS_KEY`) and the backlog
lists "move progress off localStorage" as phase-2 work. This table is a
plausible-looking destination that would reject every real `course_id`.

### 12. `tutor_lessons` — generated course content

| | |
|---|---|
| **Rows** | 2 |
| **Content** | `cache_key` (`module:target:learner:v<promptVersion>`), the `lesson` jsonb, `model`. |
| **User ids** | **None, by design.** Course content, not history. |
| **Retention** | Indefinite; prompt-version bumps retire rows by key. |
| **RLS** | Enabled, no policies — service role only. |

The only table in the schema that holds no user-attributable data at all.

### 13. `taos_lite_predict_models` — /translate next-word models

| | |
|---|---|
| **Rows** | 2 |
| **Content** | A jsonb n-gram model **built from `taos_lite_translations`** (`/api/predict/rebuild`), plus `row_count`, `token_count`, `built_at`. |
| **User ids** | None. |
| **Second party** | None — but note this is **derived from everyone's history, pooled**, and keyed only by direction. |
| **Constraint** | `direction = ANY (ARRAY['en-es','es-en'])` — another two-language ceiling in the database, from before the 100-language catalog. |
| **RLS** | Enabled, no policies — service role only. |

### 14. `taos_leads` — dead lead capture ⚠️

| | |
|---|---|
| **Rows** | 1 |
| **Content** | `email`, `source` (default `'atom'`), `created_at`. |
| **Referenced by code** | **Nowhere** in this repo. |
| **RLS** | `taos_leads_anon_insert` — `INSERT` for `{anon, authenticated}` with `WITH CHECK (true)`. No SELECT policy. |

---

## Storage buckets

| bucket | public | objects | written by | deleted by |
|---|---|---|---|---|
| `chat-voice` | no | **27** | `/api/chat/voice` → `<thread_id>/<uuid>.<ext>` | only the rollback path on a failed message insert |
| `video-uploads` | no | 0 | `/api/video/upload-url` (founders-only `/video`) | `/api/video/process` removes the object on every outcome — transport only |

`storage.objects` policy `chat members read voice notes`: SELECT for
`{authenticated}` where `bucket_id = 'chat-voice'` and
`taos_lite_is_chat_member((split_part(name,'/',1))::uuid)` — the thread id is
the first path segment, so membership gates the audio the same way it gates the
text. There is **no DELETE policy and no cleanup path**: voice notes outlive
everything, including the account that sent them.

---

## Surfaces that persist nothing

Verified by grep across `components/` and `lib/` — these shells contain no
`supabase` import, no `localStorage`, and no `.from(...)`:

- **`/live`** (ambient interpreter) — `/api/live/realtime` mints an ephemeral
  OpenAI client secret and returns. Audio goes browser↔OpenAI over WebRTC.
  Nothing touches Postgres. No row, no transcript.
- **`/tabletop`** (push-to-talk, face to face) — same shape. Two people, one
  device, zero rows. The second person is not merely unidentified; the session
  leaves no trace that it happened.
- **`/call`** (dormant, founders-only) — WebRTC between two phones. Signalling
  rides Supabase Realtime **broadcast** on `taos-call-<room>`
  (`lib/call/session.ts:333`), which is ephemeral by definition: broadcast
  messages are relayed, not stored. Note the pairing key is a typed **room
  code**, not an account link — `/call` has no idea who the two parties are.
- **`/vision`** (photo translate) — the image is downscaled client-side, POSTed
  as base64 to `/api/vision`, forwarded to OpenAI, and the result returned. The
  photo is never written to Postgres or to a bucket.
- **`/try`** (anonymous allowance) — no persistence; the allowance is the
  in-memory spend guard (`lib/spendGuard.ts`), not a table.

Client-only state, on the device and never synced: `TUTOR_PROGRESS_KEY` (tutor
progress), `PAIR_STORAGE_KEY` / `RECENT_STORAGE_KEY` (language pair), `STORAGE_KEY`
(Atom), `CHAT_READ_HINT_KEY`, `DISMISSED_KEY`.

---

## Retention and deletion, at a glance

| data | kept until | user can delete? | survives account deletion? |
|---|---|---|---|
| translate history | deleted by user | **yes** (per-row + clear all) | no (CASCADE) |
| translate backups (2 tables) | forever | **no — unreachable** | **yes** ⚠️ |
| chat messages (text + translation) | forever | **no** | **only the other person's half** ⚠️ |
| chat voice audio | forever | **no** | **yes — orphaned in the bucket** ⚠️ |
| chat threads / memberships | forever | no | membership: no. thread: yes |
| chat invites | until superseded | no | `accepted_by` → NULL, row stays |
| tutor sessions / attempts | forever | via RLS delete (no UI) | no (CASCADE) |
| tutor lessons | forever | n/a (no user data) | n/a |
| predict models | until rebuilt | no | **yes — derived from pooled history** |
| profiles | forever | no | no (CASCADE) |
| `/live`, `/tabletop`, `/call`, `/vision` | **nothing is kept** | n/a | n/a |

---

## Reflections implications

### What is couple-attributable today

**Only `/chat`.** The `thread_id` → two `user_id`s → `sender_id` chain is a
complete, account-linked, both-sides-identified conversational corpus, with
per-message language direction, read receipts, and voice audio. It is the only
data in this system a Reflections analysis could honestly be built on. Its
scale today is 42 messages across 2 threads — one of which is the real Tom/Liz
thread (35 messages, 20 voice notes, since 2026-07-18).

This matters for the plan's premise. The Reflections doc says couples "feed
their ENTIRE relationship through TAOS… the fights and the repairs after
them." The corpus that actually carries a *dialogue* is chat's 42 messages; the
1,857-row translate history is ten times larger but is **half a conversation**
— one person's utterances, with the reply either absent (spoken back through
the other direction as a separate, unlinked row) or never captured. Any
Reflections v1 that reads translate history is reading a monologue and
inferring the other voice. Worth deciding deliberately rather than discovering
at prompt-writing time.

### What is single-account only

`/translate` (partner unknowable), `/live`, `/tabletop`, `/call`, `/vision`
(nothing persisted at all), tutor (learner and machine by construction),
`profiles` (no household concept). Turning any of these into couple data is not
a query — it is a **new capture path**, which is precisely the kind of quiet
widening the constitution's principle 3 forbids without its own consent moment.

### Where the partner link would attach

There is no `couples` table, no `partner_id` column, and nothing anywhere that
pairs two accounts outside of chat membership. That is the correct starting
position, and phase 1 of the plan ("consent + ritual UX + data plumbing")
should keep it: the link should be a **new table created at dual opt-in**, not
a column bolted onto `profiles` (a nullable `partner_id` on `profiles` is a
shadow couple-graph the moment one side sets it, and principle 2 is "both
partners, or nothing").

The shape the existing schema suggests:

- A `reflections_consents` row per (couple, user) — the opt-in is per person
  and revocable, so it cannot be a single row with two ids and one timestamp.
  The couple exists only when *both* rows are present and unrevoked.
- The natural seed is `taos_lite_chat_members`: two accounts already sharing a
  `thread_id`, with the invite in `taos_lite_chat_invites` as the auditable
  record of how they met. It is a candidate for the *offer* ("you two share a
  chat — want to try Reflections together?"), **not** a couple link on its own.
  Sharing a thread is not consent.
- Derived analyses need per-couple encryption (principle 3) and must cascade on
  revocation — which means a FK to the consent record, not to `auth.users`.
- Scope must be explicit: which threads, which window. Principle 6 says derive,
  present, discard by default, so the durable artifact is the consent record
  and the scope, not the reflection.

Three existing behaviors will complicate "delete means delete — raw *and*
derived" and should be fixed before, not after, Reflections plumbing lands:
the two backup tables, the asymmetric chat cascade, and the orphaned voice
audio (all below).

---

## Surprises, flagged

1. **Two full copies of translation history sit outside every delete path.**
   `taos_lite_translations_bak_20260706` (2,081 rows, 5 users, June–July, with
   **zero** overlap with the live table) and `taos_lite_translations_bak_20260825`
   (1,718 rows, a duplicate of the current window). Both hold `original_text`
   and `translation_text` in full. Neither has an FK to `auth.users`, so
   **deleting an account does not remove them**; neither is reachable by
   `clearHistory()`; neither is readable by the user whose words they are. The
   `bak_20260706` set is the sharper case — that content is gone from the live
   table, so a user who cleared their history would reasonably believe it no
   longer exists. This is the single biggest gap between the Reflections
   promise ("delete means delete — raw *and* derived") and the current
   database. Recommend deciding their fate (drop, or move to a documented,
   time-boxed archive) before Reflections work starts.

2. **Chat deletion is asymmetric.** `taos_lite_chat_messages.sender_id` is
   `ON DELETE CASCADE`. Delete one partner's account and *their* messages
   vanish while the other's remain — leaving half a dialogue, out of context,
   permanently readable by the survivor. Combined with the fact that **no one
   can delete a chat message at all** (no DELETE policy, no route), the couple
   corpus is currently write-once-keep-forever with a deletion mode that
   damages rather than removes. For a feature whose second principle is "either
   partner can revoke at any time," this is the semantics to settle first.

3. **Voice audio outlives everything.** 27 objects in `chat-voice`, no DELETE
   policy, no cleanup path except the failed-insert rollback. If a sender's
   account is deleted the message row cascades away and the audio file stays —
   an orphan with no row pointing at it and no owner to ask for its removal.

4. **Tom's chat language is set to `bs` (Bosnian).** In *both* threads,
   including the real Tom & Liz thread. Liz's side is `es`, so
   `/api/chat/send` is translating her Spanish into Bosnian for Tom, and Tom's
   own `source_lang` is recorded as `bs` on 35 messages. Almost certainly a
   stray tap during the 100-language catalog testing that was never set back.
   Field-visible today, and it also means the historical `source_lang` /
   `target_lang` on that thread misstate what language was actually spoken —
   which matters if Reflections ever reads those columns. **Not changed by this
   audit** (read-only); worth one tap on `/chat` to fix.

5. **`tutor_mastery` is a dead table with a stale two-course ceiling.** Zero
   rows, zero code references, and
   `check (course_id in ('tom-spanish-1','liz-english-1'))` — it would reject
   every module id the shipped curriculum produces. It looks exactly like the
   right home for the phase-2 "move progress off localStorage" work, and it
   would fail on first insert. Same failure mode as the `lang` CHECK that
   `20260819_chat_members_lang_catalog.sql` cleaned up.

6. **`taos_lite_predict_models` still carries `direction in ('en-es','es-en')`.**
   A third language ceiling living in Postgres. Not currently breaking anything
   — `/api/predict/rebuild` only builds those two — but it is the same species
   of bug as #5, and it means the predict feature silently cannot follow the
   catalog. Also worth noting for privacy: this model is **derived from every
   user's translation history, pooled**, and does not cascade on account
   deletion.

7. **`taos_leads` accepts inserts from anyone.** `INSERT` for `{anon,
   authenticated}` with `WITH CHECK (true)`, no SELECT policy, one row, no code
   in this repo writes it (the `source` default is `'atom'` — a different app).
   The publishable key is in every browser bundle by design, so this is a
   world-writable table. Low stakes as a table of emails; still an open write
   endpoint that nothing owns.

8. **Most of the schema is not in `supabase/migrations/`.** Four files cover
   `taos_lite_chat_invites`, the members index, the `lang` CHECK, and
   `tutor_lessons`. The other ten tables — including every one holding user
   content — exist only in the database. There is no way to recreate this
   project from the repo, and no review trail for the policies on the tables
   that matter most.

9. **Three `SECURITY DEFINER` functions are callable over the REST API**
   (`handle_new_user`, `taos_lite_chat_members_cap`, `taos_lite_is_chat_member`),
   flagged WARN by the Supabase linter. The first two are trigger functions
   that will error out if invoked directly, and `taos_lite_is_chat_member`
   leaks nothing (it answers about `auth.uid()`, so `anon` gets `false`). Low
   severity — noted for completeness, since a Reflections audit is a reasonable
   moment to revoke EXECUTE. Leaked-password protection is also off in Auth.

10. **The `{public}` vs `{authenticated}` policy-role split.** The tutor tables
    grant to `{public}` while the `taos_*` tables grant to `{authenticated}`.
    Functionally identical here (every policy tests `auth.uid()`), but it means
    the two halves of this schema were written by different hands at different
    times, and a future policy written by copy-paste could inherit the looser
    role without the `auth.uid()` test that saves it.

---

*Related: `docs/reflections-plan.md` (the constitution these findings serve),
`docs/tutor-curriculum-plan.md`, `docs/group-chat-plan.md` — note that group
chat, when it lands, changes the "two members per thread" invariant this map
depends on.*
