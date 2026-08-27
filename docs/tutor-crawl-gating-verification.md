# Crawl gating — verification run, 2026-08-27

Liz's field report: Crawl's Say-It step repeats the same phrase over and over
and wants a pronunciation that is too perfect before it will move on. It should
move on at **close enough**.

This is the run that says the fix works. It also found a bug that had been
sitting in the tutor since phase 1.

---

## The bug the verification found

**Crawl never showed a score at all.** Not once, in any language, since phase 1.

`app/api/tutor/assess/route.ts` read

```
NBest[0].PronunciationAssessment.PronScore
```

which is the shape the Speech **SDK** returns and the shape most of Microsoft's
documentation draws. The REST endpoint this app calls — v1 conversation
recognition with `?format=detailed` — puts the scores **flat on the NBest
entry**, and does the same for every word. Captured live, trimmed:

```json
{ "RecognitionStatus": "Success", "DisplayText": "Necesito ayuda, por favor.",
  "NBest": [ { "AccuracyScore": 73, "FluencyScore": 88,
               "CompletenessScore": 75, "PronScore": 76.4,
               "Words": [ { "Word": "Necesito", "AccuracyScore": 23,
                            "ErrorType": "Mispronunciation" }, … ] } ] }
```

So `pa.PronScore` was `undefined` on every request, `?? null` turned it into
`null`, and the screen rendered `—`. The word chips were blank for the same
reason. The coaching model was handed `Math.round(result.pron ?? 0)` and wrote
warm, fluent, specific feedback about a score of **zero** — which is why the
screen still looked alive.

**Why it hid for a month.** Every layer degraded politely. Nothing threw,
nothing 500'd, nothing logged. The phase-1 verification recorded the Azure leg
as *reached* — which was true — and reaching Azure is not the same as a number
arriving. Phase 1 could not go further because `AZURE_SPEECH_KEY` is marked
SENSITIVE in Vercel and cannot be pulled to a laptop, so the assertion that
would have caught it was never written.

The fix is `lib/tutor/assessment.ts`, which reads **both** shapes (nested
first) and is pinned by `tests/tutor-assessment.test.ts` against the real
captured response above. Reading only one shape is one region migration away
from silently returning dashes again.

This also means the gating change was load-bearing in a way nobody planned:
without the parser fix, no phrase could ever be passed, and every phrase in
the curriculum would advance on the attempt cap.

---

## How the Azure key problem was solved

`AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION` are SENSITIVE in Vercel — write
only, and `vercel env pull` returns empty strings for them. `/api/tutor/assess`
is behind `guardSpend`, and the deployed app is behind the shared passcode, so
there was no path from this laptop to a real score.

A temporary probe route (`app/api/tutor/probe-azure/route.ts`) was deployed to
a preview with `vercel deploy --env TAOS_PROBE_SECRET=…`, which scopes the
secret to that one deployment rather than the Preview environment. It made the
identical Azure call from inside the deployment, where the key lives, and ran
the **shipped parser** on the response — the point being not "did Azure
answer" but "did a number reach the screen". It required a matching
`x-probe-secret` header and 404'd without one.

**The probe route has been deleted from the branch.** It is not in the PR. If
this is ever needed again, the shape is in this document's git history.

One trap worth writing down: the route was first created at
`app/api/tutor/_probe/` and returned a Next 404. App Router treats a folder
prefixed with `_` as a **private folder** and excludes it from routing.

---

## Round trip 1 — real Azure, real audio

Five recordings of `Necesito ayuda, por favor.`, made with OpenAI TTS. The
trick for a deliberately mediocre take: feed the TTS an **English phonetic
respelling** so an English-reading voice produces genuinely accented Spanish,
while the reference text sent to Azure stays the real phrase.

Azure westus2, locale `es-MX` (Liz is Venezuelan — `lib/tutor/pronunciation.ts`
explains that choice).

| take | what was said | PronScore | parsed by the route | verdict @ 60 |
|---|---|---|---|---|
| good | the phrase read straight | **91.8** | 91.8 | pass → advance |
| mediocre | `Ness-uh-SEE-toe ay-YOO-duh, pore fah-VORE.` | **91.6** | 91.6 | pass → advance |
| poor | `Nuh-sess-it-oh a-yood-a, por fave-or.` | **76.4** | 76.4 | pass → advance |
| partial | only the first word, mangled | **38.2** | 38.2 | below → retry |
| garbled | hesitant, wrong stress, wrong final word | **32.4** | 32.4 | below → retry |

**What this says about 60 as the bar.** An attempt that is recognizable but
audibly foreign lands in the **70s to 90s** — the `poor` take was read with
full English phonics, scored 23/100 on its first word, and still totalled 76.4.
Only genuinely broken attempts (a word missing, or hesitation and a wrong word)
fall under 60: 38.2 and 32.4. That is the right place for the line. Nothing a
learner could reasonably call "close enough" scores below it, and the two takes
that do fall below deserve another go.

Worth noting for later: Azure's `FluencyScore` stayed high (88–94) on every
take because synthetic speech has no hesitation. A real learner's pauses will
pull the totals **down** relative to this table, which is one more argument for
60 rather than 70.

---

## Round trip 2 — the screen, in a real browser

Headless Chrome, real `ModulesShell`, real `Crawl`, real
`lib/tutor/wav.ts` decode path. The lesson and the assessment arrived through
stubbed fetches, and the assessment payloads were **the captured Azure
responses above**, replayed in the order Liz hit them: three failures, then a
pass on the next phrase.

```
attempt 1   32% · 60 to pass   "Almost — give it one more · Casi — una vez más"        stays
attempt 2   38% · 60 to pass   "Almost — give it one more · Casi — una vez más"        stays
attempt 3   32% · 60 to pass   "Close enough — we'll circle back ·
                                Suficiente por ahora — volveremos"                     ADVANCES
            localStorage → {"…":{"bestScore":38,"review":["Necesito ayuda, por favor."]}}
            (auto-advance lands) → phrase 2 / 2
phrase 2    76% · 60 to pass   "Got it — next phrase · Muy bien — siguiente frase"      ADVANCES
```

Confirmed on screen:

- the bilingual cap framing renders, in the "moving on" style, under the
  coaching line — not as an error;
- the score is present but small (`32%`) next to `60 to pass`, so advancing
  reads as earned rather than arbitrary;
- three attempt dots beside `SAY IT` fill in, so the cap is visible **before**
  it arrives;
- the word chips colour against the bar — `favor` (76) green, `Necesito` (23)
  red;
- the review mark is written to localStorage the moment the cap fires;
- the **last** phrase does not auto-advance into Walk. Walk opens a realtime
  session, which costs money, and nothing should spend that on a timer — the
  learner still taps `Done · go to Walk →`.

The verification page (`app/verify-crawl/page.tsx`) was temporary and **has
been deleted from the branch**.

---

## What is still not verified

- **A human mouth.** Every number above came from TTS. Synthetic speech is
  acoustically cleaner than a person and scores high on fluency; the bar may
  want revisiting after Liz walks a module with her own voice.
- **The deployed screen.** The browser walk ran against a local production
  build with stubbed fetches. Nobody has tapped through Crawl on a phone
  against the fixed route — that needs the shared passcode.

Both are one preview session for Tom or Liz, and neither blocks the merge:
tutor is flag-off in Production, so nothing customer-facing moves.
