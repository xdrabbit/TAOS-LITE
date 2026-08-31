# Enhancements · TAOS-LITE

The living backlog. **Tom or Liz**: think of something you want? Open this file
on GitHub (phone works great: repo → ENHANCEMENTS.md → ✏️ → commit to main)
and add a line under **Ideas**. That's it — no ceremony, no perfect wording.

**Agents**: read this file at the start of any build session (CLAUDE.md makes
this automatic). When the user asks "what's next" or finishes a task with time
to spare, propose from **Up next**. When you ship an item, move it to
**Shipped** with the date and PR number. When the user voices a future want
mid-session, add it here. Never delete or reword Tom/Liz's entries — append.

Entry format (loose): `- What it is — why / any detail. (added YYYY-MM-DD)`

---

## Up next (roughly prioritized)

- **Resolve founder-ness on the server, not from the client bundle** — every
  founders gate in the app (`/fast`, `/call`, `/video`) ends at
  `isFounder(email)` in `lib/release.ts`, and that function reads
  `NEXT_PUBLIC_FOUNDER_EMAILS` plus two hardcoded addresses. `NEXT_PUBLIC_`
  means **the founder list is compiled into the JavaScript every visitor
  downloads** — `grep` the deployed bundle and it is right there. Nothing is
  *breached* by that: the routes re-ask the question against a server-validated
  token, so knowing the list does not let anybody use it, and the addresses are
  on the About page anyway. It is still the kind of thing that reads badly in a
  security review and gets worse the moment a non-founder address is added to
  the list. Pre-existing, not introduced by the /fast work (PR #51 flagged it
  rather than fixing it, because changing how founder-ness resolves touches the
  nav, three page gates and four routes at once). Wants: a server-only
  `FOUNDER_EMAILS`, a small `/api/me` capability answer for the nav to render
  from, and the `NEXT_PUBLIC_` copy kept only for what the browser genuinely
  cannot ask. (added 2026-08-31)

- **Create the Azure Translator resource, then walk /fast on a phone** — two
  halves of one sitting. `/fast` shipped founders-only on 8/30 (PR #46) and is
  running on its FALLBACK engine, because Azure Translator is a different
  Azure resource kind from the Speech one the tutor uses and nobody has made
  it yet. Portal steps, tier (F0 free, 2M chars/month), region and the
  `vercel env add` commands are in `docs/fast-engine.md`; the screen switches
  engines by itself and the badge at the bottom changes from "literal AI" to
  "Azure Translator", which is how to confirm it took. One rig command in that
  doc then fills in its only unmeasured row.
  The other half is the judgement call the founders gate exists for: `/fast`
  says "cuesta un brazo y una pierna" where `/translate` would say "cuesta un
  ojo de la cara", **on purpose**. Does that read as a second tool, or as a
  bug? Nobody has typed into it on a phone yet — it was verified against the
  real route and in headless Chrome, which is the same gap the Crawl scoring
  had. Answer that before `NEXT_PUBLIC_ENABLE_FAST=1`. (added 2026-08-30)
  The same sitting now has a third thing in it: the mic shipped on 8/30 (PR
  #49) and has been walked only in headless Chrome with a fake microphone.
  Hold it, say a quickie, and see whether the transcript that lands in the box
  is one you would rather fix than retype. (added 2026-08-30)
  And a fourth, from the same PR: the mic now **streams** — the words should
  appear while you are still saying them, not in one lump on release. On a
  phone, on cellular, that is a latency claim nobody has tested; it was
  measured on a laptop over wifi. Say a long sentence and watch whether the
  dimmed tail keeps up with your mouth or trails it. (added 2026-08-30)

- The header slides sideways on every phone — measured 2026-08-30 while
  swapping the menu icon (PR #TBD): the signed-in header's content is 406 px
  wide at 390, 360 and 320 px viewports, so `document.scrollWidth` exceeds the
  viewport and the whole page can be dragged horizontally. Pre-existing, not
  new. `Live` + `Together ▾` + `Translate` + share + the More button no longer
  fit, which is the same overflow the Together menu was created to fix on
  8/19 — it has simply grown back. Options, cheapest first: fold `Translate`
  into the More menu (it is a screen, and the menu already holds screens);
  drop the header to icons-only below ~380 px; or let the row wrap. Worth
  doing before the wave, since it is a worse first impression than the X was.
  (added 2026-08-30)

- Chat delete, one real tap — the hygiene pass (PR #37) shipped
  "either partner can burn the chat" and proved the semantics against the
  live schema in a rolled-back transaction, but nobody has yet tapped Delete
  on a real thread on a real phone. Make a throwaway chat from the Start
  button, send one voice note into it, delete it, and confirm the row is gone
  from the list AND the audio is gone from the bucket (`GET
  /api/chat/voice/orphans` should still say 0). **Do not test on the Tom &
  Liz thread** — it is 35 messages and 20 voice notes, and there is no undo.
  (added 2026-08-26)
- Run the orphan sweep after any account deletion — Postgres cannot delete
  from a storage bucket (Supabase blocks it outright), so deleting an account
  in the Supabase dashboard removes its chat threads and rows but leaves the
  voice audio behind. `POST /api/chat/voice/orphans` is the cleanup, and it
  is founders-only. This is a manual step until there is a "delete my
  account" flow to hang it on. (added 2026-08-26)

- Walk one Crawl module with a real mouth — every pronunciation number behind
  the new "close enough" bar (PR #38) came from text-to-speech, which has no
  hesitation and scores high on fluency, so a person's takes will land LOWER
  than the 76-92 the synthetic ones did. Liz saying five phrases on a preview
  answers whether 60 is the right bar or whether it wants to be 50. Same
  session also covers the other gap: nobody has tapped Crawl on a phone since
  the assess route started returning a score at all. (added 2026-08-27)

- First-release scope cut — Tom (8/16): "we need to look seriously about what
  we can take off for a first release. Liz and I are ready to hook up the bank
  to Stripe." Decide which screens are in v1, hide the rest, and do the Stripe
  go-live checklist (live keys, webhook, price, paywall copy). Call cost
  guards (below) should land before real customers can rack up realtime
  minutes. (added 2026-08-16)
  → Screen cut SHIPPED 2026-08-18 (see Shipped): customers see Translate,
  Live, Chat, Photo; Call/Tabletop/Video are founders-only. STILL TO
  DO before charging: Stripe live keys + live price ids + production webhook
  (Tom's dashboard work), one real end-to-end purchase, and ideally the call
  cost guards. → The call cost guards landed 2026-08-27 (PR #39); Stripe went
  live 8/22 and the money path was certified 8/23, so this entry is closed
  except for the note that /call stays founders-only and is not what anyone is
  being charged for.
  → Tabletop un-cut 2026-08-19 (see Shipped): Tom walked RC1 on the Droid and
  could not reach Table at all. It is customer-facing now; Call and Video stay
  founders-only.
  → Tutor pulled from RC1 2026-08-18 (second cut): it is unfinished and is
  planned as a PREMIUM feature, so it is gated behind
  NEXT_PUBLIC_ENABLE_TUTOR (lib/release.ts), off by default. Hidden from
  everyone including founders — nav link gone, /tutor redirects to /, and
  all three /api/tutor routes 404 so a disabled feature cannot bill OpenAI
  realtime or Azure. Nothing was deleted; set the var to 1 and redeploy to
  bring it back.
  → Curriculum plan for bringing it back: `docs/tutor-curriculum-plan.md`
  (14 language-agnostic intent modules, crawl/walk/run loop, engineering
  order — cost guards land before customers). (added 2026-08-19)
  → PHASE 1 built 2026-08-25, PR #35, open for Tom — steps 1-3 of the plan
  plus Conversation Partner and the catalog wiring step 4 asked for. The
  fourteen modules are data (`lib/tutor/modules.ts`), lessons generate per
  (module × target × learner) with the contrast hook and are cached so repeat
  visits are free, and crawl/walk/run runs against real Azure and real
  realtime. **The flag stays off** — phase 2 is the plan-minute metering, and
  the hook points for it are already emitted (`lib/tutor/meter.ts`: a start
  line at mint, an end line at hang-up, one session id tying them). Run log
  and transcripts: `docs/tutor-phase1-verification.md`. What phase 2 owes:
  debit the minutes in those two functions, move `checkTutorAllowance` behind
  them, decide whether `tutor_sessions` is written server-side, and put
  progress somewhere better than localStorage.
  → PHASE 1 MERGED to main 2026-08-26 (PR #35). **The flag is still OFF in
  Production** — verified after deploy that /tutor 307s to / and all four
  /api/tutor routes 404 on taoslite.com, so customers see zero change. The
  Azure pronunciation leg that phase 1 could not run locally (its key is
  SENSITIVE in Vercel) was closed by Tom on the branch preview, so crawl
  scoring is confirmed end-to-end against real Azure. **Phase 2 is the
  metering** and is the only thing standing between this and the flag going
  on: debit minutes in `startTutorSession`/`endTutorSession`
  (`lib/tutor/meter.ts`), move `checkTutorAllowance` behind them, decide
  whether `tutor_sessions` is written server-side, and move progress off
  localStorage.
  → Known state, deliberate: `NEXT_PUBLIC_ENABLE_TUTOR=1` is set in Vercel on
  the **Preview** environment with no git-branch scope, so EVERY branch
  preview shows tutor, not just the tutor branch. That is what founders want
  while phase 2 is built (preview = the place to exercise it), and it is safe
  because the var is absent from Production. Delete it from Preview, or re-add
  it with `--git-branch`, when tutor should stop appearing on unrelated
  preview builds. (noted 2026-08-26)
  → PHASE 2 BUILT 2026-08-28 (see Shipped) — the metering. Minutes are
  server-authoritative and reserved at mint, plan-then-pack, founders bypass,
  and pack purchases credit a PERSISTENT balance through a replay-safe
  webhook. `tutor_mastery` is dropped rather than reused. **Tutor is now one
  environment variable from public**: the flip checklist is in the PR body and
  in Shipped below, and flipping it stays Tom's ceremony, not a merge.
- /live "On-device" mode: find out why it never works, or delete it — Tom
  (8/18): it has never once worked for him. Gated off for RC1 behind
  NEXT_PUBLIC_ENABLE_ONDEVICE_STT (lib/release.ts), so /live now has one
  engine and no toggle; Ambient AI was already the default and does the same
  job over WebRTC. Nothing was removed — the recognizer, its watchdog,
  lib/languages/recognition.ts and /api/live-translate are all still there,
  and `NEXT_PUBLIC_ENABLE_ONDEVICE_STT=1` brings the toggle back for testing.
  Post-RC, in this order:
  1. **Availability detection.** The screen decides support by looking for
     `window.SpeechRecognition ?? window.webkitSpeechRecognition`. Safari
     defines `webkitSpeechRecognition` and then fails at `start()` or returns
     nothing, so the constructor's presence is not an answer — find out what
     is (a permissions query? a timed first-result probe?).
  2. **PWA standalone.** Test from the home-screen icon, not just the
     browser: installed standalone is where Tom actually uses the app, and
     several WebKit bugs make recognition behave differently there.
  3. **Silent-failure UX.** Today a dead recognizer looks exactly like a
     working app that hears nothing — tap START, no error, no feed. Whatever
     the verdict on (1) and (2), the mode must say out loud when it isn't
     hearing anything, and offer the Ambient AI switch itself.
  If the answer is "iOS will never do this reliably", that is a fine answer —
  take the mode out properly rather than leaving a flag off forever.
  (added 2026-08-18)
- ⚠️ The pricing page still sells tutor minutes — BLOCKS charging anyone.
  Landing.tsx and Paywall.tsx advertise "15 / 45 / 200 tutor minutes /
  month" on every plan, lib/stripe.ts sells add-on minute packs, and
  layout.tsx's site title and description say "AI language tutor". With
  tutor gated off, all of that sells something the app will not do. Pick one
  before the first real charge: rewrite the plans around translation limits,
  or turn tutor back on for paying tiers only. This was the exact reason
  tutor was kept in v1 on 8/18 (tests/release.test.ts said so), so pulling
  it reopened the question rather than settling it. (added 2026-08-18)
  → Answered a third way for v1.0.0 (see Shipped): the line items stay and
  get labelled from the same flag that hides the screen. The plans are still
  priced around tutor, so this unblocks charging **for translation** — the
  question of whether the prices themselves are right once tutor returns is
  still Tom's to make. (2026-08-19)
  → Fully answered 2026-08-28 by tutor phase 2: the minutes the page sells are
  real now, metered against the exact numbers printed on it (a test reads
  Paywall.tsx and fails if 45/200 and the enforced allowance ever disagree).
  The one line that was actively FALSE — "Packs add minutes for the rest of
  this month" — is fixed: packs credit a persistent balance that rolls over
  and never expires, while plan minutes reset monthly, and both halves of that
  are now said on the page before the charge. (2026-08-28)
- Chat push notifications (tier 2) — phones buzz when a message lands while
  the app is closed. Planned since chat tier 1 shipped. (added 2026-08-03)
- Call cost guards — SHIPPED 2026-08-27 (PR #39, see Shipped). /call is
  founders-only again, catalog-wired, and its per-minute cost is measured
  rather than guessed: ~$0.123/min → **~$0.058/min** for a two-phone call,
  with the numbers and the method in docs/realtime-cost-model.md.
  (added 2026-08-03, from the July 14/22 OpenAI bill spikes)
  → Still open, and deliberately: /call has never been walked on two real
  phones on two real networks. Everything below the transport was verified
  without them (two browser tabs for the peer-to-peer leg and the language
  handshake, a live realtime session for the interpreting), but the things
  that need a trip are the things a trip is for — carrier NAT, whether TURN
  turns out to be needed, and whether the ~1s the cloned voice costs is worth
  paying. The "⚡ Fastest" toggle on the lobby screen exists so Tom can answer
  that last one on a real call without a deploy.
  → **Walked 2026-08-31, and it did not connect.** Tom and Liz, two real
  phones: the call initiated and never came up. TURN was needed — see
  "the /call relay" in Shipped. The two questions still open are the ones
  that need the phones back: the three-row network matrix (same wifi /
  mixed / both cellular), and the cloned-voice latency.

- Cantonese field verdict — have the Cantonese-speaking guest judge the v3
  voice and the zh⇄yue auto-detection; swap ELEVENLABS_YUE_MODEL or tune the
  detect prompt based on her review. (added 2026-08-03)
- Reflections — the couples superglue, and the step after tutor on the arc
  (Translate → Connect → Learn → **Understand**). Couples who don't share a
  language run their whole relationship through TAOS; Reflections reflects
  that history back to them, reframed with warmth — never a verdict on who
  was right. Tom and Liz have already prototyped it by hand on their own
  transcripts. Sequenced AFTER tutor phase 2 meters and after group chat
  ships for the trip. Design constitution, consent model and safety rails:
  `docs/reflections-plan.md` — read it before any code, the guardrails are
  the product. (added 2026-08-25)

## Ideas

- The context cap belongs on the other three realtime screens too — found
  while costing /call (PR #39, docs/realtime-cost-model.md). Every Realtime
  response re-reads the whole session, as audio, at $32/Mtok; measured on a
  live session, an uncapped one billed **209% of the audio actually spoken and
  was still climbing turn over turn**, against 66% and flat with
  `truncation: { type: "retention_ratio", token_limits: { post_instructions:
  100 } }`. /call has that cap now; `/api/live/realtime`,
  `/api/tabletop/realtime` and `/api/tutor/realtime` do not, and none of them
  was written knowing this was happening.
  /live is the one to look at first: it speaks AUDIO (the expensive
  modality) and an ambient session is meant to run for a long time, which is
  exactly the shape that pays for its first minute over and over. The right
  cap is not necessarily 100 for all three — /tutor is a CONVERSATION and
  genuinely wants history, so it needs its own number rather than this one
  copied. Worth measuring each the same way before changing any of them.
  (added 2026-08-27)
  → SHIPPED for /live and /tabletop 2026-08-28 (see Shipped). "Worth measuring
  each the same way" turned out to be the whole job: the guess that 100 would
  do everywhere was wrong in both directions. /live needs **150** (at 100 it
  repeated a summary verbatim, having lost the audio it was meant to be
  summarising — it coalesces, so it holds more than one segment at a time);
  /tabletop is fine at **100** and breaks at 75 (it invented a sentence). The
  exposure was far worse than /call's 209%: **/live billed 460% of the audio
  spoken and /tabletop 400%**, both still climbing. /tutor is deliberately
  untouched, exactly as this entry said it should be.


- Data-map follow-ups (from the read-only audit, `docs/data-map.md`,
  2026-08-26) — Reflections groundwork turned up four things worth deciding
  before any couple-data plumbing lands. (1) Two backup tables,
  `taos_lite_translations_bak_20260706` (2,081 rows, **zero** overlap with the
  live table) and `_bak_20260825` (1,718 rows), hold full `original_text` /
  `translation_text` with no FK to `auth.users` — so they survive account
  deletion, are unreachable by "clear history", and are unreadable by the
  people whose words they are. That is the sharpest edge against Reflections'
  "delete means delete — raw *and* derived". (2) `taos_lite_chat_messages`
  cascades on `sender_id`, so deleting one partner's account leaves the other
  half of the dialogue in place — and nobody can delete a chat message at all
  (no DELETE policy, no route). Revocation semantics need settling. (3) Voice
  audio in `chat-voice` (27 objects) has no delete path and orphans on account
  deletion. (4) `tutor_mastery` is dead (0 rows, no code refs) with a stale
  `course_id in ('tom-spanish-1','liz-english-1')` CHECK — it looks like the
  right home for phase 2's "progress off localStorage" and would reject every
  real module id. **Dropped 2026-08-28** in
  `supabase/migrations/20260828_tutor_metering.sql` with the reasoning in the
  migration: progress is NOT landing in phase 2, so the honest move was to
  remove the trap rather than rebuild a table nothing is ready to use. When
  server-side progress does land it wants a table keyed the way
  `lib/tutor/progress.ts` is keyed — module × target × learner — which is not
  what this was. Also noted: `taos_lite_predict_models` still carries
  `direction in ('en-es','es-en')`, and ten of the fourteen tables exist only
  in the database, not in `supabase/migrations/`. (added 2026-08-26)
- /chat: Tom's member language reads `bs` (Bosnian) in BOTH threads, including
  the real Tom & Liz one — so Liz's Spanish is being translated into Bosnian
  for him, and 35 messages have `source_lang = 'bs'` recorded. Almost certainly
  a stray tap from the 100-language catalog testing. One tap on /chat fixes it
  going forward; the historical rows would stay wrong. Left alone deliberately
  by the read-only audit. (added 2026-08-26)
- /chat should translate on what you WROTE, not on what you read — the send
  and voice routes take the sender's own member language as the source
  (`sourceLang = me.lang`) and feed it to the prompt as "the sender usually
  writes X". In practice the model translates whatever actually arrives — a
  Polish message in an en→es thread still comes out Spanish (verified 8/19) —
  so the hint is harmless. The GATE is not: `targetLang === sourceLang` skips
  translation altogether, so if both members read the same language, a message
  typed in a third one is delivered raw. Real detection (the JSON
  `source_lang` + `translation` shape /api/translate already uses — see the
  field-name warning in lib/translate/prompts.ts) would fix both, make the
  stored `source_lang` true, and let the composer line name the language it
  detected instead of "anything you write". Note the one thing the current
  behavior gets right by accident: `source_lang` = the sender's own language
  is what makes the cloned voice follow the SPEAKER, so a detector must not be
  wired straight into the voice choice. (added 2026-08-19)
- Real app icon — the home-screen icon shipped with trip mode is a generated
  placeholder (an amber speech bubble; scripts/gen-icons.mjs redraws every
  size). Swap in real art before the app store push or any wide launch.
  (added 2026-08-17)
- Bosnian voice check on the trip — Bosnian text synthesizes fine, but
  ElevenLabs has no Bosnian in its multilingual models; it renders the text
  with Croatian/Serbian pronunciation, which should pass but has never been
  heard by anyone who speaks it. First local who reacts to the voice is the
  verdict — same kind of field check as the Cantonese one above. (added
  2026-08-17)
- Expand histories to the other features — Tom (8/16): "can we think about
  expanding histories to the other features. I know that's big and will likely
  require some database work." Today only /translate saves history. Sketch:
  one shared `feature_history` table (user, feature, payload jsonb, created_at)
  in Supabase with RLS per user; /live, /call, /chat (already stored), /video,
  /vision each append their turns/results; HistoryDrawer grows a feature
  filter. Decide retention (photos/audio are big — store text only). (added
  2026-08-16)
- Tutor hyperlink study words for more instruction. 
  - Preserve the lesson flow: only vocabulary or deliberately teachable words
    should look interactive, rather than turning every sentence into a field of
    blue links.
  - Tapping a study word should open an in-app word-study sheet or route, not
    send the learner to a random external grammar page.
  - The explanation should be generated from structured lesson metadata where
    possible and may use an LLM for clear learner-specific teaching.
  - Example for Spanish `quiero`: show the dictionary form `querer`, the meaning
    in this sentence, speaker/person (`yo`), present-tense form, a compact set of
    useful contrasts (`quieres`, `quiere`, `queremos`), negative/question forms,
    pronunciation playback, and two or three examples drawn from current and
    earlier lessons.
  - Example for English `want`: show base form, present forms (`I/you/we/they
    want`, `he/she wants`), negative and question patterns (`don't want`, `Do
    you want...?`), pronunciation, and examples explained in Spanish for Liz.
  - The detail surface should offer a small substitution or recall exercise so
    deeper study remains active learning rather than a dictionary detour.
  - Track taps as a learner signal. Repeatedly opened words may be confusing or
    important and can later influence review or teacher explanation.
  - Course content should explicitly mark `studyWords` or vocabulary tokens;
    do not infer links from raw string matching alone because punctuation,
    conjugation, repeated words, and multiword expressions will make that
    fragile.
  - First implementation can be deterministic and local to the ten-day Tutor;
    external web links are fallback/reference material, not the primary UX.
  (expanded 2026-08-03 from Tom's Tutor study-word idea)
- Tutor notebook for notes and saved vocabulary — let each learner capture what
  matters while using the course instead of keeping a separate paper list.
  - Add “Save word” from a study-word card and “Add note” from a lesson or drill.
  - Keep Tom and Liz notebooks separate, with the course, day, lesson, source
    sentence, target word or phrase, and date attached automatically.
  - Allow a personal note or memory hook, plus lightweight tags such as verbs,
    food, home, confusing, practice, or favorite.
  - Provide notebook views for all notes, saved vocabulary, and items due for
    practice; support search and simple filtering by day, topic, or tag.
  - Let the Tutor use saved items for optional actions: explain more, generate
    examples, quiz me, pronounce it, add it to review, or make a short practice
    session. LLM help is useful here, but saved data and core notebook behavior
    should remain deterministic and available without generation.
  - Start with local persistence so it is immediately usable, then sync signed-in
    notebooks across devices through the existing account data layer.
  - Saved words should be able to feed the mastery/review queue, but notebook
    capture must never interrupt or reset the current lesson position.
  (added 2026-08-06 from Tom's Tutor notebook idea)
- Group chat — e.g. 1 Spanish + 3 English speakers, everyone reads the whole
  conversation in their own language. Schema (threads/members/messages) is
  already generic; needs accounts for guests, a thread picker, sender names
  on bubbles. Two-language groups fit the current design; 3+ languages needs
  per-language translations. (added 2026-08-03, designed 7/22)
  Planned in docs/group-chat-plan.md — trip-critical, targeted before Spencer's
  Bosnia/Italy trip; "Per-seat languages at /tabletop" below shares the design.
  (planned 2026-08-19)
- Multi-language phase 3 — SHIPPED 2026-08-27 (PR #39, see Shipped). /call
  was the last screen still hardcoded EN⇄ES; it reads the shared pair now, and
  the handshake this entry called "the actual work" is a `language` message on
  the call's own signaling channel. Each phone announces what its owner
  speaks, the other echoes back once, and both interpreters point themselves.
  Walked EN⇄IT across two browser contexts, including a mid-call switch to
  Portuguese that the far end followed without either side rejoining.
  (added 2026-08-03, narrowed 2026-08-18)

- Per-seat languages at /tabletop — the table is one PAIR today, which is
  exactly right for two people and wrong for four. A party where one end of
  the table is Italian, one is Bosnian and two are English needs a language
  per SEAT and a translation per listener, which is the same shape as the
  "Group chat" idea above and probably wants solving once for both. Deferred
  out of the 8/18 catalog work deliberately: the pair maps cleanly onto two
  ends of a phone and anything richer is a new screen, not a wider one.
  (added 2026-08-18)
- Chrome for more than six languages — the app's own buttons and status copy
  are translated into six (STRINGS in TranslatorShell, L in TabletopShell).
  All hundred get a faithful translation in their own language; what they get
  in English is the furniture around it — "TAP TO TALK", "Translating…".
  Worth adding one for a language people keep using. (added 2026-08-18)
- Delete lib/realtime/tabletop.ts — dead since /tabletop moved to explicit
  push-to-talk turns; nothing imports it. It hardcodes en/es language
  inference and a speaker1_en/speaker2_es routing model, so it is the most
  likely place for the two-language ceiling to grow back if someone reaches
  for it. Left alone on 8/18 rather than deleted uninvited. (added 2026-08-18)
- Guest voice clones — quick-clone a recurring guest so their translations
  play in their real voice instead of the stock one. (added 2026-08-03)
- Use lib/net's fetchWithRetry in /chat and /live fetches — /translate,
  /tabletop already have it; extend if "Load failed" is ever seen there.
  (added 2026-08-03)
- Decide the fate of the stale `dev` branch — merged-history only or does it
  hold anything worth keeping? (added 2026-08-03)

## Languages: the two tiers, and adding one

TAOS speaks **100 languages** as of 2026-08-17 — the whole list lives in
`lib/languages/catalog.ts` and nowhere else. Everything derives from it: the
server allow-list (`lib/realtime/languages.ts`), the /translate pills, the
search sheet, the /video and /vision dropdowns, and the photo target.

**Tier 1 (34) — the full experience.** Heard, translated, and spoken back.
These are the languages ElevenLabs' model can actually say out loud: the 32 its
default model reports, plus Bosnian (which has no entry of its own and rides
Croatian pronunciation) and Cantonese (which routes to `eleven_v3`).

**Tier 2 (66) — text only.** Whisper hears them and the translation is just as
good; nothing in the pipeline can say them out loud. The app shows the
translated text, skips synthesis entirely, and says so up front — a muted
speaker on the pill, "Text only" in the sheet, and "Text only · Solo texto"
where the Play button would be (all three drawn by `components/TextOnly.tsx`,
which is the only place that mark exists). No error, no waiting on audio that
was never coming. Every screen asks the same way: `requestSpeech` in
`lib/tts/speech.ts` is the one road to /api/tts, and it answers `null` — never
an error — when there is no voice to be had. Photos are unaffected: /vision never spoke, so a text-only language
reads a menu exactly as well as any other.

**To add a language**: add one row to `CATALOG` in `lib/languages/catalog.ts`.
That is the whole job — no second list, no flag table, no shell edit.

- `code` must be the code the transcriber knows it by (Whisper's), because
  that is the id every route reasons about.
- `label` is the ENGLISH name and is load-bearing: the translation prompts
  interpolate it ("The speaker talks in Bosnian"), so it has to read as a
  language name to a model.
- `tts` must be CHECKED, never guessed:
  `curl -H "xi-api-key: $ELEVENLABS_API_KEY" https://api.elevenlabs.io/v1/models`
  and look for the code in the model TAOS actually uses (`ELEVENLABS_MODEL`,
  default `eleven_turbo_v2_5`). Getting this wrong is the one failure the
  tiers exist to prevent: confident audio in the wrong language's phonology,
  which a listener has no way to recognize as broken.

The app's own CHROME (buttons, status copy) is translated into six languages,
which is a separate and much smaller list — `STRINGS` in `TranslatorShell`. A
language without an entry there gets English buttons and a faithful translation
in its own language, which is the trade that lets the catalog grow without a
translator. Adding a seventh is a kindness to a language people keep using; it
is not a prerequisite for using it.

## Shipped

- **The /call relay, and two silences around it, 2026-08-31** — PR #52.
  Tom and Liz, both founders, both seeing /call, the call initiating and
  never connecting. The field report named TURN as the suspect and TURN was
  the suspect — but reading the transport turned up **three** faults, and
  only the first is about NAT. The other two are why nobody could tell.
  1. **There was no relay.** `lib/call/session.ts` asked for one public
     Google STUN server. STUN only tells a phone its own public address; it
     cannot carry a packet. Two phones behind carrier-grade NAT have no
     direct path to find, so ICE ran out of candidate pairs and stopped.
     `POST /api/call/ice` now mints short-lived Cloudflare TURN credentials
     — **$0.05/GB with the first 1,000 GB free, against Twilio's $0.40/GB**,
     and no SDK, so `package.json` did not grow. Server-side only: the
     `NEXT_PUBLIC_TURN_*` path this replaces would have inlined a relay
     credential into the browser bundle for anyone to read.
  2. **A doomed connection retried forever, silently.** `restartIce()` does
     not throw when the restart is about to fail — it succeeds, ICE fails
     again, and the handler restarted it again. The `catch` holding the only
     error message was unreachable, so "reconnecting…" was terminal. One
     restart now, then an honest bilingual failure, plus a 15-second
     watchdog for the case that never even reaches `failed`.
  3. **Trickled candidates were thrown away.** `addIceCandidate` throws when
     there is no remote description yet, and that throw was swallowed as
     "stale candidate after a rollback". It usually wasn't stale — the
     answerer trickles while its answer is still in flight down the same
     Supabase channel, so any candidate that won the race was lost. On a
     hard network the lost one is the relay candidate, which is the one
     that would have connected the call. Queued now.
  → **Diagnostics stayed.** Gathering/connection states, candidate types,
  TURN credential errors, and the selected candidate pair — to the console
  under `[taos-call-ice]` and to a collapsed "Connection details" panel on
  the call screen. The status pill reads `connected · conectado · relay` or
  `· direct`, because "connected" without saying *how* is what made this a
  code-reading exercise instead of a screenshot.
  → **Proven without phones:** `tests/call-connection.test.ts` drives the
  real `startCall` and fails against each of the three pre-fix behaviours;
  `tests/live-fire/call-relay-check.mjs` connects two headless peers under
  `iceTransportPolicy: "relay"` (205 ms, relay/relay pair, zero host or srflx
  candidates), which is the both-cellular row of the matrix minus the
  cellular. Cost arithmetic in docs/realtime-cost-model.md.
  → **Two things this does NOT close.** Production has no
  `CLOUDFLARE_TURN_KEY_ID` yet, so the relay is dark until Tom creates the
  key — /call is exactly as good as it was until then, no worse. And the
  relay path has only been proven against a local TURN server, never against
  Cloudflare's. The same harness runs against the real thing once the key
  exists.

- **/fast grew a Clear button, 2026-08-31** — PR #49, folded into the mic
  branch. Tom's field ask: a quiet button directly above the mic that puts the
  quickie box back to the state the screen opens in. /fast is used standing up,
  a word at a time, and the real loop is "look this up, now look the next thing
  up" — with the last answer still on the box, emptying it by hand on a phone
  was a long-press menu and two more taps.
  → **The mic stays the star.** Ghost styling at half the mic's size, in the
  same column, bottom-aligned inside the row that was already there — so the
  mic keeps the exact position it had before this button existed. The slot is
  *reserved* rather than faded: the button comes and goes, the box it lives in
  does not, so appearing costs no reflow. A fade would have hidden that jump
  instead of removing it, and a control that slides out from under a thumb
  already on its way down is worse than one that is simply there.
  → **It shows only when there is something to clear**, and the tentative tail
  counts. During a latched dictation the first second of speech is drawn on the
  box but held *outside* `input` on purpose, so it cannot start a translation —
  to the thumb that is still "what is on the screen right now"
  (`lib/fast/clear.ts`).
  → **It resets the machine, not the wallet.** The tap clears the input, the
  translation, the direction caption's detected/target pair, the engine line
  and any error; it orphans the in-flight request so a late reply cannot paint
  into a box somebody just emptied; and it cancels the mic, because a tail
  still arriving is text on its way into that same box. What it does **not**
  touch is `billedRef` — the visit-long memory of which words have already
  counted against the monthly allowance. Clear is a screen gesture, not a
  purchase, and forgetting that set would have made clear-and-retype a second
  charge for the same phrase, landing on exactly the person who cleared because
  they wanted the answer they had just read. It is the one thing here that is
  invisible when it breaks, so it is pinned as a negative assertion
  (`tests/fast-clear.test.ts`).
  → It leaves the **pinned direction** alone for the same class of reason:
  pinning is a decision about the conversation, not about the phrase that was
  just cleared. Somebody who pinned ES→EN to read a menu is about to read the
  next line of the same menu.
- **/fast metering moved to the server, 2026-08-31** — PR #51. Found
  reviewing #46-#49 rather than in the field, and it was the revenue hole:
  `POST /api/fast` gated who could call it and how fast, then translated
  **without ever asking what the month's allowance had left**. The bill was a
  `saveTranslation(...).catch(() => {})` in `FastShell`, fired 1500ms after
  the typing stopped. Everything about that is fail-open — a curl with a valid
  session never ran it, a tab closed a fraction early never ran it, and a
  failed write was swallowed by design. The allowance did not move.
  → **The premise under it was the wrong one.** #46 argued the route "sees
  each preview individually and has no way to know which one was the last".
  True of any one request, false of the stream: the client's settle measures a
  PAUSE IN TYPING, and the gap between two requests from one account is that
  same pause on a clock nobody can edit. So the unit is a **burst** — a run of
  previews in one direction with no gap longer than 1500ms — and it is decided
  in `lib/fast/meter.ts`, not in a browser.
  → **Check, then serve.** The allowance is taken BEFORE `fastTranslate` is
  called, the same shape `lib/tutor/meter.ts` reserves minutes in: the
  reservation IS the `taos_lite_translations` row, so /fast still spends from
  the one meter the whole app shares. `fast_record` fills it in when the
  engine answers; `fast_abandon` deletes it when the engine falls over, so
  nobody pays for a translation that never arrived. Over quota is a **402**
  that never reaches a provider.
  → **The rate limit is durable now.** `public.fast_rate` is a fixed-window
  counter in Postgres, shared by every instance and surviving a cold start.
  The in-process one stays in front of it because it is free and runs before
  the body is read — it is the fast path, not the ceiling.
  → Verified twice, because a JS test of a mock is not a test of plpgsql: 22
  route tests against a simulated Postgres, **and** the eleven real functions
  driven against the live database with a fixture account (continuation,
  pause, direction flip, refund, over-quota, both rate windows), then cleaned
  up to the row.
  → **The screen is unchanged**, and so is what a founder is charged: both
  founders are subscribers, so nothing is capped today. This closes the hole
  *before* `NEXT_PUBLIC_ENABLE_FAST=1` opens the door, which is the only
  moment it was ever going to be cheap to close.

- **/fast grew a mic, 2026-08-30** — PR #49. The keyboard is still the way in;
  the mic is the sausage-finger lane onto the same box. Hold it or tap it, and
  the words land **in the input** as editable text rather than on screen as an
  answer — which is the whole difference between this and the home screen.
  There, speaking *is* the turn and a mis-heard word is a mis-heard turn. Here
  it is a draft, and fixing it costs a keystroke.
  → **No third clock.** The transcript is written into the input exactly as if
  it had been typed, and the two clocks that were already there take it from
  the top: 300 ms later it is translated, 1500 ms after that it counts. One
  spoken quickie bills one row, the same as one typed one; fixing a mis-heard
  word bills a second, which is honest — it is a different phrase, and the one
  the person actually meant.
  → **The mic spends against the same meter as the keyboard.** `POST
  /api/fast/listen` shares `/api/fast`'s founder gate *and* its
  `checkFastRate` buckets, so 60/min is 60 of anything rather than 60 of each.
  A mic with its own counter would have been a second way to spend on /fast
  that the /fast ceiling could not see — and it is the pricier of the two
  calls.
  → **It transcribes and stops.** Reaching for `/api/translate` instead would
  have bought a `gpt-4.1` paraphrase per dictation, in the house register
  /fast deliberately does not use, only to throw it away. Instead that route's
  transcriber was lifted out unchanged into `lib/translate/transcribe.ts` and
  both now call it — which is how the mic inherited the 7/27 no-guess fence
  and the Cantonese hint rather than shipping a fourth copy of the fetch
  without them.
  → Walked against REAL Azure on 2026-08-30 (the key is write-only, so the
  token came from a temporary secret-guarded probe route deployed with
  `vercel deploy --env`, removed afterwards along with its deployments). Auto,
  4.15 s of English: first words on screen at 2374 ms — 1777 ms *before* the
  speech ended — then the full sentence as `[en-US]`. The same unchanged pair
  given 6.25 s of Spanish, with nobody telling it which: first words at
  2478 ms, `¿Dónde está la farmacia?` finalized at 2603 ms as `[es-MX]`, and
  the next clause already guessing again. Pinned to English: 803 ms. The
  fallback was walked separately with no Azure key present — the token route
  404s, the mic drops to batch without a word, and the batch flow passes
  unchanged.
  → Walked in a real browser with a real `MediaRecorder` and a fake microphone
  (`tests/live-fire/fast-dictation-browser-check.mjs`): held 1.5 s → 1 upload →
  transcript in the box → 1 billed row → every audio track ended afterwards;
  then a tap latches and the next tap stops it. The Chrome flag is
  `--use-fake-device-for-media-stream`, and getting it wrong opens the real
  microphone and looks exactly like a broken button.
  → **And then it learned to stream, in the same PR.** Tom, same day: the batch
  mic *feels dead while talking* — you talk to a button that does nothing, for
  as long as you talk, and then everything happens at once. Right feature,
  wrong screen for a progress bar. So the mic now opens a websocket from the
  phone to **Azure Speech** and renders the words as they arrive. The batch
  path stays in the build as a silent fallback and is still the only mic for
  the 24 catalog languages Azure cannot hear.
  → **Audio does not go through Vercel**, because a function hop per 100 ms of
  speech would spend exactly the latency this exists to save. That needs a
  credential in the browser, so `AZURE_SPEECH_KEY` never is one: `POST
  /api/fast/speech-token` mints a ten-minute JWT that can only recognise
  speech. Same resource the tutor's Crawl scoring already uses — and pointedly
  *not* the Translator resource the literal engine still wants, which remains
  uncreated.
  → **Partials are drawn; only finals are text.** The one rule that makes this
  affordable, and the only one that is invisible when it breaks — nothing
  looks wrong, it just costs more. A hypothesis renders as a dimmed tail and
  is held outside the input, so it never starts the 300 ms debounce; wiring it
  in would have fired dozens of per-character billed translations per spoken
  phrase to render text that was about to be replaced anyway. The settle clock
  never moved: one settled quickie still bills one row, however many segments
  it arrived in.
  → **The candidate list is two, and a stopwatch chose it.** Azure allows 4
  languages for at-start identification and 10 for continuous, so the obvious
  design was to fill the list with the pair plus recents. Measured on one
  4.15 s clip, time to the first word appearing: 1 language 0.80 s, 2
  continuous 2.42 s, 2 at-start 3.83 s, 4 at-start 3.81 s, 4 continuous
  4.49 s — **and all five transcribed it identically.** The extra candidates
  bought nothing and cost up to two seconds of the only thing this feature
  sells. A quickie is often shorter than four seconds, so the fat list would
  have shown the words *after* you stopped talking. Hence: never more than the
  two pills, and continuous rather than at-start.
  → **Pinning the direction is the fast path** — one language, no
  identification step, first words at 0.8 s instead of 2.4 s. It also rescues
  pairs Auto has to refuse: pinning needs only the one language to be
  hearable, so English-with-Latin still streams if you pin to English. In Auto
  both pills are required, because a recogniser that hears one side would
  silently mangle every sentence said in the other.
  → **The fallback says nothing, and is re-decided every press.** A mic that
  explains why it is in its slower mode interrupts somebody mid-errand to
  discuss infrastructure; a mic that fell back once and stayed there for the
  rest of the trip would be a worse bug than the one this fixed, and an
  invisible one.

- **/fast — the Google-quickie box, 2026-08-30** — PR #46. Tom's ask: a
  single input where the translation "renders as you type", plain and
  word-for-word — the thing everybody already knows how to do. It is the ONLY
  literal surface in TAOS, deliberately: every other screen asks for the
  translation "a fluent friend would say", and this one asks for the plain
  word you would look up. That contrast IS the feature, and it is also why it
  ships **founders-only** (`fastVisibleTo`, `NEXT_PUBLIC_ENABLE_FAST=1` to
  promote — one env var, no code change): two translation screens that
  disagree on purpose should meet a wave of strangers only after we have
  watched founders read them side by side.
  → **The engine was measured, not assumed** (`docs/fast-engine.md`, rigs in
  `tests/live-fire/fast-engine.measure.ts`). Two findings worth keeping:
  **(1)** the first literal prompt made the models *worse*, not more faithful —
  told to keep source word order at any cost, `gpt-4.1-nano` returned Polish
  with an English "the" standing in it (`jak ja dostanę się do the`), a
  doubled word (`ile to to kosztuje`) and the wrong gender (`dwa kawy`).
  Adding a grammar floor to the rule cleared every one. Same lesson as the
  7/27 dropout fence: a prompt fence that only pushes one way pushes past the
  thing it was protecting. **(2)** an LLM is roughly **10–20× CHEAPER** per
  quickie than Azure Translator ($0.000027 vs ~$0.00026), which is backwards
  from the assumption — Azure is bought for its *register* and its latency,
  not its price. Azure is primary; `gpt-4.1-nano` is a real fallback, for the
  ten catalog languages Azure cannot translate at all and for right now,
  because **the Translator resource does not exist yet**. `AZURE_SPEECH_KEY`
  is a different resource kind and does not open that API. Setup steps for
  Tom are in `docs/fast-engine.md`; until then /fast works and says on screen
  which engine answered.
  → **Metering: two clocks, on purpose.** 300ms debounce decides when to CALL;
  1500ms of stillness decides when it COUNTS against the free monthly
  allowance — because everything rendered between keystrokes is a preview of a
  sentence still being written, and billing previews would spend a free month
  on one paragraph. It writes the same `taos_lite_translations` row the home
  screen writes, so /fast meters into the normal allowance instead of growing
  a private counter. Measured on the real component in a real browser: 21
  characters typed → **2 provider calls, 1 billed row**. Server ceiling of
  60/min per account on top, because a debounce is a courtesy the browser
  extends; a driver ignoring it entirely got 60 served and then 429s.
  → **Both halves of that paragraph were wrong, and #51 fixes them** (8/31).
  The 1500ms clock ran in the BROWSER and wrote the billing row itself, so a
  caller who declined to run it — a curl with a valid session, a tab closed at
  1400ms — was never billed at all; and the 60/min ceiling was a counter in
  module scope, which on Fluid Compute means 60 times however many instances
  are warm. Kept here as written rather than edited, because the reasoning is
  the interesting part and it was confidently wrong.
  → Verified against the real API through the shipped route: EN→ES p50 702ms,
  EN→PL p50 627ms, auto-detect correct in both directions, non-founder 404
  without the provider ever being called.

- **The X that meant "more", 2026-08-30** — PR #TBD. Liz, taking the app to
  strangers ahead of the launch wave: the round button in the header that
  opens Tutor / Video / Photo / History / the guide / About reads as
  **delete-or-close**, and people will not tap it. It was not a stray icon —
  the trigger drew the first letter of the signed-in email, and on the account
  Liz was demoing from (`xdrabbit@`) that letter is **X**. So the control that
  OPENS the menu was wearing the universal symbol for dismissing things, and
  which glyph a stranger met depended on whose phone it was: an `x` email drew
  an X, an email starting with a digit drew a number, an email with no
  alphanumeric at all drew a person icon.
  The closed state is the nine-dot apps grid now — the affordance every phone
  already teaches — and the OPEN state is an X, which finally means what it
  looks like. Labelled `More · Más` closed and `Close menu · Cerrar menú`
  open, on both `aria-label` and `title`. Both glyphs sit in one 16px box and
  cross-fade, so the header cannot reflow mid-tap (measured: the button and
  both glyphs hold the same rect across closed → open → closed).
  The email did not just disappear: it was only ever the trigger's `title`,
  which needs a mouse and so had never rendered on a phone at all. It is a
  line at the top of the menu now, above the Sign out it belongs to.
  Fenced by `tests/nav-menu-trigger.test.ts`, and walked in headless Chrome at
  390 / 360 / 320 px against the shipped component.
  → **Found while measuring, not fixed here:** the signed-in header
  **overflows every phone width** — content runs to 406 px against a 390, 360
  or 320 px viewport, so the whole page slides sideways. Identical on `main`
  before this change (406 / 406 / 407), so it is pre-existing and not from the
  icon swap. This is the exact failure the "Together ▾" collapse was built to
  cure in the first place; `Live` + `Together ▾` + `Translate` + two icons has
  grown back past the fence. Needs a layout decision, not a one-liner — see
  **Up next**.

- **The Finish button, 2026-08-28** — PR #TBD. Tom's field report: Module 1,
  all three phases ticked, "You covered the whole topic · Cubriste todo el
  tema" on screen, and **"Finish this module →" did nothing**. Not a missing
  handler — Run marks itself done on its last beat (`onComplete`), so by the
  time the button appeared the only thing it did was re-write a timestamp that
  was already there: no state change, no render, no way off the screen.
  Finishing is its own act now (`finishModule` stamps `completedAt`), it takes
  the learner back to the picker, and the picker checks the module off, dims
  it, names what is next, and says so once in both languages. Re-entry is
  untouched: a finished module opens at Crawl, because review is a feature.
  Verified as a real render — the arc walked in headless Chrome against the
  shipped component, not a fixture of it.

- **Merge train, 2026-08-28** — PR #41 (tutor phase 2 metering) and PR #42
  (realtime cost caps) shipped back to back in that order; #42 was rebased onto
  the post-#41 `main` because both edited this file. The caps take effect on
  the next mint.
  → **Correction, same day:** the sentence that stood here said tutor stays
  dark. It does not. Verifying the merge against production turned up
  `NEXT_PUBLIC_ENABLE_TUTOR=1` scoped to **Production and Preview**, added
  2026-08-26 alongside phase 1 — so `/tutor` has been serving 200 and the
  storefront has been selling packs unlabelled since then, and the phase-1
  note's "flag off in Production, Preview is unscoped" read one half of the
  mistake and missed the other. Nobody appears to have walked in: the last
  `tutor_sessions` row is 2026-07-27 and both users on the table are founders.
  Phase 2 landing is what put a meter under it. The flip checklist below is
  still Tom's to walk — steps 1 and 2 are, accidentally, already done, so what
  is left is deciding whether to take tutor back down until step 3 is walked,
  or to walk step 3 now on a feature that is already public.

- **Cost caps on the public realtime screens, and a toggle that obeys** —
  2026-08-28, PR #42. The exposure flagged while costing /call turned out to
  be worse on the two screens customers can actually reach. Measured against
  live `gpt-realtime` sessions: **/live billed 460% of the audio actually
  spoken** (per-turn re-read climbing 51→180→267→326→398→447 and still going)
  and **/tabletop 400%** (39→…→255). Capped at 150 and 100 respectively, both
  go flat: /live 110%, /tabletop 115%. Per minute, **/live $0.074 → $0.049**
  and **/tabletop $0.032 → $0.022**, with no quality change — and the caps are
  floors, not guesses: at 100 /live repeats a summary verbatim, at 75
  /tabletop invents a sentence nobody said. Both numbers, both cliffs and a
  three-surface $/min table are in `docs/realtime-cost-model.md`.
  Also: `/live` and `/tabletop` now expire their minted secrets after 120s
  like /call does, `/tabletop` gained the hard session ceiling it never had,
  and `/live` **warns before it stops** instead of going quiet mid-dinner and
  explaining afterwards.
  The measurement rig is committed this time (`tests/live-fire/`,
  `npx vitest run --config vitest.measure.config.ts`) and it drives the same
  session builders the mint routes use, so the numbers describe what ships.
  It earned its keep immediately: its first tabletop run reported a quality
  cliff at 100 that was the harness failing to re-point the session per turn
  the way the real client does, not the cap.
  And Tom's /call field report — the output settings "appeared not to work or
  lagged" — was two separate bugs. (1) The translated-voice toggle only
  changed what the NEXT sentence did, so a tap during a six-second translation
  did nothing visible; it now stops the sentence in the air, and a muted call
  no longer pays ElevenLabs for a voice nobody can hear. (2) The three-step
  "their real voice" ducking was a **no-op on iPhone** —
  `HTMLMediaElement.volume` is read-only on WebKit — so it now runs through a
  WebAudio gain node, and only switches to it once the graph has been observed
  working. The two controls also say whose voice each one is now.

- **Tutor phase 2 — the cash register** (PR #41, 2026-08-28) — the last gate
  before /tutor can go public. Minutes are metered SERVER-side and RESERVED at
  mint: `POST /api/tutor/realtime` asks `lib/tutor/meter.ts` for a grant before
  it spends a cent, and the grant is held in full until the session settles, so
  two tabs cannot spend the same fifteen minutes and closing a tab is not how
  you get free ones (`tutor_reap_open_sessions` collects an end that never
  arrived, at the full grant). The duration billed is the SERVER's clock capped
  at the grant; the number the browser reports is recorded beside it as
  `client_seconds` and never billed — which is the open question phase 1 wrote
  into `lib/tutor/meter.ts` and left for phase 2, answered by moving the whole
  `tutor_sessions` lifecycle server-side and dropping the table's insert and
  update RLS policies.
  → **Plan first, then pack.** Plan minutes (15 / 45 / 200, the numbers on the
  pricing page, now pinned by a test that reads Paywall.tsx) reset on the
  calendar month in UTC; pack minutes are a PURCHASE and roll over forever on
  `profiles.pack_seconds`. That is a change: packs used to credit
  `bonus_seconds` scoped to `bonus_period`, so a $9.99 pack bought on the 30th
  was mostly a donation. The webhook is replay-safe now too —
  `stripe_pack_credits` makes the checkout session id an idempotency key, and
  the PR #29 "re-read from Stripe" rule applies, so an event snapshot saying
  `paid` for a session Stripe currently calls `unpaid` credits nothing.
  → **Warm, not abrupt.** A session that will run out warns at T-2 minutes and
  then ends at a TURN BOUNDARY, never mid-sentence — with a hard stop 30s later
  so a stalled turn cannot hold a microphone open. A refusal is a bilingual
  card that shows where the learner stands before it offers anything, and
  offers a subscriber PACKS rather than the subscription they already bought.
  The header chip shows what is left, in both languages, on every tutor screen.
  → **Founders bypass entirely** (`isFounder`, so it is the email and not the
  plan): unlimited grant, session row still written with `metered = false` so
  the minutes stay visible to a cost query, ledger untouched. Tom and Liz keep
  testing free without making the cost reports lie.
  → **Crawl is metered too**, in the duration of the audio Azure assessed —
  server-measured off the WAV, a few seconds an attempt, so fifty drills cost a
  free learner under three minutes of fifteen. Without it, the one tutor phase
  a free account could grind forever was the one that calls a paid API on every
  tap.
  → `tutor_mastery` dropped (audit finding 4). Progress stays in localStorage
  and stays on the backlog.
  → Verification: `docs/tutor-metering-verification.md`. The plpgsql that
  actually moves money was walked against the real database — accrual, replay,
  the plan/pack boundary, founder exclusion, the reaper — and every synthetic
  row cleaned up after. 786 tests green.
  → **The flip checklist** (Tom's ceremony, not a merge):
    1. `vercel env add NEXT_PUBLIC_ENABLE_TUTOR production` → `1`.
    2. Redeploy Production. The badges vanish on their own — `tutorComingSoon()`
       is just `!tutorEnabled()`, so the paywall's ✓s, the pack buy buttons and
       the nav link all come back with no copy edit.
    3. Walk one real session as a founder on the deployment, then one on a
       non-founder account: confirm the chip drops by about what was spoken and
       that `tutor_usage.partner_seconds` agrees. This is the one thing the
       verification could not do from a laptop — `SUPABASE_SERVICE_ROLE_KEY` is
       sensitive, so `vercel env pull` cannot fetch it.
    4. Delete `NEXT_PUBLIC_ENABLE_TUTOR` from **Preview**, or re-add it with
       `--git-branch`: it is currently unscoped, so every branch preview shows
       tutor.
    5. One live pack purchase, per the `stripe-live-fire` runbook, then refund.
  → **Known gap, deliberate:** a Stripe REFUND does not claw pack minutes back.
  `charge.refunded` is not handled, so a refunded pack leaves its seconds on
  the balance and has to be zeroed by hand. Worth wiring before packs are sold
  at any volume; not worth blocking the flip on, since the refund is a human
  action in the dashboard today anyway. (added 2026-08-28)

- **Walk and Run cannot circle one phrase — the client owns the script
  position** (PR #40, 2026-08-27) — Tom's field test, screenshot-verified: the
  Walk agent took "Buenos días" correctly five times, said "Ahora es perfecto.
  Gracias." and then asked for it again after a "mhm". The second line of the
  scene never arrived. The cause is structural — a realtime model holds no
  script state and re-derives where the scene is on every turn — so the fix is
  not a better prompt: **`lib/tutor/beats.ts` holds the position in the client**
  (an ordered beat list derived from the lesson's roleplay for Walk, topic
  checkpoints from the module's core moves for Run) and pushes it back into the
  live session with `session.update` whenever it moves. A beat ends two ways
  and no third: the learner produces the line (fuzzy match, accents and extra
  words forgiven) or **three attempts and the scene moves on anyway** —
  `BEAT_MAX_ATTEMPTS` is `CRAWL_MAX_ATTEMPTS` by import, so Liz's mercy law is
  one number in one place. Acknowledgments ("mhm", "ok", "sí") are explicitly
  "carry on": no attempt, no advance, no restart — and the current line is
  tested first, so a module that teaches "yes" still takes "Sí" as the line.
  If the model re-drills anyway it is corrected, and after two corrections on a
  beat the learner is already working the client advances without it. Two
  things the verification run found that the plan did not: the prompt was
  arguing with itself ("have them repeat it once" is the loop's own
  instruction — Walk and Run now correct inside the tutor's own reply, Partner
  keeps the kindlier version), and a line the mercy cap SKIPPED has to be
  closed too, worded so the model is not told the learner said it. Scene ends
  → the phase ticks itself and the "go to Run" button pulses. Live transcripts:
  `docs/tutor-walk-progression-verification.md`. Still owed: nobody has spoken
  to it with a mouth (every learner turn in the run was text), and no live Run
  session was minted. Tutor stays flag-off in Production.

- **/call comes back — founders only, catalog-wired, and half the price**
  (PR #39, 2026-08-27) — /call had been dark to everyone since 8/18. Two
  objections put it there and both are answered.

  **The catalog.** It was the last screen still holding `type TargetLang =
  "en" | "es"` with a two-name lookup table beside it, so a trip on [en, it]
  got its call interpreted into Spanish — confidently, with no error anywhere.
  CallShell reads `useLanguagePair()` now like every other screen. But a call
  is the one screen where the two ends hold SEPARATE pairs on separate phones,
  which is what ENHANCEMENTS.md meant by "the handshake is the actual work,
  not the picker": each phone announces its owner's language on the call's own
  signaling channel, the other echoes back once, and each interpreter listens
  for THEIR language and speaks MINE. `tests/screen-language-wiring.test.ts`
  lists /call now, so it keeps passing the same rules as everyone else.

  **The money.** The guards asked for on 8/03 are in, and the per-minute cost
  is measured rather than estimated — `docs/realtime-cost-model.md` has the runs.
  Two findings changed the design:
  - The obvious saving wasn't there. Server VAD already filters silence out of
    the bill (34.1 s streamed, 22.7 s billed), so there is no client-side
    speech gate — it would only have bought a way to clip the start of a
    sentence.
  - The real cost was invisible: **every response re-reads the whole
    conversation as audio at $32/Mtok**. Uncapped, a session billed 209% of
    the audio actually spoken and was still climbing turn over turn. Capped
    with `truncation.token_limits.post_instructions: 100`, it bills 66% and
    holds flat, with translations no worse (both settings turned the same
    Spanish into the same Italian).

  Plus: the model no longer speaks by default. It writes text and `/api/tts`
  reads it in the app's own voices — Liz's clone saying her own sentence in
  English — which is 3× cheaper than model-generated audio AND the better
  voice. Also a 2-minute idle hangup with a warning, a 60-minute cap in place
  of four hours, a 120-second TTL on the minted secret, and near-field noise
  reduction so a passing bus is not a billed turn.

  **~$0.123/min → ~$0.058/min** for a two-phone call, and the number is on
  screen while it spends, plus one `[taos-call-cost]` line per call in the
  Vercel log.

  **Who can reach it.** Founders only, via `callVisibleTo()` — the gate /video
  sits behind. `NEXT_PUBLIC_ENABLE_CALL` stays off and changed meaning: it is
  "has /call shipped to customers" now, not "does /call exist". Non-founders
  get no nav entry, a bounce home from `/call?room=XYZ` (a card would be an
  advert for something they can't have), and a 404 from both call routes —
  proved against the real handlers, asserting that OpenAI is never reached.

  Two things found on the way: the mint route was never sending an
  Authorization header, so it would have 401'd Tom the moment the gate went
  from "nobody" to "founders"; and two taps on Join — nothing disables that
  button — started two sessions on one room and killed the call with a
  Supabase presence error. Both fixed, the second verified by driving two
  browser tabs through it.

  **Not verified:** two real phones on two real networks. Carrier NAT, whether
  TURN is needed, and whether the ~1s the cloned voice costs is worth paying
  are all trip questions. The "⚡ Fastest" toggle answers the last one without
  a deploy.

- **Crawl moves on at "close enough" — Liz's field report, and the score that
  was never there** (PR #38, 2026-08-27) — Liz was the first person outside
  this repo to walk the curriculum and she hit a wall: Crawl's Say-It step held
  her on one phrase, asking for a pronunciation she was not going to produce
  that day. There are now two ways out of a phrase and no third — **pass at 60**
  (`CRAWL_PASS_SCORE`, `lib/tutor/crawl.ts`; 70 at Intermediate, 80 at Advanced,
  because a learner who chose Advanced asked to be pushed), or **three attempts
  and Crawl lets go anyway**, warmly — "Close enough — we'll circle back ·
  Suficiente por ahora — volveremos" — marking the phrase for review in
  localStorage for phase 2 to surface. The attempt cap applies at every level,
  so Advanced means "three tries at 80" and never "stuck at 80". The score is
  still on screen but small, beside the bar it is measured against ("32% · 60 to
  pass"), with three dots that make the cap visible before it arrives.
  → **The verification found a bug older than the fix: Crawl never showed a
  score at all.** Not once, in any language, since phase 1. The assess route
  read `NBest[0].PronunciationAssessment.PronScore` — the Speech SDK's shape —
  and the REST endpoint the app actually calls returns the scores FLAT on the
  NBest entry. `pa.PronScore` was `undefined` on every request, `?? null` made
  it null, the screen rendered "—", and the coaching model was handed
  `pron ?? 0` and wrote warm specific feedback about a score of zero, which is
  why it still looked alive. Nothing threw and nothing logged. Fixed in
  `lib/tutor/assessment.ts`, which reads both shapes and is pinned by a REAL
  captured Azure response. **Reaching Azure is not the same as a number
  arriving** — phase 1 verified the former and recorded it as the latter.
  → Verified against real Azure (westus2, es-MX) through a temporary
  secret-guarded probe deployed to a preview, because the key is SENSITIVE in
  Vercel and cannot be pulled to a laptop; the probe is deleted from the branch.
  An audibly-foreign but recognizable attempt scores **76–92** and passes;
  only a missing word or real hesitation falls under 60 (**32–38**). Then the
  real screen was walked in headless Chrome replaying those exact payloads:
  three failures → the bilingual cap framing renders and the review mark
  lands → auto-advance → the next phrase passes at 76%. The last phrase never
  auto-advances into Walk, because Walk opens a realtime session and nothing
  should spend money on a timer. Full run, numbers and the two remaining gaps
  (a human mouth; a phone against the fixed route):
  `docs/tutor-crawl-gating-verification.md`.

- **Data hygiene: delete means delete** (PR #37, 2026-08-26) — the three
  gaps `docs/data-map.md` found between what TAOS promises and what the
  database does, closed, plus the world-writable table it found on the way.
  **The two backup tables are dropped** —
  `taos_lite_translations_bak_20260706` (2,081 rows, June–July, with ZERO
  overlap with the live table) and `..._bak_20260825` (1,718 rows) held
  everyone's utterances in full, outside every delete path, with no FK to
  `auth.users` and no policies, so a user who cleared their history was
  wrong about what still existed. Straight drop, Tom's call, no export.
  **`taos_leads` is server-only** — its policy was INSERT for `{anon}` with
  `WITH CHECK (true)`, and the key that satisfies "anon" is in every browser
  bundle: a real POST with `Prefer: return=minimal` answered 201 Created
  before this landed. Policy gone; `POST /api/leads` is the replacement
  (origin check, rate limit, shape validation). **Either partner can burn a
  chat** — a 1:1 thread belongs to both, so either member deletes ALL of it
  (both senders' messages and the voice audio), with a bilingual confirm that
  says "for BOTH of you" out loud. Deleting an account now takes its threads
  with it, which ends the asymmetry where one person's deletion left the
  other holding half a conversation they could not remove. So delete means
  delete for chat now, as it already did for translate history (that path was
  re-verified against the live schema this pass — per-row and clear-all both
  work and neither reaches anyone else's rows; unchanged).
  → **The one thing SQL cannot do**, and the reason there is a sweep: Supabase
  refuses direct deletes on `storage.objects`, so no trigger or cascade can
  ever reach a voice note. The delete route holds the Storage API and removes
  a thread's audio BEFORE its rows; for the paths a route cannot see — an
  account deleted in the dashboard, most of all — `/api/chat/voice/orphans`
  (founders-only, GET reports, POST sweeps) is the cleanup. **Run it after any
  account deletion.** Orphan count at the time of the pass was already 0 (27
  objects, 27 owning rows — the "27 orphans" that started this was a
  misreading of the map), and the point of the sweep is that it stays 0.
  → Verified in a rolled-back transaction against the live schema: a member's
  delete removed both senders' messages, a stranger's delete removed nothing,
  and an account deletion removed the whole thread including the survivor's
  half. Production data was not touched. What is NOT machine-verified is one
  real tap on a real phone — see the note in **Up next**.

- **Tutor phase 1 — the curriculum engine, merged dark** (PR #35,
  2026-08-26) — fourteen language-agnostic intent modules as data
  (`lib/tutor/modules.ts`), lessons generated per (module × target × learner)
  with the contrast hook and cached in `tutor_lessons` so repeat visits cost
  nothing, and the crawl/walk/run loop running against real Azure
  pronunciation scoring and a real GA realtime session. Merged with
  `NEXT_PUBLIC_ENABLE_TUTOR` still off in Production: /tutor redirects home,
  every /api/tutor route 404s, and the nav link and tutor wording stay hidden,
  so nothing customer-facing moved. The point of merging it dark is that phase
  2 (plan-minute metering) can now be built against main instead of a
  long-lived branch — the hook points are already emitted in
  `lib/tutor/meter.ts`. Run log and transcripts:
  `docs/tutor-phase1-verification.md`.

- **Liz's voice rolled back to the familiar clone, and her ID is config now**
  — the 8/23 swap to `atyoq…` ("lizma5") was the WRONG VOICE, and Tom heard it
  before anything else could. `ELEVENLABS_LIZ_VOICE` is gone; her ID is read
  from `ELEVENLABS_LIZ_VOICE_ID`, set in Vercel Production and Preview to
  `tpOaz…` ("lizma2") — the voice that was live before PR #32. What makes this
  worth writing down is WHY every check passed on a voice that was not Liz:
  `lizma5`'s ElevenLabs category is "generated", a Voice Design synthesised
  from the text prompt "…Venezuelan accent with a San Cristobal vicinity
  focus…". It resolves, the account names it, and it returns HTTP 200 with
  real Spanish MP3 audio on both `eleven_turbo_v2_5` and
  `eleven_multilingual_v2` — identical evidence to the actual clone
  (`lizma2`, category "cloned", description "liz better"), which was re-probed
  on both models before this rollback. A prompt-built stranger with the right
  accent is indistinguishable from a clone to every automated test we can
  write; only ears can tell. So the value left the repo: the next retrain is a
  dashboard edit plus a redeploy, no PR. There is deliberately no hardcoded
  fallback ID — unset means the stock multilingual voice plus a loud server
  log, because a stale constant sounds like a person and nothing downstream
  can flag it. The tests now pin the SHAPE of the lookup (env read, loud
  fallback, no personal ID literal in `lib/tts/voice.ts`) instead of a value
  they cannot verify. Tom's clone, the voice-follows-speaker rule and the
  `TAOS_PERSONAL_VOICE_CODE` gate are untouched. (2026-08-23, PR #33)

- **Liz's voice ID swapped to the retrained voice** — SUPERSEDED the same day
  by the rollback above: `atyoq…` ("lizma5") was not the voice Tom wanted.
  Kept for the record because of what it proves — the swap was verified
  against the account listing AND with real 200-plus-audio TTS calls, and
  every one of those checks was satisfied by the wrong voice. Original entry:
  Tom had Liz's voice
  re-made in ElevenLabs, so `ELEVENLABS_LIZ_VOICE` in `lib/tts/voice.ts` moved
  from `tpOaz…` ("lizma2") to `atyoq…` ("lizma5"); the retired ID is out of
  active code. Per the standing rule in that file, the account was re-listed
  before the swap and the new ID was proved with real TTS calls (HTTP 200 +
  MP3 audio) on both `eleven_turbo_v2_5` — the model `/api/tts` actually
  sends — and `eleven_multilingual_v2`. Two things worth knowing: the live
  value comes from code, not a Vercel env var (there is no Liz voice var in
  Production), and the new voice's ElevenLabs category is "generated" (Voice
  Design from a text prompt) rather than "cloned" like lizma2 was, so it is a
  new voice built to Liz's accent rather than a retrain of her recordings —
  Tom's ears are the judge of whether it reads as Liz. The account now holds
  five Liz entries (Lizma, lizma2, Lizma 3, lizma4, lizma5); match on the
  name, not on "the Liz one". No change to the voice-follows-speaker rule or
  the TAOS_PERSONAL_VOICE_CODE gate. (2026-08-23, PR #32)

- **First live transaction verified end-to-end — and the webhook bug it
  caught** — a real PREMIUM purchase ($19.99, 2026-08-23 01:02 UTC) was
  charged, delivered, refunded and cancelled against the live account. The
  charge and all six webhooks were perfect; the profile row was not. Stripe
  delivers events concurrently and out of order, and
  `customer.subscription.created` carries a pre-charge `status: "incomplete"`
  snapshot — it landed *after* `checkout.session.completed` and overwrote a
  paying customer back down to `plan=free, tier=null`. A second bug hid inside
  it: the account's API version moved `current_period_end` onto the
  subscription item, so every sync stored null. The webhook now re-reads the
  subscription from Stripe instead of trusting the event snapshot, so a late
  event is a redundant write rather than a downgrade.
  `tests/stripe-webhook-sync.test.ts` replays the real event order.
  Test cost: $0.88 (the Stripe fee is not returned on a refund).
  Merged and live on production 2026-08-23 as `4f48caa`. The fix itself is
  still unproven against a real card: tonight's purchase is what *found* the
  race, so the criterion it failed — a profile that flips to the paid tier and
  stays there after the last late webhook — is what the $5.99 Basic re-test
  exists to prove. Re-test from `bestboy32445@gmail.com` (the only account
  with a live-mode customer); `xdrabbit@` and `lizmariett@` still carry
  test-mode customer ids and stale `plan=pro` rows, so a flip is not visible
  there. A non-null `current_period_end` on the row is the tell that the new
  code wrote it — the old code stored null every time.
  (shipped 2026-08-23, PR #29)

- **Stripe live mode — real cards, and a guard so a missing price id cannot
  hide** — the account is on live keys, with the four price ids wired
  explicitly. (shipped 2026-08-22, PR #27)

  Live catalog (account `acct_1Tk7XQHRRKSWY3H5`, all four on product
  `prod_UjbTZmdQt2VS7Z` "TAOS-LITE"):

  | env var | live price id | amount |
  | --- | --- | --- |
  | `STRIPE_PRICE_BASIC` | `price_1U70KPHRRKSWY3H546OMw43o` | $5.99/mo |
  | `STRIPE_PRICE_PREMIUM` | `price_1U70KOHRRKSWY3H56ZC3BX5j` | $19.99/mo |
  | `STRIPE_PACK_100` | `price_1U70KOHRRKSWY3H5JZugAldN` | $9.99 one-time |
  | `STRIPE_PACK_200` | `price_1U70KNHRRKSWY3H5xLoLqr0g` | $17.99 one-time |

  Every price id used to have a hardcoded test-mode fallback, which is right on
  a laptop and wrong at the till: unset `STRIPE_PRICE_BASIC` in production and
  a real customer would be sent to a checkout session built from a test price
  the live account cannot charge — a generic error, with nothing in the logs
  pointing at the missing var. In production (`VERCEL_ENV === "production"`) a
  missing price var, a price var still holding the test id, or an `sk_test_`
  key now throws at first use, naming the variable. The guard is lazy on
  purpose: a build imports every route module, so the throw has to reach the
  request that needed the price, not the build. Outside production the
  fallbacks stay, unchanged. Pinned by `tests/stripe-live-prices.test.ts`.

  Live webhook `we_1U7PR0HRRKSWY3H5sAnyAxgF` →
  `https://taoslite.com/api/stripe/webhook`, subscribed to exactly the four
  events the handler reads. The legacy `STRIPE_PRICE_ID` env is retired.

  One scoping fix came with it: `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`
  were single vars covering Production *and* Preview, so putting the live key
  in Production put it in every preview branch too. All six Stripe vars are
  Production-only now. Preview has no Stripe config at all, so preview billing
  routes answer "Billing is not configured yet." until Tom adds an `sk_test_`
  key scoped to Preview.

- **/guide — the quick start travels with the QR code** — a bilingual page
  for the people the app gets handed to. (shipped 2026-08-20, PR #26)

  TAOS goes out by QR code to strangers, and everything they needed to know
  after scanning it was being explained out loud, once per person, or not at
  all. /guide is that explanation as a page: install (3 steps), the four ways
  to talk, photo translation, choosing languages, and what is free.

  Linked from the three places the handoff actually happens — the QR share
  sheet, so the instructions ride along with the code; the storefront footer,
  above About, because someone who arrived from a QR code wants to know how to
  USE it before they want to know what it is; and the account menu, for the
  person doing the handing.

  **Written against the shipped UI, not against the ask.** Every control it
  names was read out of the component it lives in, and one of them was a trap:
  the header pill labelled "Translate" is the TYPING screen, while the
  microphone screen is the one the app opens on and has no pill at all. A
  guide that conflates the two sends every reader to the wrong screen on step
  one — so the first mode is named for its button ("Speak · Hablar") and the
  typing pill is accounted for by its real name in the footnote. Same care for
  the rest: photo translation is in the account menu as "Photo translator ·
  Fotos", the row control is "+ More · Más", text-only languages are marked
  "Text only · Solo texto", and Call and Video are dark for RC1 so they go
  unmentioned.

  Bilingual per SECTION rather than per line. The chrome convention is
  "English · Español" on one line and that stays for headings and for labels
  already bilingual on screen; paragraphs get /about's treatment instead,
  because two full sentences joined by a middot is unreadable on a phone and
  half the group reads the Spanish first.

  tests/guide-page.test.ts fences the four things that rot: both halves
  present and never identical; fifteen quoted labels asserted present in the
  guide AND in the component they came from, so a rename fails here instead of
  stranding a reader in a hotel lobby; the free allowance asserted equal to
  QUOTAS.free.translations and the language count derived from the catalog;
  and no personal names, same regex list as /about, applied to the source and
  its comments too. nav-completeness gained the share sheet as a third nav
  surface so the next refactor cannot orphan /guide the way /tabletop was.

  Not behind SessionGate — step one of the page is "sign in", so gating it
  would be a door that asks you to read the sign on the other side. No
  screenshots: they go stale silently and this page is read over hotel wifi.

  Still owed, and NOT introduced here: /guide deliberately prints no support
  address. /about already promises support@taoslite.com and that mailbox is
  still not routed; one unfulfilled promise is enough, so the guide links to
  /about rather than repeating it.

- **/api/tts was answering strangers** — every route that spends money now
  asks who is calling. (shipped 2026-08-19)

  Found by a bare curl in the v1.0.0 ship report (cdf9f02a): POST /api/tts on
  production returned 14KB of ElevenLabs audio to a request with no session,
  no cookie and no header. A public URL on Tom's card. /api/translate
  (transcription + a chat completion per turn) was the same, and so was every
  realtime **minting** route — which is worse, because what those hand back is
  a live OpenAI Realtime session that goes on billing long after the response.

  Thirteen routes reach a paid provider. Eleven of them now require a Supabase
  session and refuse without one **before** the provider is called — a 401
  returned after paying ElevenLabs is the same bill with better manners, so
  every test asserts the provider was never reached, not merely the status.
  Six needed the guard added (`/api/tts`, `/api/translate`,
  `/api/live-translate`, `/api/text-translate`, `/api/live/realtime`,
  `/api/tabletop/realtime`, plus `/api/call/realtime` and `/api/tutor/assess`
  behind their RC1 flags); the rest already had it.

  **The front door stays open.** "Try it now, no signup" (/try) is the funnel
  and is *supposed* to work without an account, so `/api/tts` and
  `/api/translate` take a second path: a same-origin check against the
  existing allow-list in lib/authRedirect.ts, a tight per-IP rate limit
  (10/min, 60/hr, plus a per-instance hourly cap), and a ceiling on what may
  be asked for. Be honest about what that is worth — an Origin header is
  forgeable and the counters are per-instance — which is exactly why the
  anonymous path reaches only the CHEAP engine. ElevenLabs, the clones, and
  every realtime session take a real session, no exception. That also matches
  what the free tier already promises on screen: a plain OpenAI voice.

  Three screens (/live, /tabletop, /translate) rendered fine signed out
  because their routes used to let anyone through. They now sit behind
  `<SessionGate>` — the sibling of `<FounderGate>` — so a signed-out visitor
  gets the sign-in screen instead of a working-looking UI that 401s on first
  tap. That is the 8/13 field report /vision was built from, and these three
  had quietly never learned it.

  The guard lives in `lib/spendGuard.ts`; the browser half is
  `lib/authClient.ts`. tests/spend-guard.test.ts pins all of it, and its last
  block is a **sweep**: it reads every route off disk, decides which ones
  spend money (by provider hostname, API-key name, *and* helper import — the
  first draft grepped hostnames only and reported the two routes that spend
  through lib/translateProvider.ts as free), and fails if one of them lacks a
  guard. The original bug was a route nobody remembered was public; a list
  written by hand today would not catch the next one.

- **The storefront stops selling what the app has switched off** — pricing
  copy labelled for the v1.0.0 launch, the last thing between TAOS and a live
  Stripe charge. (shipped 2026-08-19)

  Tutor was pulled from RC1 on 8/18 for good reasons, but the plans are
  *priced* around it: Free/Basic/Premium each sold "15 / 45 / 200 tutor
  minutes / month", the paywall sold +100 and +200 minute add-on packs, and
  the site title called TAOS an "AI language tutor". With /tutor redirecting
  home, every one of those sold a screen the customer could not open. The two
  obvious fixes were both wrong: deleting the line items throws away pricing
  that comes back next week, and turning tutor on ships the half-built thing
  RC1 deliberately cut.

  So the copy is labelled instead, and labelled **from the flag** —
  `tutorComingSoon()` in lib/release.ts is just `!tutorEnabled()`. Every tutor
  promise reads from it: the two feature cards, all eight plan line items, the
  hero sentence, the "upgrade for more tutor time" line, the heavy-user
  footnote, the footer tagline, and the free-plan blurb on the paywall. They
  render greyed with a **Coming soon · Próximamente** badge (bilingual, like
  the /about link — the storefront gets handed to strangers by QR). Nobody has
  to remember to un-edit anything: `NEXT_PUBLIC_ENABLE_TUTOR=1` lifts the
  labels, restores the ✓ ticks and brings back the nav link in one redeploy.

  Two places took a different treatment, both on purpose:

  - **The add-on minute packs are withheld, not badged.** They are the only
    tutor promise on the paywall that moves money. A "coming soon" badge next
    to a button that still charges $9.99 is worse than no badge — so the buy
    buttons render only when tutor is on, with a note in their place.
    `startPackCheckout` and the Stripe price objects are untouched.
  - **The site title and description swap wholesale**, because a `<title>` is
    the one surface a badge cannot sit on. Both wordings live in layout.tsx
    behind `tutorEnabled()`; the tutor version is not deleted, just not
    selected. The shipping title describes what the build does today:
    "Real-time translation for the people in front of you".

  tests/release.test.ts pins the rule rather than the strings — it asserts the
  tags and the flag wiring, not that a given sentence is on screen, because a
  string assertion would pass equally against copy someone hand-edited and
  would go stale the week tutor returns.

- **Table comes back to the nav, and the nav gets a fence** — Tom, 8/19, on
  the Droid walkthrough: the header read Live · Chat · Translate and there was
  no way to reach /tabletop. (shipped 2026-08-19)

  The reported cause was a nav refactor dropping the "Together ▾" menu when
  /chat became a thread list. That is not what happened — the chat-multiples
  commits never touched the nav, and the menu, the Table link and /tabletop
  itself were all still there. /tabletop was simply founders-only by design
  (`HELD_BACK_V1` in lib/release.ts, "niche party mode; every extra screen is
  a day-one support surface"), and the whole Together menu rendered behind
  `{founder ? …}` with customers getting a plain Chat pill instead. Anyone
  reading the nav source saw a Table entry and moved on; only walking it as a
  non-founder showed the hole.

  So this is a scope change, not a repair: **/tabletop left the founders gate
  on Tom's say-so** — out of `HELD_BACK_V1`, page un-wrapped from
  `<FounderGate>`, and one Together menu for everyone. Call and Video stay
  held (still expensive and still heavy), and /tutor stays dark.

  The Together menu was kept rather than promoting Table to a fourth header
  pill: Live · Chat · Table · Translate plus the title and two icons does not
  fit a 360px phone, which is the sideways-slide bug the menu was built to fix
  in the first place. With Call dark the menu opens to Chat · Table.

  `/about` was orphaned the same way and is fixed in passing — Landing.tsx
  links it, but Landing only ever renders for logged-OUT visitors, so signing
  in was a one-way door away from the product page. It is in the account menu
  now.

  The actual deliverable is **tests/nav-completeness.test.ts**, which pins the
  nav instead of the scope list: it enumerates the route directories under
  `app/` and fails unless every one is declared either reachable (linked from
  TranslatorShell or Landing *with the release flags stripped out of the
  source*) or gated (behind its flag, and absent when that flag is off). A new
  screen with no nav entry fails on the day it is added; a screen that slips
  behind a conditional fails the same way. Both halves were mutation-tested —
  re-wrapping the Table link in `{founder ? …}` and adding an unlinked
  `app/` route each turn it red. /tabletop verified on a served production
  build: 200, no "Coming soon", pill row and "More languages · Más idiomas"
  present, while /call and /tutor still 307 home — 2026-08-19, branch
  feat/trip-mode

- **Type & Translate follows the pills** — Tom, 8/19, on the two-phone
  walkthrough: the home screen was happily doing BS⇄EN, and the typing surface
  behind the "Translate" nav pill still said *"You (EN → ES)"*. (shipped
  2026-08-19)

  It was the screen the 8/18 catalog wiring missed. /live, /tabletop and /chat
  were each taken off a private two-language table that day; this one kept a
  `Direction = "en-es" | "es-en"` Record with a label AND a placeholder hanging
  off it, and received only the name scrub. The fence that was supposed to
  catch exactly this listed three screens and not this one — partly because
  two different files are called Translate (`TranslatorShell` is the home
  screen's spoken turns, `TranslateShell` is the typing surface), which is most
  of how it stayed invisible.

  - **The pair is shared, not private.** It comes from `useLanguagePair` now —
    the same pair, off the same key on disk, as the home screen, /live and
    /tabletop — drawn with the same `LanguagePillRow` and `LanguageSheet`, not
    a fork. The You/Them toggle keeps the job it was really doing: the pair
    says which two languages, the toggle says which of the two is at the
    keyboard (`pairDirection`).
  - **The route underneath it too.** `/api/text-translate` spoke the same
    two-string direction and interpolated its own
    `{ es: "Spanish", en: "English" }`, so fixing the screen alone would have
    left the pair stopping at the network boundary. It takes a catalog pair
    now; auto-detect chooses between the two sides it was handed instead of
    between English and Spanish. The legacy string still parses — it is a
    documented contract.
  - **Suggestions stay EN⇄ES, and say so.** The predict model is not a
    language feature, it is Tom & Liz's own history n-grammed, and there is no
    history in Bosnian. `/api/predict/model` used to answer *any* unrecognised
    direction with the English model, which after this change would have
    offered English completions to someone typing Bosnian. It answers a null
    model now — which the engine already reads as "predict nothing" — and the
    screen says *"no suggestions for this pair — typing works as usual"*.
  - **Tier 2 needs nothing extra here.** Text always works; the shared pill
    already draws the muted speaker, and there is no audio control on this
    screen to disappoint.
  - **The sweep found one more.** The history drawer had its own
    `{ en: "English", es: "Español" }`, so a saved Bosnian turn read "bs → en".
    It asks the catalog now.

  Verified against the real API through the route: EN→BS came back
  *"Mnogo mi nedostaješ. Vidimo se sutra."*, EN→BN (tier 2) came back in
  Bengali script, and ES⇄EN is unchanged. The fence now covers every wired
  screen including this one, and names which Translate is which.

- **More than one chat per account** — Tom, 8/19, on the second half of the
  two-phone walkthrough: he opened a second invite on his own app and was
  refused by his own copy, *"You're already in a chat, and TAOS holds one at a
  time."* Verdict: multiples, with history preserved. (PR #24, shipped
  2026-08-19)

  The sentence was honest. `lib/chat.ts` drew the FIRST membership it found,
  `/api/chat/invite` re-used that same first thread forever, and
  `/api/chat/join` 409'd on a second one — so a second membership would have
  looked like the link doing nothing. **The cap was never in the database.**
  `taos_lite_chat_members` is keyed `(thread_id, user_id)` and nothing has ever
  constrained `user_id` alone (checked against `pg_constraint` and `pg_indexes`
  before a line was written — the lesson from the stale `en|es` CHECK, which
  was a ceiling no source read could see). Nothing was dropped and no row was
  touched; the migration is one additive index for the query /chat now asks on
  every load.

  - **A list.** More than one chat opens on it: one row per chat, labelled with
    the other member's **own display name** (their Google name, else their
    email's local part — user identity, never a name this app decided), the
    last message, and a timestamp. One chat still opens straight into itself,
    with a small **"← Chats"** in the header — the account with exactly one
    chat is exactly the one that needs a second.
  - **Every preview is in the language the VIEWER reads in THAT thread.**
    Reading language is per-membership, so two rows of one list can be two
    different languages, and my own message previews as I typed it while
    theirs previews as it was translated for me — the bubbles' rule, one
    screen out. Opening a thread swaps the pill row, "They read", the composer
    promise and the confirmation with it; a language tap writes to that
    thread's row only.
  - **"Start a chat" is always one tap away**, on the list, and always creates
    a NEW thread. Folding it back into an existing empty one would look tidy
    and would retire a QR code somebody is still holding. `threadId` in the
    invite body is what tells "invite into this chat" from "start another",
    and membership is the permission — a threadId off somebody else's screen
    mints nothing.
  - **`GET /api/chat/threads`** backs the list. The rest of /chat reads through
    RLS; this goes through a route because a row needs the other person's name,
    and that lives in `auth.users` where no browser key may look and should
    not — an app that lets one account enumerate another's email is a
    directory, and /chat is the argument against having one. Every query is
    rooted in the caller's own memberships.
  - **`?t=` names the chat.** /chat/join lands on the thread it just let
    somebody into rather than whichever one sorts first, and a reload comes
    back to the conversation that was on screen.
  - **Still two people per thread**, in the route and in the `before insert`
    trigger. Many chats per person; two people per chat. The boat chat is a
    different piece of work — `docs/group-chat-plan.md`.
  - The existing thread is untouched: same rows, same 34 messages, same
    languages. `tests/chat-threads.test.ts` pins the list, the per-thread
    language resolution and the shell wiring; `tests/chat-invite.test.ts`
    pins the removed cap and the two-per-thread one that stayed.

- **/chat had no way in, so a second person could never arrive** — Tom, 8/19,
  two-phone walkthrough: signed in on the second device with a different
  Google account, opened /chat, and was told *"This account isn't part of a
  chat yet. Sign in with your own Google account (not the shared passcode
  account)"* — an instruction to do the thing he had just done, in English
  only, under a live composer whose Send button was disabled with nothing
  saying why.

  Nothing was wrong with his account. There was no flow. `taos_lite_chat_*`
  has SELECT policies and nothing else, and **no route in the app had ever
  created a thread or a membership** — the single row in the database ("Tom &
  Liz", 2026-07-18) was typed into the SQL editor by hand. /chat worked for
  exactly two accounts and dead-ended for every other one that has ever
  opened it. The answer to "can a QR scanner start a chat self-serve?" was
  no, and the founder could not find the flow because there wasn't one.

  Now there is:

  - **"Start a chat · Inicia un chat"** is the empty state. It creates the
    thread and the membership (seeded with the phone's own language from the
    /translate pair) and hands back a **QR + link** in the existing share
    sheet — `components/QrShareModal.tsx` grew props rather than a twin.
  - **The second person opens the link** at `/chat/join/<token>`, signs in if
    they need to, and is in. The invite is a 192-bit url-safe token,
    **single-use** (claimed with a conditional UPDATE, so two phones racing
    produce one member and one honest "already used"), **7-day expiry**, and
    it never decides WHO joins — the Supabase session does, so a leaked link
    can add only the account holding the phone that opens it.
  - **Two people, hard.** The route counts and a `before insert` trigger with
    a `for update` on the thread row counts again, because lib/chat.ts reads
    a thread as "me and the one other member" and /api/chat/send translates
    into exactly one partner language.
  - **"Invite someone · Invita a alguien"** sits next to "No one else in this
    chat yet", so the door is where the sentence about the missing person is.
    Tapping it retires the previous unused link — the one on your screen is
    always the one that works.
  - **Every refusal is now a true statement about the LINK** ("This link has
    already been used", "That chat already has two people in it"), bilingual,
    and none of them says "sign in" to somebody who is signed in.
    `tests/chat-invite.test.ts` pins that, the mechanics, and the schema.
  - **The invites table has RLS on and zero policies** — a browser has no
    business listing tokens; the routes reach it with the service role.

  Also fixed on the way past, because it stood between the invite and the
  preview test: **`authRedirectTarget` returned a bare origin**, and
  Supabase's allow-list entries end in `/**`, matched against the whole URL.
  So a preview origin with no path matched nothing and silently collapsed to
  production — the 8/18 bug, still live on 8/19 with the dashboard already
  edited, one character wide. Asked directly:
  `…vercel.app` → `taoslite.com/`, `…vercel.app/` → itself. Sign-in now
  returns an origin AND a path ("/" by default), which is also how the invite
  survives a signed-out scan: Google brings the stranger back to
  `/chat/join/<token>`, not to the home screen with the token gone.
  `trustedOrigin` keeps the bare-origin job for Stripe's `success_url` and the
  invite link, which append their own paths.

  **Walked end-to-end on the preview, 2026-08-19** — three throwaway accounts
  against the deployed branch, not a local mock, then deleted (the database is
  back to the one hand-seeded thread). A had no thread and no membership, the
  state Tom's second account was stuck in: *Start a chat* → thread + invite
  URL **on the preview origin**; B opened the link, joined, set Spanish; A's
  *"Where should we meet for dinner?"* reached B as *"¿Dónde nos encontramos
  para cenar?"*, and B's Spanish reply reached A in English. Every refusal
  fired as written — reused link 200 *"You're already in this chat"*, guessed
  token 404, no session 401, full thread 409, stranger on a spent link 410,
  second chat 409 — and a third account could read neither the messages nor
  the invites table through RLS. The Supabase probe in
  `docs/supabase-auth-redirects.md` confirms the last leg: a `/chat/join/<token>`
  URL echoes itself back, so a signed-out scanner returns to the invite with
  the token intact, while the bare origin still collapses to production. The
  one thing not exercised is Google itself — the accounts were email/password,
  so the OAuth round trip is still Tom's to tap.
  (2026-08-19, branch `feat/trip-mode`)

- The language row proves itself instead of describing itself — Tom, 8/19,
  third misread of the same control, after the labels above had already
  shipped: **"Spanish stays selected no matter what I select."** The
  screenshot explains it and nothing in it is a bug: HI filled (his choice,
  saved), ES outlined beside it (Liz's, hers to set), grey Spanish under his
  own bubbles (the recipient preview), and not one incoming message in the
  thread. Every word on that screen was true, and none of them CHANGED when he
  tapped, because a solo tester's reading language has nothing to translate.

  So this round adds no words about the setting. It shows it:

  - **The tap answers in the language it just chose.** Pick HI and a system
    line lands in the thread instantly: "✓ अब आप हिन्दी में पढ़ेंगे — You now
    read in Hindi · Ahora lees en hindi". Devanagari on screen is the one
    proof no caption can fake. A hundred sentences ship in the bundle
    (`lib/languages/readConfirmation.ts`, one per catalog language, typed
    `Record<LanguageCode, string>` so a new language cannot skip one) rather
    than a translate call — the proof only lands if it lands under the thumb.
    It is drawn IN the thread, not as a toast, so it survives a glance away,
    and it is taken back if the save turns out to have failed.
  - **The empty-thread case says so out loud**, because it is the state that
    burned him all three times and is the default state of every chat a QR
    code opens: "Nothing to translate yet — messages FROM them will appear in
    हिन्दी". Counted on messages FROM the partner, never on the thread's
    length — his thread was full of his own bubbles.
  - **The grey line under his own bubbles is captioned "They see · Ellos
    ven:"**, per bubble, not once per thread: it is Liz's copy, and
    uncaptioned it reads as the app ignoring the language he picked.
  - **The partner's language left his row.** The outlined ES pill sat in the
    "You read in" row one gap from his filled one, and two marked pills in a
    single-selection row read as two selections however they are shaded. It
    moves to the "They read:" line as a non-interactive chip; the row now
    holds exactly one marked pill. ES keeps a plain pill in the row — "let me
    read Spanish too" is a real thing to want — it just no longer looks
    chosen. `CHAT_PARTNER_PILL_TITLE` went with it (the entry below described
    that pill's tooltip; the pill is gone, the sheet's "Theirs · Suyo" badge
    stays).

  Verified against the real API: an en+hi thread turns "Are you home yet? I
  made dinner." into "तुम घर पहुँच गए हो क्या? मैंने खाना बनाया है।", and the
  confirmation renders in Devanagari in both the solo and the active variant.
  284 tests green (11 new in tests/chat-labels.test.ts).
  — 2026-08-19, branch feat/trip-mode

- /about reads as a product; the dedication is kept, not cut — Tom, 8/19,
  closing the open RC1 question: TAOS is handed to strangers by QR
  code, so the page they land on should be professional. It was a signed
  personal dedication.

  **Preserved first.** The original prose — the title, both paragraphs, "Para
  Liz y su familia en Venezuela", the "— Tom" signature, the "Made for…"
  footer — is in `docs/backstory.md` verbatim, marked as the v1 dedication and
  held for a future "Our story" page. It was moved for being private, not for
  being wrong, and `tests/about-page.test.ts` fails if that file loses it.

  **The new page**, bilingual EN · ES per the app's convention: one paragraph
  on what TAOS is (spoken conversation, messages between two phones, photo
  translation, the catalog's language count), a support line, and the build
  marker. No personal names in the copy, the title, the meta description, or
  the source comments — fenced by regex over both the strings and the file.

  Along the way: `APP_VERSION`/`BUILD_LABEL` moved out of TranslatorShell into
  `lib/version.ts` now that two screens print it, and the landing footer link
  — named "Why we built TAOS" because it reached a dedication — now reads
  "About TAOS · Acerca de TAOS", because it no longer does.

  OPEN: **support@taoslite.com does not exist yet.** Nothing in the repo,
  Stripe's settings, or env defined a support address, so the page now
  promises one that must be created and routed before the QR codes go out.
  (2026-08-19)

- Whose language is this? /chat says it out loud — Tom, 8/19, on the same
  walkthrough that turned up the database ceiling below: he tapped PL on
  /chat expecting to send Polish and his message went out in Spanish. That was
  correct — Liz reads Spanish, and /chat's languages are one per MEMBER — but
  nothing on the screen said so, and the header underneath read
  "Polski → Español" to a man who does not write a word of Polish.

  The model was right; every word around it was wrong. /chat borrows the pill
  row from three screens where a pill means "TRANSLATE INTO", and its own pill
  means nearly the opposite — the language coming IN, to you — under a caption
  reading "You write in · Escribes en". So the fix is all labels and
  affordances, and no change at all to what the routes do:

  - the row and its sheet are captioned **"You read in · Lees en"**;
  - under the row, the other side, sourced from THEIR saved language:
    **"They read: Español · Ellos leen: Español"**;
  - above the composer, what happens to what you type:
    **"Anything you write → Español"**. The left side is deliberately not a
    language — nothing in /chat detects the language of a draft, so naming one
    there was the exact claim that misled him;
  - the partner's outlined pill no longer says "tap to flip" (it doesn't — it
    moves YOUR side onto their language), and the sheet badges it "Theirs ·
    Suyo";
  - the first language tap in a chat, once per phone, gets a dismissible note:
    "This sets the language YOU read. They pick theirs on their own phone."

  Verified against the real API with the route's own code and only auth and
  the database mocked: an en+pl thread turns "Hi love — I'm at the station…"
  into "Cześć kochanie — jestem na dworcu…" (Tom's missing Polish proof), and
  en+es reads exactly as it did in his screenshots. Typing POLISH into an
  en+es thread still comes out Spanish, so the member language really is only
  a soft hint to the prompt — with one exception, now an Idea below: when both
  members read the SAME language the send route skips translation entirely, so
  a message typed in a third language arrives untranslated.
  tests/chat-labels.test.ts holds the words.
  — 2026-08-19, branch feat/trip-mode

- /chat can leave English and Spanish — tapping PL on /chat came back "Could
  not save the language." while /translate on the same phone was doing EN⇄PL
  happily. Nothing in the TypeScript was wrong: `POST /api/chat/language`
  already validated through `isSupportedLanguageCode`, the shell already drew
  all hundred pills, and the send/voice routes already interpolated the
  catalog's English label. The ceiling was in the DATABASE.
  `taos_lite_chat_members.lang` had carried `check (lang in ('en','es'))`
  since chat tier 1 landed (2026-07-18), when two languages was the whole app.
  When the catalog went 13 → 100 every list in the code came down and this
  one — the one no amount of reading the repo would find — did not. A valid
  code passed every check the app could see, reached Postgres, and came back
  23514, which the route honestly reports as a save failure.

  The replacement constraint is a SHAPE check (`lang ~ '^[a-z]{2,3}$'`), not a
  membership list. A hundred codes enumerated in the schema would be a second
  catalog needing a migration every time someone adds a row to the first one,
  which is the failure being cleaned up here; the app owns which languages
  exist and the database only insists the column holds something a translation
  prompt can safely interpolate. Migration recorded at
  `supabase/migrations/20260819_chat_members_lang_catalog.sql` and applied to
  the project.

  tests/chat-language.test.ts is the new fence, and it reads the migrations as
  well as the route — the schema was the one place a language list could hide
  where no source-reading test was looking. It fails if any migration re-pins
  a language column to a fixed set, and it checks every catalog code against
  the shape constraint, so adding a language can never again break /chat for
  it alone. Verified on the live database: `pl` (tier 1) and `bn` (tier 2)
  both save, prose and `not-a-language` are still refused, Tom and Liz's rows
  restored to en/es. Tier 2 in chat is unchanged and correct — text-only is a
  property of synthesis, asked at `requestSpeech`, never a reason a language
  cannot be saved on a thread.
  — 2026-08-19, branch feat/trip-mode

- Stripe can only send you back somewhere we own — the same open-redirect hole
  as the sign-in bug below, one floor down. `/api/stripe/checkout`, `/pack` and
  `/portal` built `success_url` / `cancel_url` / `return_url` by concatenating
  the request's own `Origin` header, which the caller picks. Anyone who could
  reach those routes could mint a real Stripe session that drops the customer on
  their host the moment checkout finishes — a convincing place to ask for the
  card details Stripe just took, with our checkout page as the referrer. All
  three now run the header through `trustedOrigin` in `lib/authRedirect.ts`: the
  same allow-list Google sign-in uses, deliberately not a second copy, since an
  origin we won't hand a session to isn't one we should bounce a payment
  through. The `?? new URL(req.url).origin` fallback went with it — that host
  came from the same untrusted request, so it was never the safer branch, and
  `fetch` sends `Origin` on same-origin POSTs anyway.
  Buying on a preview still comes back to that preview; production and `www`
  are byte-identical to before. tests/stripe-origin.test.ts is route-level on
  purpose — the allow-list is already pinned next door, what needed a fence is
  that these three routes still run the header *through* it.
  — 2026-08-18, branch feat/trip-mode

- Google sign-in comes back to the deployment you left from — signing in on a
  preview landed you on production, silently, so a tester walking through the
  branch was walking through prod. Supabase never honored the return address
  the app asked for: it checks `redirectTo` against the project's Redirect URLs
  list and, on no match, substitutes the Site URL without saying so. That list
  held production and nothing else, so previews, `www` and localhost all
  collapsed to taoslite.com — which is also why this was never caught while
  developing (Google sign-in has never worked on localhost either; the passcode
  is what everyone uses there).
  **Tom, one dashboard step — no code change can do it: Supabase → project
  `duqkmuaceklnfgvoufrz` → Authentication → URL Configuration → Redirect URLs,
  add the five patterns in `docs/supabase-auth-redirects.md`** (the load-bearing
  one is `https://taos-lite-*-xdrabbits-projects.vercel.app/**`). That doc also
  has a one-command check that reads the auth server's answer back without
  needing a phone. Google Cloud Console needs nothing — previews talk to
  Supabase, not to Google.
  The code half (`lib/authRedirect.ts`) is the guardrail rather than the fix:
  the app only ever asks to return to a host on a pinned allow-list, so
  widening the dashboard list can't turn the sign-in button into an open
  redirect. The `-xdrabbits-projects` suffix is the security boundary — anyone
  can name a Vercel project `taos-lite`, only Tom can deploy into his scope —
  and tests/auth-redirect.test.ts fences both directions: every real preview
  hostname shape accepted, and the string tricks (`taoslite.com.evil.com`,
  `https://taoslite.com@evil.com`, `/@evil.com`) rejected to production.
  — 2026-08-18, branch feat/trip-mode

- The whole catalog on every screen — /live, /tabletop and /chat could reach
  two languages between them; now they reach all hundred, with the same pill
  row and the same search sheet /translate has. The picker is drawn once
  (components/LanguagePicker.tsx) and the pair is held once
  (lib/translate/useLanguagePair.ts), so the languages you set while ordering
  dinner are the languages waiting on the next screen.

  The direction differs per screen and that is the point. /translate speaks
  INTO the other language; /live listens OUT of it (they talk, you read your
  own); /tabletop does both, turn by turn, one end of the phone each. Same
  pair, same solid pill — "the other language in play" — with each screen
  captioning its own row so nobody has to infer it.

  /chat is deliberately not on the shared pair: a chat language belongs to
  the MEMBERSHIP row, because the person it matters to is on the other phone.
  It gets the same row over a database write (new POST /api/chat/language),
  and can only ever change your own side.

  Streaming was the thing not to break, and it was not: every language on
  /live's hot path is read through a ref rather than the render closure, so
  changing one cannot re-create the recognizer's handlers or re-arm the
  interim flush mid-conversation. Chunking, debounce, the response gate, the
  freshness windows and turn handling are unchanged. Five hard-coded language
  tables came out (/live's DIRECTIONS + TARGETS + TTS_LANGS, /tabletop's
  direction string, both chat routes' {en,es} label maps — an Italian chat
  thread had been asking the model to "translate into it"), and
  tests/screen-language-wiring.test.ts reads the source and fails if any of
  them grow back.

  Verified against the live APIs, not just in tests: real gpt-realtime
  sessions summarizing an Italian dinner into English and an English one into
  Thai, /tabletop interpreting both ways between English and Italian, ES⇄EN
  re-checked on both, and /api/tts answering audio for Italian and its 422
  `{textOnly:true}` for Thai — which the app renders as quiet, never an
  error — 2026-08-18, branch feat/trip-mode

- Every language, two taps — /translate was rationed to six languages by a pill
  row that could not grow (EN · ES · BS · IT, with ZH/YUE behind "Other"), and
  a 13-language allow-list on the server that a seventh pill would have died
  against. Both are gone. The row now holds the pair plus recently used, capped
  at five, and a "+ More · Más" opens a search sheet over the whole catalog —
  type any of a language's names (its own, English, or Spanish; accents
  optional) and tap it. Picking one pins it and pushes the oldest off, so the
  row becomes whatever trip you are actually on. It does not reorder as you
  tap: position comes from the catalog, because a row that reshuffles between
  two turns is how you tap Italian and get Bosnian across a table. See the
  language-tier note below for what "every language" means and how to add one
  — 2026-08-17, branch feat/trip-mode

- Photos come back in YOUR language — /vision used to run on its own "Auto ·
  EN ↔ ES" rule, so Liz photographing a Bosnian menu got English. It now
  starts on the language the /translate pills already saved on that phone
  (the pair is [yours, theirs]; the photo target is YOUR side), which carries
  Bosnian and Italian to photos with no new picker. The source language is
  still never asked for — the model reads it off the image, which is the only
  thing that works when the sign could be Bosnian, Croatian, or Serbian. The
  "Read it in" dropdown stays as a per-photo override (useful if the last
  person holding the phone flipped the pair) and deliberately does not write
  the pair back. Verified against the real API on rendered photos: a Mostar
  menu → English and → Spanish, a Firenze pharmacy sign → English and →
  Spanish, plus the EN⇄ES photos both directions — 2026-08-17, branch
  feat/trip-mode
- Personal voices are Tom & Liz only — the cloned ElevenLabs voices used to
  play for anyone who opened TAOS, which stops being fine the moment the QR
  code is handed around on the trip. Now /api/tts resolves a clone only for a
  request carrying the right `x-taos-voice-key`; every other phone silently
  gets the stock multilingual voice (no error, no hint the clones exist).
  **Tom, before the trip: set `TAOS_PERSONAL_VOICE_CODE` in the Vercel
  project (`taos-lite`) for BOTH Production and Preview** — pick something
  long and random, there is no rate limit in front of the check, and while it
  is unset NOBODY gets a cloned voice (it fails closed on purpose). Then on
  each of your two phones: **tap the TAOS·LITE title five times** and type the
  code; the sheet shows "✓ Unlocked on this phone" and has a "Lock this phone
  again" button. The code lives in that phone's localStorage, so clearing
  site data re-locks it. Nothing on screen advertises the gesture.
  — 2026-08-17, branch feat/trip-mode
- The tier-2 degrade on every screen — /chat, /live, /tabletop and /tutor
  now reach /api/tts through one shared `requestSpeech` (lib/tts/speech.ts)
  that asks the catalog first and treats the route's 422 `{textOnly:true}` as
  silence rather than an error, so a text-only language is never a red banner.
  The "Text only" mark is one component (components/TextOnly.tsx) shared with
  /translate. (The note that used to end this entry — "those three screens are
  still hardcoded EN⇄ES, so this is a fence waiting for them" — came true the
  same day: see "The whole catalog on every screen" below.) — 2026-08-18,
  branch feat/trip-mode
- Trip mode for Bosnia + Italy — three things in one branch: TAOS is
  installable (Add to Home Screen, standalone, real icon), a QR share modal
  behind one header button hands the app to someone across a table, and
  /translate's picker is now one pill per LANGUAGE (EN · ES · BS · IT, guests
  one tap deeper) with Bosnian and Italian wired through detect → translate →
  voice — 2026-08-17, branch feat/trip-mode
- v1 release gate — customers see Translate, Live, Chat, Tutor, Photo;
  Call/Tabletop/Video show "Coming soon" and hide from nav unless the
  signed-in email is a founder (Tom hardcoded; Liz via
  NEXT_PUBLIC_FOUNDER_EMAILS) — 2026-08-18, PR #23
- Photo translator (/vision) — camera or photo library → text read and
  translated, Auto EN↔ES or any supported language, no-guess fence on
  blurry text — 2026-08-17, PR #21
- Two-button pair picker on /translate — EN⇄ES stays its own button, all
  other pairs fold into "Other · Otros" (Tom's call: the row was growing
  with every language) — 2026-08-16, PR #20
- Always-Detailed on /translate — Casual/Detallado toggle removed (Liz's
  call: it kept getting forgotten and casual summarized too much) —
  2026-08-15, PR #19
- Cantonese: ZH⇄YUE + EN⇄YUE pairs, colloquial written form, v3 voice —
  2026-07-25, PR #9
- Multi-language phase 1: language-pair picker with Mandarin — 2026-07-25, PR #8
- Regression fence: first test suite + CI on every PR — 2026-07-25, PR #7
- Call hold-on indicator (interpreter still speaking on their phone) —
  2026-07-24, PR #2
- "Load failed" hardening, tabletop voices, nightly predict fix — 2026-07-22, PR #1
