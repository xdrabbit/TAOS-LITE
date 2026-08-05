# TAOS Tutor Sprint 1 Status

This file is the live completion checklist for the mirrored ten-day Tutor milestone.

## Complete

- [x] Root AGENTS.md and architectural guardrails
- [x] Formal Sprint 1 design document
- [x] Mirrored course model for Tom Spanish 1 and Liz English 1
- [x] Day 1 through Day 10 curriculum records in both directions
- [x] Course and day navigation
- [x] Remembered learner/day/drill position
- [x] Target-language text-to-speech
- [x] Mirrored pronunciation-assessment backend
- [x] Standalone speech lab
- [x] Deterministic mastery transitions and review-queue logic
- [x] Embed hear, slow-hear, speak, score, coach, and retry inside the daily lesson flow
- [x] Persist mastery and review state locally on the learner's device
- [x] Surface a daily review queue mixing due, weak, recent, and retention items
- [x] Render mini-dialogues as guided teacher/learner turns
- [x] Build a distinct Day 7 consolidation conversation
- [x] Build a distinct Day 10 performance conversation
- [x] Add contextual study-word links and in-app deep-dive cards
- [x] Localize the mirrored learner controls and teaching cues

## Remaining before Sprint 1 is done

- [ ] Editorial pass on every lesson: natural teaching language, 5–8 strong anchors, richer substitution, and memorable takeaway
- [ ] Persist mastery and review state for signed-in learners across devices, retaining local fallback
- [ ] Full validation: `npm run validate:tutor`
- [ ] Tom pass through Days 1–10
- [ ] Liz no-instructions usability test

## Recommended closeout order

1. Complete the editorial pass across both mirrored courses.
2. Add signed-in mastery synchronization behind the existing local store.
3. Run the full Sprint 1 validation command and resolve every failure.
4. Tom completes Days 1–10 and records usability/content notes.
5. Liz completes a no-instructions test in Spanish UI.
6. Reconcile findings, close Sprint 1, and only then open Sprint 2.

Sprint 1 is not complete until every unchecked item above is resolved or explicitly descoped in the design document.
