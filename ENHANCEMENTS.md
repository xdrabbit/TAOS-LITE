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
  → Tutor pulled from RC1 2026-08-18 (second cut): it is unfinished and is
  planned as a PREMIUM feature, so it is gated behind
  NEXT_PUBLIC_ENABLE_TUTOR (lib/release.ts), off by default. Hidden from
  everyone including founders — nav link gone, /tutor redirects to /, and
  all three /api/tutor routes 404 so a disabled feature cannot bill OpenAI
  realtime or Azure. Nothing was deleted; set the var to 1 and redeploy to
  bring it back.
- ⚠️ The pricing page still sells tutor minutes — BLOCKS charging anyone.
  Landing.tsx and Paywall.tsx advertise "15 / 45 / 200 tutor minutes /
  month" on every plan, lib/stripe.ts sells add-on minute packs, and
  layout.tsx's site title and description say "AI language tutor". With
  tutor gated off, all of that sells something the app will not do. Pick one
  before the first real charge: rewrite the plans around translation limits,
  or turn tutor back on for paying tiers only. This was the exact reason
  tutor was kept in v1 on 8/18 (tests/release.test.ts said so), so pulling
  it reopened the question rather than settling it. (added 2026-08-18)
- Chat push notifications (tier 2) — phones buzz when a message lands while
  the app is closed. Planned since chat tier 1 shipped. (added 2026-08-03)
- Call cost guards — /call bills two realtime sessions the whole time it's
  connected, silence included: auto-hangup after ~10 min with no speech,
  shrink the 4h hard cap to ~90 min, show an elapsed/cost timer on screen.
  (added 2026-08-03, from the July 14/22 OpenAI bill spikes)
- Cantonese field verdict — have the Cantonese-speaking guest judge the v3
  voice and the zh⇄yue auto-detection; swap ELEVENLABS_YUE_MODEL or tune the
  detect prompt based on her review. (added 2026-08-03)

## Ideas

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
- The /about dedication — Tom's call, deliberately left alone. RC1 stripped
  first names from every label a stranger reads (the speaker card, the two
  direction toggles, the landing footer link, which now reads "Why we built
  TAOS"). /about was NOT touched: it is signed, authored prose — "Made for
  Lizmariett Marquez", the two paragraphs, "— Tom" — and that is a dedication,
  not a leftover label. It is still linked from the landing footer and its
  page title still carries the full name, so a stranger who taps it reads it.
  Keep it as is, soften it, or move it behind a founders-only link — but that
  is Tom's to decide, not a cleanup. (added 2026-08-18)

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
