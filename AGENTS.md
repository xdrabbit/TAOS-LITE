# AGENTS.md

## Repository authority

GitHub is the source of truth for TAOS-LITE. Work from the current target branch, inspect existing code before changing it, and keep commits small enough to review. Do not treat a local checkout, deployment, chat transcript, or generated artifact as authoritative when it conflicts with the repository.

## Product context

TAOS-LITE is a shared-phone English ↔ Spanish translator with an evolving Tutor product.

The Tutor must become a reusable teaching framework that can host mirrored first-year courses:

- Spanish 1 for Tom, whose native language is English.
- English 1 for Liz, whose native language is Spanish.

The two courses must share pedagogy, progression, data structures, review logic, and interaction patterns. They may differ in explanations, pronunciation coaching, examples, cultural notes, and language-specific grammar.

The initial curriculum horizon is 90 days. This is not merely a larger phrase pack. It combines traditional first-year language structure with intensive practical recall.

## Learning model

Each course should blend these strands throughout the 90 days:

1. Traditional first-year grammar and structure.
2. Memorized real-life sentences worth using immediately.
3. Substitution drills that preserve a pattern while changing vocabulary, person, tense, number, possession, location, or intent.
4. Active recall before recognition.
5. Spaced review across lessons, weeks, and milestones.
6. Listening and pronunciation practice.
7. Short guided conversations that reuse mastered material.
8. Periodic cumulative checks that reveal weak patterns and feed them back into review.

Teach grammar as a usable control system, not as disconnected terminology. Explain enough structure to let the learner generate new sentences, then immediately exercise it through speech and recall.

## Mirrored-course requirement

Do not hard-code the Tutor around English as the only target language.

Course identity must be explicit and data-driven. At minimum, model:

- learner identifier or profile;
- native language;
- target language;
- course identifier;
- day and lesson identifiers;
- explanation language;
- target phrases and source-language support;
- pronunciation locale;
- grammar objective;
- vocabulary objective;
- drill type;
- review metadata;
- progress and attempt history.

Shared components and services should accept course configuration rather than branching on Tom or Liz throughout the UI.

The mirrored courses should align conceptually where useful, but they do not need mechanically identical wording. Spanish and English have different high-value early structures and different pronunciation hazards.

## 90-day structure

Treat the course as three 30-day arcs:

- Days 1–30: survival language and the present-tense skeleton.
- Days 31–60: expansion into past/future reference, description, possession, comparison, object relationships, and broader real-life scenes.
- Days 61–90: integration, faster recall, conversation repair, cumulative review, and practical independence.

Use weekly rhythm where practical:

- several days of new material;
- interleaved review every day;
- one consolidation or performance day per week;
- milestone checks near days 30, 60, and 90.

A lesson should remain short enough for normal daily use while supporting optional deeper practice.

## Lesson contract

Prefer a structured lesson model over parsing arbitrary Markdown conventions into application behavior.

A daily lesson should be able to represent:

- title and communicative goal;
- grammar focus;
- vocabulary set;
- memorable anchor sentences;
- substitution frames and slots;
- recognition prompts;
- recall prompts;
- listening prompts;
- pronunciation targets;
- mini-dialogue or real-life scene;
- spaced-review references to prior material;
- completion criteria;
- optional cultural or usage note.

Content may remain author-friendly in Markdown or another source format, but parsing must produce a validated typed structure. Content errors should fail clearly during development or build rather than silently disappearing in the UI.

## Review and mastery

Do not equate lesson completion with mastery.

Design progress so the system can distinguish at least:

- introduced;
- recognized;
- recalled with help;
- recalled independently;
- spoken acceptably;
- due for review;
- repeatedly missed.

Spaced review should be deterministic and inspectable before becoming adaptive. A simple, well-tested schedule is preferable to opaque pseudo-intelligence.

Review queues should mix:

- recent material;
- older due material;
- weak items;
- occasional mastered items for retention checks.

Persist enough attempt detail to improve later scheduling without coupling the first implementation to a specific future algorithm.

## Existing Tutor implementation

Before replacing anything, preserve and evaluate useful pieces already present:

- `app/tutor/page.tsx`
- `components/TutorShell.tsx`
- `app/api/tutor/lessons/route.ts`
- `app/api/tutor/realtime/route.ts`
- `app/api/tutor/assess/route.ts` when present
- `lib/tutor/parseLessons.ts`
- `lib/tutor/conversation.ts`
- `lib/tutor/wav.ts`
- `content/tutor-course/`
- Tutor persistence and usage helpers in `lib/supabase`

The current implementation includes pronunciation drills, conversation mode, lesson loading, account/tier integration, usage accounting, and saved attempts. Refactor deliberately. Do not discard working microphone, scoring, billing, authentication, or realtime behavior merely to make the curriculum model cleaner.

Known current limitation: the drill flow is substantially English-targeted, including English reference text and `en-US` pronunciation scoring. Correct this through course configuration rather than duplicating the entire Tutor shell.

## Teacher behavior

The Tutor should behave as a teacher, not a flashcard viewer.

It should be able to:

- introduce a pattern briefly;
- model it;
- ask the learner to repeat;
- remove visual support;
- ask for recall;
- vary one element at a time;
- correct selectively without derailing momentum;
- recycle a missed item later;
- conduct a short scene using learned material;
- end with a clear sense of progress and what returns next.

Avoid long lectures in the primary lesson flow. Deeper explanations may be available on demand.

## Voice and avatar hooks

Teacher voice and avatar presentation are future layers, not prerequisites for the curriculum engine.

Keep clean extension points for:

- teacher persona metadata;
- target-language voice selection;
- native-language explanation voice;
- speech rate;
- facial/avatar state cues;
- scripted and generated teacher turns;
- timing events for future lip-sync or animation.

Do not bind curriculum records directly to one voice vendor or avatar provider. The lesson/session engine should emit semantic teacher actions that presentation adapters can render later.

## Architecture guidance

Favor separation among:

- course content;
- validated course schema;
- lesson/session state machine;
- review scheduling;
- speech capture and assessment;
- persistence;
- presentation;
- future teacher voice/avatar adapters.

Keep server-only secrets and vendor credentials out of client bundles.

Use TypeScript types at boundaries. Validate untrusted request bodies and parsed curriculum content.

Prefer small pure functions for scheduling, drill generation, substitutions, and mastery transitions so they can be tested without a browser or external APIs.

Avoid premature platform-building. Build the smallest framework that can run both mirrored courses correctly, then expand.

## UX constraints

TAOS-LITE is primarily used on iPhone and may be shared across a table.

Preserve:

- large tap targets;
- clear speaker/learner identity;
- readable text;
- safe-area handling;
- resilient microphone state;
- simple recovery from interruption;
- minimal navigation during a lesson;
- clear English/Spanish directionality.

The learner should always know:

- who the lesson is for;
- which language they are learning;
- what to say or do next;
- whether the Tutor is listening, scoring, speaking, or waiting;
- how to repeat, slow down, get a hint, or continue.

## Content and tone

Use natural contemporary English and broadly understandable Latin American Spanish unless a lesson explicitly teaches a regional distinction.

Examples should come from real life: home, food, schedules, shopping, travel, family, health, work, directions, requests, feelings, and shared daily routines.

Do not make every example romantic or relationship-specific. Personalization may enrich the course, but the framework and core curriculum must remain reusable.

Avoid crude stereotypes and literal translations that sound unnatural.

## Commands and quality gates

Install and run with the repository scripts:

```bash
npm install
npm run dev
npm run lint
npm run typecheck
npm test
npm run build
```

Before considering an implementation task complete, run the relevant checks. For framework changes, the default expectation is:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

When external credentials prevent end-to-end speech testing, test pure logic and API validation locally, then document what still requires a configured environment and secure browser context.

## Testing expectations

Add or update tests for:

- course parsing and validation;
- mirrored language configuration;
- substitution generation;
- lesson state transitions;
- review scheduling;
- mastery updates;
- API request validation;
- regressions in microphone/session logic where practical.

Do not rely exclusively on snapshots for learning logic. Assert meaningful behavior.

## Branch and commit discipline

The mirrored 90-day Tutor work begins on:

`feature/mirrored-90-day-tutor`

Keep unrelated translator changes out of this branch unless they are required for shared infrastructure.

Use clear commit messages that describe one conceptual change. Do not rewrite published branch history unless explicitly requested.

## Immediate implementation order

Unless a later task explicitly changes priorities, proceed in this order:

1. Document the existing Tutor architecture and identify reusable versus hard-coded pieces.
2. Define typed course, lesson, drill, review, and learner-progress models.
3. Introduce mirrored course configuration for Tom Spanish 1 and Liz English 1.
4. Make the current lesson loader emit validated structured lessons.
5. Refactor the Tutor shell around a lesson/session state model rather than English-only drill assumptions.
6. Add deterministic spaced review and mastery persistence.
7. Build the 90-day curriculum incrementally, starting with a representative first week in both directions.
8. Add guided teacher behavior.
9. Preserve hooks for later teacher voice and avatar rendering.

Do not attempt to write all 180 mirrored daily lessons before proving the framework with a small vertical slice.