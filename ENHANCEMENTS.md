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
  cost guards.
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
- Chat push notifications (tier 2) — phones buzz when a message lands while
  the app is closed. Planned since chat tier 1 shipped. (added 2026-08-03)
- Call cost guards — /call bills two realtime sessions the whole time it's
  connected, silence included: auto-hangup after ~10 min with no speech,
  shrink the 4h hard cap to ~90 min, show an elapsed/cost timer on screen.
  (added 2026-08-03, from the July 14/22 OpenAI bill spikes)
  → /call is GATED OFF for RC1 (2026-08-18) behind NEXT_PUBLIC_ENABLE_CALL
  (lib/release.ts), dark to everyone including founders: nav link gone, /call
  redirects home, POST /api/call/realtime 404s. The trigger was not cost but
  the language catalog — when the 100 languages landed (1711a3f4), /live,
  /tabletop and /chat were wired to the catalog and **/call was not**. It
  still takes a hardcoded `"en" | "es"` target and builds an English/Spanish
  interpreter prompt, so on a trip with the pair set to, say, [en, it] the
  call screen interprets into the wrong language. It has also never been
  walked end-to-end with two phones. Before the flag goes back on:
  1. Wire CallShell to `useLanguagePair()` like the other three screens.
  2. Make `buildCallInterpreterInstructions` take a language pair instead of
     `TargetLang`, and drop the `en`/`es` name table with it.
  3. Land the cost guards above — the client-side duration cap in
     lib/call/interpreter.ts is on the wrong side of the wire for an
     unauthenticated minting route.
     → The AUTH half is done (see Shipped, 8/19): POST /api/call/realtime
       now requires a session on top of the 404. The DURATION cap is still
       client-side and still owed — auth says who may start a call, not how
       long it may bill.
  4. Two phones, two networks, one real conversation.
  Flag on restores the *previous* behavior exactly, founders gate included —
  it does not ship /call to customers. Nothing was deleted.
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
  real module id. Also noted: `taos_lite_predict_models` still carries
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
- Multi-language phase 3 — /call is the last screen still hardcoded EN⇄ES.
  (Phase 2 — /tabletop, /live and /chat — SHIPPED 2026-08-18, see Shipped.)
  /call is two realtime sessions pointed at each other, so it needs the pair
  on BOTH phones and a way for each end to know what the other picked;
  that handshake is the actual work, not the picker. (added 2026-08-03,
  narrowed 2026-08-18)
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
