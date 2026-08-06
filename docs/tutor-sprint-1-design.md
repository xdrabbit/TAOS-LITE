# TAOS Tutor Sprint 1 Design

Status: Approved for implementation  
Branch: `feature/mirrored-90-day-tutor`  
Scope: First 10 days of the mirrored Tutor experience  
Primary learners: Tom learning Spanish; Liz learning English

## 1. Purpose

Sprint 1 proves that TAOS can feel like a patient personal teacher rather than a translation utility or a flashcard app.

The sprint delivers ten complete daily lessons in two mirrored courses:

- `tom-spanish-1`: English explanations, Spanish production, Spanish pronunciation assessment.
- `liz-english-1`: Spanish explanations, English production, English pronunciation assessment.

The software must use one shared teaching engine. Course content, explanations, pronunciation guidance, and examples may differ by language and learner.

## 2. Product promise

TAOS Tutor helps a learner say useful things from memory in real situations. It combines:

- compact first-year grammar;
- memorable real-life sentences;
- substitution practice;
- active recall;
- listening and pronunciation;
- spaced review;
- short guided conversations;
- learner-specific examples where appropriate.

The public curriculum remains broadly useful. Personalization is an optional content layer, not a fork of the application.

## 3. Sprint success condition

Sprint 1 is successful when both learners can independently open the preview, select their course, complete Days 1 through 10, hear the target language, attempt spoken responses, understand what to do next, and see prior material return through review.

The qualitative acceptance test is the Liz Test:

1. Hand Liz the phone without a walkthrough.
2. Observe whether she understands course selection and the first instruction.
3. Observe hesitation, confusion, delight, and requests for help.
4. Sprint 1 passes when she can complete a lesson and wants to continue.

## 4. Non-goals

Sprint 1 does not include:

- all 90 days;
- an adaptive machine-learning scheduler;
- generated curriculum at runtime;
- production avatar rendering or lip sync;
- a general personal-message import product;
- automatic publication of private conversation history;
- replacing the existing `/tutor` route before the new flow is proven.

## 5. Learner experience

### 5.1 Entry

The learner enters at `/tutor/90day` and chooses:

- Tom · Spanish 1
- Liz · English 1

The selected course determines explanation language, target language, pronunciation locale, teacher metadata, lesson catalog, and saved progress.

### 5.2 Daily lesson rhythm

Every day follows a recognizable rhythm:

1. Welcome and communicative goal.
2. Brief pattern explanation.
3. Teacher model.
4. Repeat-after-me attempt.
5. Substitution drill.
6. Hidden-answer recall.
7. Due review from prior lessons.
8. Mini-dialogue or real-life scene.
9. Takeaway summary.
10. Clear completion and next-step state.

The interface should describe actions naturally. Prefer “Let’s try this without looking” over internal labels such as `recall`.

### 5.3 Teacher behavior

The teacher should:

- explain briefly;
- model slowly and naturally;
- ask for one action at a time;
- remove support gradually;
- correct selectively;
- praise observable progress rather than offering generic applause;
- recycle missed material later;
- end with a compact statement of what the learner can now do.

Teacher behavior is represented semantically so text, voice, and future avatar adapters can render the same lesson action.

## 6. First 10 days

The two courses share communicative progression but use language-specific grammar and pronunciation coaching.

### Day 1: Want, need, and have

- Core patterns: I want, I need, I have, negative have.
- Practical outcome: express immediate wants, needs, and availability.

### Day 2: Yes, no, and simple questions

- Core patterns: Do you want…? Do you need…? Do you have…?
- Practical outcome: ask and answer simple questions.

### Day 3: People and identity

- Core patterns: I, you, we, he, she; basic forms of be/ser/estar as appropriate.
- Practical outcome: identify people and make simple personal statements.

### Day 4: Daily actions

- Core verbs: go, come, eat, drink, sleep, work.
- Practical outcome: describe a small daily routine.

### Day 5: Time and plans

- Core language: today, tomorrow, now, later, morning, afternoon, night.
- Practical outcome: say when something happens and make a simple plan.

### Day 6: Food and preferences

- Core language: ordering, liking, wanting, quantities, polite requests.
- Practical outcome: manage a basic restaurant or kitchen exchange.

### Day 7: Consolidation

- No major new grammar.
- Review Days 1 through 6 through recall and one guided conversation.
- Practical outcome: combine known patterns without reading every answer.

### Day 8: Shopping, money, and numbers

- Core language: prices, quantities, numbers, this/that, too much, enough.
- Practical outcome: ask a price and complete a simple purchase.

### Day 9: Home and useful objects

- Core language: rooms, common objects, location, cleaning and household requests.
- Practical outcome: locate objects and ask for practical help.

### Day 10: Integrated conversation

- Combine wants, questions, people, actions, time, food, shopping, and home.
- Practical outcome: complete a realistic multi-turn exchange with reduced support.

## 7. Content architecture

Course content must be typed and validated before reaching the UI.

Required entities:

- `CourseConfig`
- `TeacherProfile`
- `TutorLesson`
- `LessonDrill`
- `SubstitutionSlot`
- learner progress and mastery records
- review queue entries
- semantic teacher actions

A lesson must identify:

- course and day;
- title and communicative goal;
- grammar and vocabulary focus;
- anchor sentences;
- ordered drills;
- mini-dialogue;
- completion criteria;
- review intervals or references.

Invalid content should fail clearly during tests or build.

## 8. Personalization architecture

TAOS history may inform examples and curriculum design, but private source material is never copied blindly into public lessons.

The content system supports three layers:

1. Core curriculum: general and reusable.
2. Domain pack: travel, home, cleaning, restaurant, health, work, or another reusable context.
3. Private personalization overlay: learner-approved vocabulary, people, places, routines, and memories.

A personalization overlay may replace or supplement examples while preserving the lesson’s grammar objective, difficulty, and review identity.

Adult, highly private, or sensitive material is excluded by default. Import and extraction features belong to a later sprint and require explicit privacy controls.

## 9. Review engine v1

Sprint 1 uses a deterministic, inspectable scheduler.

Initial intervals:

- next day;
- three days later;
- seven days later;
- fourteen days later.

The queue should prioritize:

1. repeatedly missed items;
2. due items;
3. recent material;
4. occasional mastered items for retention checks.

The system must distinguish at least:

- introduced;
- recognized;
- recalled with help;
- recalled independently;
- spoken acceptably;
- due for review;
- repeatedly missed.

## 10. Speech and pronunciation

Speech attempts reuse the existing microphone and assessment infrastructure.

Course configuration supplies:

- target text;
- target language;
- pronunciation locale;
- learner and course identifiers.

Tom’s Spanish course must not use the current hard-coded English reference and `en-US` locale. Liz’s English course continues to use English scoring.

A credential-free preview should still permit lesson navigation, answer reveal, hints, and audio where configured. Missing speech credentials must degrade clearly rather than break the lesson.

## 11. Persistence

Persist enough information to resume a course and build a review queue:

- learner/course ID;
- lesson and drill ID;
- attempt time;
- support level used;
- transcript when available;
- pronunciation, accuracy, and fluency scores when available;
- outcome or mastery transition;
- next review date.

Sprint 1 may extend existing Tutor attempt storage or introduce a compatible versioned record. Avoid irreversible schema coupling to a future scheduling algorithm.

## 12. UI constraints

The primary surface is an iPhone.

Requirements:

- safe-area support;
- large tap targets;
- readable target phrase;
- unmistakable learner and language direction;
- visible listening, recording, scoring, speaking, and waiting states;
- one primary action at a time;
- simple hint, reveal, repeat, slow-down, and continue controls;
- no required horizontal scrolling;
- recovery from microphone interruption.

The original `/tutor` remains available during Sprint 1. The experimental framework lives at `/tutor/90day` until acceptance.

## 13. Implementation sequence

1. Lock design and validation commands.
2. Complete typed models and validation.
3. Complete course catalog and first ten mirrored lesson records.
4. Introduce teacher-action/session state.
5. Add course-aware lesson API.
6. Refine course selection and daily lesson UI.
7. Integrate target-language TTS.
8. Integrate course-aware speech assessment.
9. Add progress persistence and deterministic review.
10. Add Day 7 consolidation and Day 10 integrated conversation.
11. Run automated quality gates.
12. Conduct Tom test, then Liz Test.
13. Fix observed friction before considering merge to `main`.

## 14. Definition of done

Sprint 1 is done only when:

- Days 1 through 10 exist for both courses;
- both courses use the same engine;
- each day includes model, repetition, substitution, recall, review, and conversation behavior where appropriate;
- target-language audio works;
- speaking attempts use the correct locale;
- progress resumes after leaving the page;
- deterministic review returns earlier material;
- content validation and mirrored-course tests pass;
- lint, typecheck, tests, and production build pass;
- Vercel preview is healthy;
- Tom completes the flow;
- Liz can use it without a walkthrough and her observed friction is recorded.

## 15. Quality command

Run the Sprint 1 validation gate with:

```bash
npm run validate:tutor
```

The command checks required framework files, then runs typecheck, lint, tests, and the production build.
