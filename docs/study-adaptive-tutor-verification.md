# Adaptive tutoring from Study

Study keeps its sentence explanations, build-up ladders, Hear it / Slowly,
Say it recording, Azure assessment, saved attempts and best scores. When the
existing `NEXT_PUBLIC_ENABLE_TUTOR` flag is enabled, each sentence and ladder
rung also offers **Practice with Tutor** (Spanish label for Spanish explanations).

The entry opens the existing metered voice tutor using a lesson key and
sentence/rung indices. The mint route reads that saved lesson scoped to the
signed-in user and validates its language pair and indices before reserving
minutes. The browser does not supply lesson text to the mint. Sentence meaning,
grammar explanations, word notes and ladder remain available to the tutor even
when entering from a short phrase. Missing saved lessons fail with a return-to-
Study message; ordinary Partner, Walk and Run retain their existing personas.

Partner opened directly now includes a **Prepared Study sentence** chooser. It
lists owned sentences matching the current learning/explanation language pair;
selecting one shows the prepared sentence before starting and uses the same
contextual tutoring loop as a Study link. Free conversation remains an explicit
choice. Flipping the pair clears the old selection. If that account has no saved
lesson for the pair, the chooser links back to Study to prepare one.

Opening a saved Study lesson synchronizes the displayed language selectors to
that lesson without rewriting device preferences. Changing the pair while a
lesson is open returns to the picker instead of presenting an old lesson under
misleading language labels.

Study-link entry now reads the owned saved lesson before Start, displays the
selected sentence/phrase and parent meaning, and keeps Start disabled until
loading succeeds. Missing lessons, wrong language pairs and changed content
produce a specific recovery message before microphone acquisition. The sentence
fingerprint recursively sorts object keys because PostgreSQL JSONB can reorder
fields on save; array order and actual content changes still matter. After this
fingerprint correction, reopen an old sentence from Study to obtain a fresh link.

## Teaching and support languages

The learned/taught language is used for phrases, learner answers and practice
prompts, increasingly for teaching as successful answers accumulate. The
explained-in language is used for hints and support. An English lesson explained
in Spanish uses English teaching and Spanish hints; the reverse uses Spanish
teaching and English hints. Help preserves the pending objective and retry.

Automatic Study learner turns require a structured evaluation first; the app
applies it before requesting the spoken reply. This keeps recorded progress and
the next spoken objective aligned. A correct meaning/tense is not blocked by an
imperfect accent, and pronunciation drills remain separate in Azure Say it.

## Teaching loop and memory

- Exactly one practice prompt per tutor turn, then wait for the learner.
- Brief explanations and grammar questions stay connected to the selected phrase.
- Construction is evaluated separately from pronunciation. Azure scores remain
  in Study's Say it; realtime transcripts do not confer pronunciation mastery.
- A structured realtime tool reports correct, partial, incorrect or ambiguous
  construction/transfer answers. The app owns progression: partial/incorrect
  answers keep the current stage and require retry; correct construction moves
  to transfer. Ambiguous speech, acknowledgments and grammar questions earn no
  mastery. Duplicate tool calls and calls without another learner turn earn no
  extra progress. Cancelled/incomplete responses do not apply evaluations.
- The tutor corrects the smallest meaningful error and waits for the same
  objective to be retried. Transfer changes one element of the same pattern.
  Beginner/intermediate/advanced choices determine scaffolding; repeated errors
  simplify the ladder and successes allow harder variants.
- Account-scoped, per-lesson/sentence/rung local storage records stage, retry,
  attempts, successes, last error, pending retry prompt and update time. Reloads
  resume this context. It follows this device, not other devices. Private-mode
  storage failures do not block practice. Pronunciation persistence is unchanged.

The model judges semantic correctness and chooses explanations/prompts. The app
controls the progression state, but prompt quality still needs a live voice
review. These progress counters are practice feedback, not a certified skill
assessment. Regenerating a lesson under the same key can alter its sentence or
rung indices; a content fingerprint isolates progress and rejects stale links.

## Mocked validation

New tests cover context references, owned cache retrieval, language mismatch,
invalid selection, auth/feature gates, mint failure settlement, ordinary partner
compatibility, construction/retry/transfer progression, malformed/duplicate tool
events, account isolation, corrupt/private-mode storage, and rendered Study
controls with the feature on/off. No OpenAI or Azure requests are made by tests.

Validated locally:

- `npm run typecheck`
- `npm run lint`
- `NODE_OPTIONS=--no-experimental-webstorage npm test`: 105 files passed;
  1,710 tests passed, 9 skipped. Local Node 26's global Web Storage otherwise
  interferes with existing jsdom tests. CI uses Node 22.
- `npm run build`

On macOS, `npm ci --ignore-scripts --force` was needed because the existing
package manifest directly depends on Linux SWC. No dependency/lockfile changes.

## Tom's voice review after preview deployment

1. Open Partner directly from an English account. Set learning to English and
   explanation to Spanish; choose an English sentence in **Prepared Study
   sentence**. Confirm it appears before Start and is what the tutor teaches.
   Switch back to Spanish and check that the old selection clears and only
   sentences for the new direction are offered.
2. With the existing tutor flag on and a signed-in account, open a saved Study
   sentence. Confirm all explanations, ladder rungs, audio and Say it remain.
2. Choose Practice with Tutor on a sentence, then separately on an early rung.
   Confirm the language pair, selected phrase and its parent meaning are used.
3. Select Beginner; start. Confirm one short prompt followed by silence for an
   answer. Ask why `haya traído` is used instead of `trajo`; expect a brief
   contextual explanation and return to the current practice objective.
4. Give a partially correct answer. Expect one small correction and a retry of
   the same meaning. Answer correctly; expect a variation changing one element.
5. Make an error in that variation. Expect transfer retry, not a new pattern.
   Say an ambiguous phrase or acknowledgment; it must not count as mastery.
6. End and reload. Confirm the current stage/error/pending retry resumes. Sign
   out and use another account: this account must not inherit those results.
7. Return to Study and use Say it. Confirm real Azure scoring still works and
   remains distinct from construction/transfer feedback.
8. Try an unavailable selection and exhausted tutor balance; expect actionable
   errors with no successful mint. With tutor disabled, the added links disappear.

No deployed configuration, database schema or credentials were changed. Do not
merge until the live voice review is satisfactory.
