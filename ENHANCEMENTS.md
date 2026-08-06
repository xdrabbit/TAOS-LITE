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
- Multi-language phase 2 — bring the language-pair picker to /tabletop
  (most likely place to meet strangers). Phase 3: /live and /call. (added
  2026-08-03)
- Guest voice clones — quick-clone a recurring guest so their translations
  play in their real voice instead of the stock one. (added 2026-08-03)
- Use lib/net's fetchWithRetry in /chat and /live fetches — /translate,
  /tabletop already have it; extend if "Load failed" is ever seen there.
  (added 2026-08-03)
- Decide the fate of the stale `dev` branch — merged-history only or does it
  hold anything worth keeping? (added 2026-08-03)

## Shipped

- Cantonese: ZH⇄YUE + EN⇄YUE pairs, colloquial written form, v3 voice —
  2026-07-25, PR #9
- Multi-language phase 1: language-pair picker with Mandarin — 2026-07-25, PR #8
- Regression fence: first test suite + CI on every PR — 2026-07-25, PR #7
- Call hold-on indicator (interpreter still speaking on their phone) —
  2026-07-24, PR #2
- "Load failed" hardening, tabletop voices, nightly predict fix — 2026-07-22, PR #1
