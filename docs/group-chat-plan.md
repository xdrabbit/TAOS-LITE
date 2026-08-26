# Group Chat — Trip-Critical Post-RC1

*Agreed Tom + Claude, 2026-08-19. Not RC1. Target: before Spencer's
Bosnia/Italy trip (date TBD — Tom to supply; that date is the real deadline).*

## The product

One thread, N people, each member reads the ENTIRE conversation in their own
language. Seven couples on a boat, six languages, zero friction.

This is TAOS's killer demo and the QR growth engine: "scan to join the boat
chat."

## Why it's not a cap increase

/chat is 1:1 in more places than the member count. Each of these is a separate
piece of work, and the first two are the real ones.

- **The singular partner is assumed throughout.** `lib/chat.ts` resolves "the
  one other member"; `lib/chatLabels.ts` renders `They read: ${name}` (line
  111) and the recipient "THEY SEE" preview. A roster of six has no "they."
- **A message row holds exactly one translation.** `/api/chat/send` picks
  `targetLang = partner?.lang` and writes `body_translated` + `target_lang` as
  two columns on the message. Group needs a translation PER distinct member
  language, which is a new table, not a wider column.
- **Send is synchronous with the translation.** One partner means one model
  call inline. Six languages inline means the sender watches a spinner for all
  six, and one provider hiccup stalls the send.
- **The two-member cap is a DB trigger**, not app logic — `/api/chat/join`
  catches its failure and returns `CHAT_JOIN_FULL`. It cannot be read from the
  TypeScript, so raising it is a migration. (Same lesson as the stale `en|es`
  CHECK constraint: query `pg_constraint` first, don't trust a source read.)
- **Invites are single-use.** `/api/chat/join` claims the token with a
  conditional `UPDATE ... WHERE accepted_at IS NULL` and 410s on a spent one.
  Group needs thread-scoped, multi-use tokens instead.
- **UI shape changes**: roster header instead of "They read: Español";
  per-message "who sees what" collapses to the viewer's own rendering
  (already the model — this part is nearly free); joined/left system lines.

Related: per-seat languages at /tabletop is the same shape — a language per
participant and a translation per listener. Design once; apply to both if
practical.

## Phase plan

In order. Each is a future dispatch.

1. **Schema.** Member cap becomes configurable (drop/replace the trigger);
   thread-scoped multi-use invite tokens; `message_translations` table keyed
   `(message_id, lang)`, cached.
2. **Fan-out translation service.** On send, resolve the set of DISTINCT
   member languages, translate once per language (not once per member), cache
   the rows; each viewer reads their own language's row. Async, so send isn't
   blocked on six calls. Tier-2 languages stay text-only per the existing
   catalog rules.
3. **UI.** Roster header, group invite QR, joined/left lines, viewer-language
   rendering, thread-list integration (the /chat list from the multi-thread
   work).
4. **Cost guards.** Per-thread member limit (start ~16), per-message
   translation budget, rate limits. Cost per message scales with distinct
   languages, so this is a real ceiling, not a formality.
5. **Verification bar.** A real multi-account thread, 3+ languages, transcript
   read both directions, RLS checked — the same standard the 1:1 invite flow
   was held to. The ask-first rule for live data applies.

---

*On the arc:* group chat is **Connect**, the second step of Translate →
Connect → Learn → Understand. See `docs/tutor-curriculum-plan.md` (Learn) and
`docs/reflections-plan.md` (Understand) for what follows it.
