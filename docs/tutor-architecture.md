# Tutor architecture baseline

This document records the Tutor implementation as it exists at the start of the mirrored 90-day framework work. It distinguishes reusable infrastructure from assumptions that must be refactored.

## Current request flow

The Tutor route renders `TutorShell`:

```text
app/tutor/page.tsx
  -> components/TutorShell.tsx
     -> GET /api/tutor/lessons
        -> lib/tutor/parseLessons.ts
           -> content/tutor-course/**/*.md
```

Pronunciation practice captures browser audio, converts it to 16 kHz WAV, sends it to the Tutor assessment API, displays pronunciation feedback, and saves an attempt through the existing Supabase helpers.

Conversation mode uses the existing Tutor conversation state and realtime API. Authentication, tier access, monthly usage, purchased minute packs, session accounting, and saved attempts are already integrated into the shell.

## Reusable implementation

The following pieces should be preserved and adapted rather than replaced wholesale:

- `/tutor` route and iPhone-oriented page shell.
- Supabase authentication and profile loading.
- Tier, usage, purchased-minute, and paywall behavior.
- Browser microphone lifecycle and interruption recovery.
- Web audio conversion in `lib/tutor/wav.ts`.
- Pronunciation assessment request and result presentation.
- Saved Tutor attempts and session usage accounting.
- Realtime conversation transport and conversation state machinery.
- Server-side TTS integration.
- Safe-area layout and large mobile controls.

These are product infrastructure. They should consume the new course/session model rather than be duplicated for each learner or target language.

## Current hard-coded assumptions

### English is the drill target

`TutorShell` currently:

- displays `drill.en` as the phrase to say;
- displays `drill.es` as support text;
- sends `drill.en` to TTS;
- submits `drill.en` as pronunciation reference text;
- submits `en-US` as the assessment locale;
- stores `target_lang: "en"`;
- stores the fixed course identifier `es-en-30day`.

This prevents Spanish 1 for Tom from using the same flow correctly.

### Lesson content is reduced to bilingual phrase pairs

`parseLessons.ts` recursively scans `content/tutor-course`, finds filenames containing `day-N`, extracts only the Markdown `Micro-Sentences` table, and returns:

```ts
interface Drill {
  en: string;
  es: string;
}

interface Lesson {
  id: string;
  day: number;
  title: string;
  drills: Drill[];
}
```

Grammar goals, substitution frames, recall prompts, review references, scenes, pronunciation targets, and completion criteria are discarded. Duplicate day numbers are silently ignored according to filesystem traversal order.

### The lesson API has no course identity

`GET /api/tutor/lessons` loads one global course directory and accepts no course identifier. The response cannot distinguish learner, native language, target language, explanation language, pronunciation locale, or 90-day program.

### The UI navigates content, not a teaching session

The current drills view advances through phrase cards. It does not yet model teacher actions such as introduce, model, repeat, hide support, recall, substitute, recycle a miss, conduct a scene, or schedule review.

## Target separation

The mirrored framework should separate these layers:

```text
course content
  -> validated course schema
  -> lesson/session engine
  -> review and mastery logic
  -> Tutor presentation
  -> microphone / speech assessment / persistence adapters
```

Future voice and avatar rendering should consume semantic teacher actions emitted by the session engine. Curriculum records must not depend directly on a particular speech or avatar vendor.

## First vertical slice

The first implementation slice should prove both directions with one shared engine:

- `tom-spanish-1`, Day 1
- `liz-english-1`, Day 1

Each Day 1 lesson should include:

- explicit course and language configuration;
- one concise grammar objective;
- a small vocabulary set;
- memorable real-life anchor sentences;
- at least one substitution frame;
- recognition and active-recall prompts;
- pronunciation locale and target notes;
- one short mini-dialogue;
- deterministic review metadata;
- completion criteria.

The existing pronunciation and audio flow should select target text, support text, TTS language, assessment locale, stored course ID, and stored target language from course configuration.

## Implementation sequence

1. Add typed course, lesson, activity, review, and progress models.
2. Add a small runtime validator with clear development errors.
3. Define mirrored course configurations for Tom and Liz.
4. Add structured Day 1 content for each course.
5. Update the lesson API to require or safely default a course ID.
6. Refactor the drill UI to derive language behavior from the selected course.
7. Introduce a minimal lesson-session state model.
8. Add pure-function tests before expanding the curriculum.

## Compatibility rule

Until the structured vertical slice is working, retain the legacy Markdown parser and current course content as a compatibility path. Remove or migrate it only in a deliberate later commit after the new loader and UI have proven equivalent or better behavior.
