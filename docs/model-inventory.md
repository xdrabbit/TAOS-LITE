# OpenAI model inventory and retirement plan

Inventory date: 2026-11-09. Runtime inventory is from `origin/main` at
`affc52d`; the final section separately records the OpenAI defaults in draft
PR #124 because `TAOS_INTERPRETER_ENGINE` is not on `main` yet.

This is documentation only. It does not change code, environment variables,
or model selections.

Retirement dates and named replacements come from the
[OpenAI API deprecations page](https://developers.openai.com/api/docs/deprecations),
read 2026-11-09. OpenAI calls the retirement date the **shutdown date**: after
that date the API model is no longer available. Where that page does not give
a date or replacement, this inventory says **unverified** and does not guess.

## Retirement summary

| Model string used by TAOS | Shutdown date | OpenAI replacement | Status |
|---|---:|---|---|
| `gpt-4.1-nano` | 2026-10-23 | `gpt-5.6-luna` | Past due |
| `gpt-4o-mini-tts` | 2027-01-06 | `gpt-realtime-2.1-mini` | Scheduled |
| `gpt-4.1` | 2027-01-14 | `gpt-6-luna` | Scheduled |
| `gpt-4.1-mini` | 2027-01-14 | `gpt-6-luna` | Scheduled |
| `gpt-realtime` | 2027-01-20 | `gpt-realtime-2.1` | Scheduled |
| `gpt-realtime-mini` | 2027-01-20 | `gpt-realtime-2.1-mini` | Scheduled |
| `gpt-4o-transcribe` | 2027-02-26 | `gpt-live-transcribe` or `gpt-transcribe` | Scheduled |
| `gpt-4o-mini-transcribe` | 2027-02-26 | `gpt-live-transcribe` or `gpt-transcribe` | Scheduled |
| `whisper-1` | 2027-02-26 | `gpt-live-transcribe` or `gpt-transcribe` | Scheduled |
| `gpt-5.5` | **unverified** | **unverified** | No date found on the deprecations page |
| `gpt-realtime-2.1` | **unverified** | **unverified** | PR #124 default; no date found |
| `gpt-live-1` | **unverified** | **unverified** | PR #124 default; no date found |
| `gpt-realtime-translate` | **unverified** | **unverified** | PR #124 default; no date found |
| `gpt-transcribe` | **unverified** | **unverified** | PR #124 default/replacement; no date found |
| `gpt-realtime-whisper` | **unverified** | **unverified** | PR #124 default; no date found |

The deprecations page lists the dated snapshots behind the GPT-4.1 family and
the family aliases together. Fine-tuned variants follow the base model's
shutdown schedule.

No Luna-class model is a hard-coded or default runtime selection on `main`.
`gpt-5.6-luna` and `gpt-6-luna` appear here because OpenAI names them as
replacements. `gpt-realtime-translate` is dead code on `main` and an active
default only in draft PR #124, as detailed below.

## Runtime inventory on `main`

“Env-controlled” means the code has a literal default but accepts the named
environment override. “Inherited” means the call site uses another knob's
value when its own knob is unset.

### Text and vision

| Default model | Call sites | Selection | What users notice if unchanged |
|---|---|---|---|
| `gpt-4.1` | `lib/translate/paraphrase.ts`; `app/api/walkie/turn/route.ts`; `app/api/video/process/route.ts`; `app/api/vision/route.ts`; `app/api/tutor/lesson/route.ts` | Env-controlled: `OPENAI_TRANSLATE_MODEL`. Vision first checks `OPENAI_VISION_MODEL`; tutor lessons first check `OPENAI_TUTOR_LESSON_MODEL`. Default is `gpt-4.1`. | On 2027-01-14, home translation, Redo, Taokie, video caption translation, vision translation, and uncached tutor lesson generation return upstream failures. |
| `gpt-4.1-mini` | Default defined in `lib/translateProvider.ts`; callers: `app/api/text-translate/route.ts`, `app/api/live-translate/route.ts`, `app/api/chat/send/route.ts`, `app/api/chat/voice/route.ts`, `app/api/voz/line/route.ts`, `app/api/tutor/assess/route.ts` | Env-controlled: `OPENAI_PARAPHRASE_MODEL`; default `gpt-4.1-mini`. | On 2027-01-14, typed translation, chat translation, voice-note translation, live concept translation, Voz lines, and tutor feedback fail. |
| `gpt-4.1-nano` | `lib/fast/engine.ts` | Env-controlled: `OPENAI_FAST_MODEL`; default `gpt-4.1-nano`. | Its shutdown date has passed. `/fast` fails anywhere the environment does not override the dead default. |
| `gpt-5.5` | `lib/study/lesson.ts`; inherited by `lib/review/secondOpinion.ts`; `tools/translations-viewer/lib/lesson.mjs` | Env-controlled: `OPENAI_STUDY_LESSON_MODEL`, `TAOS_REVIEW_GRADER_MODEL`, and `TRANSLATIONS_LESSON_MODEL`; all default to `gpt-5.5`. | **Unverified:** no retirement date was found. No deadline-driven user impact can be stated. |

All GPT-4.1 text callers currently send `temperature`; the shared provider
also sends legacy `max_tokens` for some callers. The named Luna replacement
must be request-shape tested before an environment flip. Treat the GPT-4.1
family migration as a small compatibility code change followed by environment
changes, not as a blind env-only swap.

### File transcription

| Default model | Call sites | Selection | What users notice if unchanged |
|---|---|---|---|
| `gpt-4o-transcribe` | Default defined in `lib/translate/transcribe.ts`; used by `app/api/translate/route.ts`, `app/api/walkie/turn/route.ts`, `app/api/fast/listen/route.ts`, `app/api/voz/line/route.ts`; a separate direct call exists in `app/api/chat/voice/route.ts` | Env-controlled: `OPENAI_TRANSCRIBE_MODEL`; default `gpt-4o-transcribe`. `OPENAI_AUTO_TRANSCRIBE_MODEL` inherits this value when unset. | On 2027-02-26, spoken home turns, Taokie, Fast mic, Voz, and chat voice notes fail. |
| `whisper-1` | `lib/translate/shortTranscript.ts`; `app/api/review/redo/route.ts`; `lib/review/opinion.ts` / `lib/review/secondOpinion.ts`; `app/api/video/process/route.ts` | Env-controlled at the primary sites: `TAOS_TRANSCRIBE_FALLBACK_MODEL`, `TAOS_REVIEW_STT_MODEL`, and `OPENAI_CAPTION_STT_MODEL`; default `whisper-1`. Also hard-coded in `REVIEW_STT_FALLBACKS`. | On 2027-02-26, short-transcript retry and Redo fail, Review's second transcription fails, and `/video` loses timestamped captions. |

`app/api/video/process/route.ts` asks `whisper-1` for `verbose_json` and segment
timestamps. The deprecations page names `gpt-transcribe`, but it does not say
that the replacement preserves that response shape. `/video` therefore needs
a compatibility decision and test, not only an env edit.

Review's hard-coded `REVIEW_STT_FALLBACKS` list contains only
`whisper-1`, `gpt-4o-mini-transcribe`, and `gpt-4o-transcribe`; all three shut
down on the same date.

### Realtime input transcription

| Default model | Call sites | Selection | What users notice if unchanged |
|---|---|---|---|
| `gpt-4o-mini-transcribe` | `app/api/live/realtime/route.ts`; `app/api/tabletop/realtime/route.ts`; `app/api/call/realtime/route.ts`; `app/api/tutor/realtime/route.ts` | Env-controlled: `OPENAI_REALTIME_TRANSCRIPTION_MODEL`; default `gpt-4o-mini-transcribe`. | On 2027-02-26, realtime sessions may fail to start or stop producing their “heard” captions, depending on endpoint validation. |

The tutor route conditionally adds its learner-only transcription prompt by
matching the old model name. That condition must be revisited with the model
swap or the prompt silently disappears.

### Text to speech

| Default model | Call sites | Selection | What users notice if unchanged |
|---|---|---|---|
| `gpt-4o-mini-tts` | `app/api/tts/route.ts` | Env-controlled: `OPENAI_TTS_MODEL`; default `gpt-4o-mini-tts`. | On 2027-01-06, OpenAI speech generation fails. The route then attempts its existing ElevenLabs fallback, so users may hear a different voice after an extra failed request; if that fallback is unavailable, speech is silent. |

The named replacement, `gpt-realtime-2.1-mini`, is a Realtime model rather
than a model selection for the current `/v1/audio/speech` request. This is a
code migration, not a single-variable substitution.

### Realtime speech-to-speech

| Default model | Call sites | Selection | What users notice if unchanged |
|---|---|---|---|
| `gpt-realtime` | `app/api/live/realtime/route.ts`; `app/api/tabletop/realtime/route.ts`; `app/api/call/realtime/route.ts` | Env-controlled: `OPENAI_LIVE_REALTIME_MODEL`; Tabletop may override with `OPENAI_TABLETOP_REALTIME_MODEL`, Call with `OPENAI_CALL_REALTIME_MODEL`. Default `gpt-realtime`. | On 2027-01-20, Live and Call cannot start; Tabletop's live engine cannot start, though its classic push-to-talk path remains. |
| `gpt-realtime-mini` | `app/api/tutor/realtime/route.ts` | Env-controlled: `OPENAI_TUTOR_REALTIME_MODEL`; default `gpt-realtime-mini`. | On 2027-01-20, Tutor and Study realtime conversations cannot start. |

The model identifiers can be changed with environment variables. A follow-up
code change is still required for the hard-coded cost tables in
`lib/call/cost.ts` and `lib/tabletop/metrics.ts`, otherwise displayed/logged
cost estimates continue to use legacy rates.

### Stale model string that is not currently called

`lib/realtime/session.ts` defaults `OPENAI_TRANSLATION_MODEL` to
`gpt-realtime-translate`, but no production module imports its session
builder. `/api/realtime/session` is a tombstone. This is dead code on `main`,
not a current API caller; it is recorded so grep results are not mistaken for
an omitted runtime model.

Manual measurement files under `tests/live-fire/` and unit-test fixtures are
not product callers. Their model literals were checked for migration fallout,
but are not represented as app runtime defaults in the tables above.

## Draft PR #124: Tabletop Interpreter

PR #124 is not part of `main`, and this inventory PR does not modify it. Its
OpenAI model defaults are centralized in `lib/interpreter/engine.ts`:

| Engine/default | Selection | Retirement | User impact if unchanged |
|---|---|---|---|
| `gpt-realtime-2.1` | `TAOS_INTERPRETER_OPENAI_MODEL` | **unverified** | No verified shutdown date. |
| `gpt-live-1` | `TAOS_INTERPRETER_LIVE_MODEL` | **unverified** | No verified shutdown date. |
| `gpt-realtime-translate` | `TAOS_INTERPRETER_TRANSLATE_MODEL` | **unverified** | No verified shutdown date. |
| `gpt-transcribe` | `TAOS_INTERPRETER_TRANSCRIBE_MODEL` | **unverified** | No verified shutdown date. |
| `gpt-realtime-whisper` | `TAOS_INTERPRETER_TRANSLATE_TRANSCRIBE_MODEL` | **unverified** | No verified shutdown date. |

`TAOS_INTERPRETER_ENGINE` selects an engine, not an OpenAI model; its default
is `openai-realtime`. The PR's
OpenAI defaults are successors rather than the retiring `gpt-realtime`,
`gpt-realtime-mini`, or `whisper-1` model strings.

## Swap plan, ordered by deadline

### Now: remove the dead `/fast` default

1. Confirm the deployed `OPENAI_FAST_MODEL` name without printing its value
   into logs or a repository.
2. Test the named `gpt-5.6-luna` replacement with `/fast`'s request shape.
3. Make any required request-shape code change, then change
   `OPENAI_FAST_MODEL` and the code default in a behavior PR.
4. Verify both manual and auto `/fast` translation paths.

### By 2027-01-06: `gpt-4o-mini-tts`

1. Choose a supported TTS path. OpenAI's named replacement requires a
   Realtime integration; the existing Google and ElevenLabs paths are product
   alternatives but are not the replacement named by OpenAI.
2. Implement and listen-test the chosen path across representative languages.
3. Remove the obsolete `OPENAI_TTS_MODEL` default only after the new path is
   verified on Preview.

### By 2027-01-14: GPT-4.1 family

1. Update shared request construction for the named Luna replacement and add
   request-body tests for every shape currently used (`json_object`,
   `json_schema`, vision input, and output-token limits).
2. Quality-test `gpt-6-luna` against the current full and mini translations.
3. Change `OPENAI_TRANSLATE_MODEL` and `OPENAI_PARAPHRASE_MODEL`; separately
   check inherited overrides for Vision and Tutor.
4. Verify home manual/auto, typed translation, Chat, Voz, Vision, Tutor,
   Taokie, and video caption translation.

### By 2027-01-20: Realtime

1. On Preview, set `OPENAI_LIVE_REALTIME_MODEL=gpt-realtime-2.1` and
   `OPENAI_TUTOR_REALTIME_MODEL=gpt-realtime-2.1-mini`.
2. Exercise Live, Tabletop live, Call, Tutor, and Study, including captions,
   barge-in, tool calls, and session shutdown.
3. Update and test the two cost tables before Production.

### By 2027-02-26: Transcription

1. Compare `gpt-transcribe` and `gpt-live-transcribe` on real retained clips,
   mixed-language audio, short/dropout audio, and language hints.
2. Move ordinary file transcription with `OPENAI_TRANSCRIBE_MODEL` and
   `OPENAI_AUTO_TRANSCRIBE_MODEL` after compatibility tests.
3. Choose a timestamp-capable `/video` plan.
4. Replace the hard-coded Review fallback list with at least one genuinely
   independent second reader, or explicitly retire the “second opinion”
   claim.
5. Update the model-name conditionals in short-transcript retry and Tutor.
6. Move the realtime caption model and verify every Realtime surface.

## Env-only changes versus code changes

| Swap | Classification | Reason |
|---|---|---|
| `gpt-realtime` → `gpt-realtime-2.1` | Env change, plus cost-table follow-up | Existing routes expose model knobs and keep the same Realtime family. |
| `gpt-realtime-mini` → `gpt-realtime-2.1-mini` | Env change, then behavior verification | Tutor exposes its own model knob; tool/caption behavior still needs testing. |
| Ordinary `gpt-4o-transcribe` file calls → `gpt-transcribe` | Env change after compatibility tests | Shared file transcription already accepts a model string. |
| Realtime `gpt-4o-mini-transcribe` → successor | Env change plus code review | The knob exists, but Tutor branches on the old model name. |
| `whisper-1` retry / Redo / Review | Mixed env and code | Primary choices are knobs; the fallback array and model-specific prompt behavior are code. |
| `whisper-1` `/video` captions | Code change | Timestamped response compatibility is not established by the deprecations page. |
| `gpt-4o-mini-tts` → `gpt-realtime-2.1-mini` | Code change | Different API path/protocol. |
| GPT-4.1 family → `gpt-6-luna` | Code compatibility change, then env changes | Current callers send parameters that must be validated/adapted for Luna. |
| Dead `gpt-4.1-nano` default → `gpt-5.6-luna` | Code default and likely request-shape change | The named replacement must be tested with `/fast`; env alone does not repair local/default deployments. |

## Current code findings

- `lib/fast/engine.ts` still defaults to `gpt-4.1-nano`, whose official
  shutdown date has passed.
- `lib/review/opinion.ts` says `whisper-1` retires on **2026-02-26**. The
  verified shutdown date is **2027-02-26**.
- `REVIEW_STT_FALLBACKS` hard-codes three models that all retire on the same
  day, so it is not a durable fallback chain.
- `/video` is coupled to Whisper's segment-timestamp response shape; the
  deprecations page does not verify equivalent output from the named
  replacement.
- `OPENAI_REALTIME_MODEL` appears in environment documentation/configuration,
  but current runtime code uses the surface-specific knobs above; no current
  product path reads that generic name.
- `lib/realtime/session.ts` contains an unused translation-session builder and
  can make grep results imply a runtime call that does not exist on `main`.

## Unverified items

No shutdown date or replacement was verified on the official deprecations
page for:

- `gpt-5.5`
- `gpt-realtime-2.1`
- `gpt-live-1`
- `gpt-realtime-translate`
- `gpt-transcribe`
- `gpt-realtime-whisper`

Recheck the [OpenAI API deprecations page](https://developers.openai.com/api/docs/deprecations)
before each migration PR and monthly until the last scheduled swap is complete.
