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
- [x] Complete the editorial pass across all ten mirrored lessons with stronger anchors, substitutions, takeaways, usage guidance, and curriculum-quality tests
- [x] Persist mastery across signed-in devices with deterministic merge behavior, local/offline fallback, Supabase RLS, and a reproducible migration
- [x] Add focused Tom and Liz Sprint 1 acceptance checklists

## Remaining before Sprint 1 is done

- [ ] Automated release gate confirmed green: typecheck, lint, Vitest, and production build (`npm run validate:tutor` or equivalent CI + Vercel gates)
- [ ] Tom pass through Days 1–10
- [ ] Liz no-instructions usability test

## Release-candidate gate

Draft PR #16 is the Sprint 1 release candidate. Do not merge it until:

1. The automated release gate is green.
2. Tom completes Days 1–10 and records any blocking usability/content findings.
3. Liz completes the Spanish-UI no-instructions acceptance pass.
4. Blocking findings are fixed; non-blocking ideas are recorded in `ENHANCEMENTS.md` or Sprint 2.

Sprint 1 is not complete until every unchecked item above is resolved or explicitly descoped in the design document.
