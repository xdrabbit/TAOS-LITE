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
- `NODE_OPTIONS=--no-experimental-webstorage npm test`: 102 files passed;
  1,698 tests passed, 9 skipped. Local Node 26's global Web Storage otherwise
  interferes with existing jsdom tests. CI uses Node 22.
- `npm run build`

On macOS, `npm ci --ignore-scripts --force` was needed because the existing
package manifest directly depends on Linux SWC. No dependency/lockfile changes.

## Tom's voice review after preview deployment

1. With the existing tutor flag on and a signed-in account, open a saved Study
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
