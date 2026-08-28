# What a realtime minute costs

*/call measured 2026-08-27; /live and /tabletop measured 2026-08-28. Everything
below is a number that came back from the API, not an estimate of one.*

/call was pulled from RC1 for two reasons. The first — it was never wired to the
language catalog — was a bug. The second was this: **nobody could say what a
minute of it cost.** The July 14/22 OpenAI spikes were noticed on a bill, weeks
after the calls that caused them, with no way to attribute them to anything.

This document is the answer for all three realtime screens, and `lib/call/cost.ts`
is the same arithmetic running on the phone while a call is happening.

The rig that produced the numbers is in the repo: `tests/live-fire/`. It drives a
real `gpt-realtime` session from Node and reads the usage off every
`response.done`. It takes its session object from the same builders the mint
routes use (`lib/live/session.ts`, `lib/tabletop/session.ts`), so a measurement
is a measurement **of the thing that ships** — the /call model was measured
against a hand-copied session object, which made its numbers unreproducible and
one edit away from describing a configuration nobody deployed.

```
OPENAI_API_KEY=… npx vitest run --config vitest.measure.config.ts
```

## The four things a realtime minute pays for

| | rate | what drives it |
|---|---|---|
| audio **in** | $32 / Mtok | speech the input VAD **commits** — 1 token per 100 ms |
| audio **out** | $64 / Mtok | speech the model **generates** — ~25 tok/s |
| text in / out | $4 / $16 per Mtok | the instructions, re-sent every response |
| transcription | $0.003 / min | `gpt-4o-mini-transcribe`, on committed audio |
| ElevenLabs | $0.05 / 1k chars | flash v2.5, when the app speaks instead of the model |

## The finding that mattered

The obvious saving was to stop streaming silence into the session. It turns out
there was nothing there to save:

> "Audio input is billed at 1 token per 100 ms. Voice activity detection will
> effectively filter out empty input audio, so empty audio doesn't count as
> input tokens." — OpenAI, *Managing costs*

Measured: 34.1 s of audio streamed into a session, **22.7 s billed**. The
difference was the silence between utterances. A client-side speech gate would
have bought a way to clip the first syllable of a sentence in exchange for
nothing — so none of these screens has one.

The real cost was somewhere much less obvious. **Every response re-reads the
whole conversation, as audio, at $32/Mtok.** Not a share of it, not a summary of
it — the audio, again, priced as audio, on every turn. So the bill grows with
how long a session has been open rather than with how much anyone said, and it
keeps growing until something stops it.

`truncation.token_limits.post_instructions` is what stops it. The instructions
are never truncated (they are the prompt, and on these screens the prompt is the
only thing keeping the model from drifting into the wrong language); the cap
applies to the conversation behind them.

## Three surfaces, three caps

Each was measured the same way: the same synthesised audio through every arm,
changing only the truncation setting, reading the **per-turn trend** rather than
the total. The trend is the finding. A total over six turns hides whether the
cost per turn is flat or climbing, and flat-versus-climbing is the whole
question.

### /live — ambient, six turns of a Spanish dinner (36.3 s of speech)

| `post_instructions` | billed audio in | per-turn `in_audio` | model cost |
|---|---|---|---|
| uncapped (`"auto"`) | **460 %** of speech | 51 → 180 → 267 → 326 → 398 → **447** | $0.0724 |
| 200 | 170 % | 51 → 114 → 127 → 115 → 131 → 78 | $0.0508 |
| **150** ← shipped | **110 %** | flat: 51 → 63 → 76 → 65 → 66 → 78 | **$0.0468** |
| 100 | 102 % | flat: 51 → 63 → 63 → 65 → 66 → 62 | $0.0401 |

Read the third column. Uncapped, the re-read had reached 447 tokens per turn by
the sixth utterance and was still going — a dinner that runs two hours pays for
its first minute over and over. At 150 it is flat, and it was flat by turn three.

**Why /live's cap is 150 and /call's is 100.** /live *coalesces*: everything said
while the last summary was still playing folds into the next one (`pendingTurns`
in `lib/live/ambient.ts`), so several committed segments can be waiting when a
response fires. 100 is one segment, and at 100 it showed:

> turn 2: *"Saturday's very crowded, and rain expected in the afternoon."*
> turn 3: *"Saturday's crowded, rain expected in the afternoon."*

Turn 3 is a **repeat of turn 2**. The model had lost the audio it was supposed to
be summarising and re-summarised what it could still see. Turn 1 dropped the
beach entirely. At 150 all six summaries were right and complete. The eight
percentage points between 102 % and 110 % buy that back, which is not a close
call.

The number also has a reason before it has a measurement, which is why it was
the one tried: the prompt already tells the interpreter *"do NOT try to catch up
— summarize only the most recent 10-15 seconds"*, and audio bills at 1 token per
100 ms, so ten to fifteen seconds **is** 100–150 tokens. Anything above that is
history the prompt has already forbidden the model to use, bought at $32/Mtok.

### /tabletop — six push-to-talk turns, alternating sides (22.3 s of speech)

| `post_instructions` | billed audio in | per-turn `in_audio` | model cost |
|---|---|---|---|
| uncapped (`"auto"`) | **400 %** of speech | 39 → 84 → 121 → 175 → 215 → **255** | $0.0282 |
| 150 | 211 % | 39 → 84 → 82 → 91 → 94 → 80 | $0.0212 |
| **100** ← shipped | **115 %** | flat: 39 → 45 → 37 → 54 → 40 → 40 | **$0.0136** |
| 75 | 107 % | flat: 39 → 45 → 37 → 37 → 40 → 40 | $0.0115 |

The table is where an uncapped session hurts most per unit of conversation,
because **one session serves the whole party**. It is minted once and re-pointed
with `session.update` as the phone goes round, so by the sixth turn "the
conversation so far" is five other people's turns, re-read as audio on every
phrase.

100 is the floor. At 75, turn 4 came back:

> heard: *"I love it. The seafood especially — we don't get anything like that at home."*
> → *"Me gusta el ambiente, pero la comida no es exactamente lo que esperaba."*
> ("I like the atmosphere, but the food isn't exactly what I expected.")

That is not a translation, it is an invention — the exact failure the prompt's
"NEVER invent content" rule exists to prevent, produced by starving the model of
the phrase it was translating. At 100 all six turns were faithful. The 8 % saving
from 75 is a fabricated sentence put in a guest's mouth at a dinner party.

> **A measurement bug worth recording.** The first tabletop run gave 100 a
> failing grade too — three turns where the interpreter stopped translating and
> started *conversing* ("I'm here to help, but just a reminder: I can only
> provide real-time interpretation…"). That was the harness, not the cap. The
> real client re-points the session on every turn; the harness minted one
> direction and never flipped it, so every second utterance was
> out-of-direction and the model was coping rather than translating. The driver
> does the per-turn `session.update` now (`beforeUtterance`). **A cliff found by
> a rig that does not do what the client does is not a cliff.**

### /call — unchanged, and the surface the other two were measured against

| `truncation` | input audio billed | per-turn `in_audio` | model cost, 5 turns |
|---|---|---|---|
| default (`"auto"`) | **209 %** of speech | 49 → 100 → 164 → 175 → 227 | $0.0154 |
| `post_instructions: 200` | 148 % | ~100–126 | $0.0245 \* |
| **`post_instructions: 100`** ← shipped | **66 %** | flat ~52 | **$0.0129** |
| `conversation.item.delete` after each turn | 51 % | flat, but see below | $0.0116 |

\* *that run drew zero cache hits; caching is luck of the draw turn to turn,
which is itself an argument for keeping the context small enough not to need it.*

Explicit `conversation.item.delete` was cheaper still and is **not** shipped
anywhere: it raced the response it was pruning for, and two turns came back
having been given no audio at all (`in_audio: 0`), producing degenerate output.
Declarative truncation lets the server decide what it can spare, and never does
that.

## The other lever: who speaks

The same utterance, same session, measured both ways:

| | in audio | in text | out text | out audio | model cost |
|---|---|---|---|---|---|
| `output_modalities: ["text"]` | 21 | 127 | 10 | 0 | **$0.00134** |
| `output_modalities: ["audio"]` | 21 | 127 | 16 | **43** | **$0.00419** |

Model-spoken audio is 3× the cost of the entire text response. /call's default
("Their voice") and /tabletop both ask for text and hand it to `/api/tts`, which
means the app's own voices — Liz's clone reading her own sentence in English, per
the voice-follows-speaker rule in `lib/tts/voice.ts`. Cheaper **and** the better
voice.

**/live is the exception, deliberately.** It has no text mode to fall back to:
the feature is a voice in an earpiece while you look at the table, and taking the
voice away to save money would be deleting it rather than capping it. So under
the cap, the model's own speech is /live's largest line item again ($0.024 of
$0.047) — which is the right shape. The expensive thing should be the thing the
feature is, not the bookkeeping around it.

## Per minute, before and after

**/live** — the measured run is about one minute of dinner: 36 s of speech in
six utterances, which is roughly a table where somebody is talking 60 % of the
time. Transcription is billed on the 40.7 s VAD committed. No ElevenLabs on this
screen: the model speaks.

Every figure below is a line item read off the run, not a share of a total
apportioned afterwards — cached audio and cached text bill at the same
discounted rate but come off different rows, so a breakdown cannot be derived
from a sum.

| | before (uncapped) | after (150) |
|---|---|---|
| audio in — **the re-read** | $0.0515 | **$0.0128** |
| text in — instructions re-sent | $0.0088 | $0.0077 |
| audio out — model speech | $0.0237 | $0.0246 |
| text out | $0.0020 | $0.0022 |
| transcription | $0.0020 | $0.0020 |
| **per minute** | **$0.088** | **$0.049** |

**44 % off.** Note which row moved: only the re-read. The model still speaks
just as much, the instructions are still re-sent, and the feature is unchanged —
what stopped was paying to hear the beginning of dinner again on every summary.

That is also the *flattering* comparison, because "before" is minute one. The
uncapped column climbs for as long as the session is open and the capped one
does not, so at minute sixty the real gap is far wider. A two-hour dinner is the
case /live was built for.

> This was a second run, a few hours after the four-arm table above, on freshly
> synthesised audio. It reproduced: **464 %** uncapped against 460 %, **111 %**
> capped against 110 %, and the same shape of climb (58 → 164 → 247 → 318 → 411
> → 474). The dollar totals differ by more than the ratios do, because cache
> hits are luck of the draw turn to turn — which is one more argument for
> keeping the context small enough not to need them.

**/tabletop** — priced per minute of active table conversation, taken as **four
turns** (a turn is one person speaking, then handing the phone over for the
other to read). The measured run was seven turns in 24.8 s of speech, so the
model rows below are that run's line items scaled to four. Each turn's
translation is also read aloud at turn end through `/api/tts` — the six
translations averaged ~55 characters.

| | before (uncapped) | after (100) |
|---|---|---|
| audio in — **the re-read** | $0.0149 | **$0.0052** |
| text in — instructions re-sent | $0.0027 | $0.0024 |
| text out | $0.0009 | $0.0011 |
| transcription | $0.0008 | $0.0008 |
| ElevenLabs readout | $0.0110 | $0.0110 |
| **per minute** | **$0.030** | **$0.021** |

**32 % off**, and the cap moves the biggest line item from "re-reading the
party" to "speaking in Liz's voice", which is the one worth paying for. There is
no model speech on this screen at all — `output_modalities: ["text"]` — which is
why a table minute is the cheapest of the three even before the cap.

> Also a second run, and it reproduced: **405 %** uncapped against 400 %, and
> **115 %** capped against 115 % exactly.

**/call** — a 10-minute call, each person speaking ~40 % of it, per phone doubled:

| | before | after (Their voice) | after (Fastest) |
|---|---|---|---|
| **per phone / min** | $0.062 | $0.029 | $0.051 |
| **per call / min (two phones)** | **$0.123** | **$0.058** | **$0.101** |

### All three, side by side

| surface | who sees it | cap | before | after | saving |
|---|---|---|---|---|---|
| **/live** | customers | 150 | $0.088/min | **$0.049/min** | **44 %** |
| **/tabletop** | customers | 100 | $0.030/min | **$0.021/min** | **32 %** |
| **/call** | founders only | 100 | $0.123/min | **$0.058/min** | 53 % |
| /tutor | flagged off | — | — | — | metered separately |

Every "before" in that table is minute one, which is the kindest possible
reading of the uncapped column. The saving on a session that actually runs — a
two-hour dinner, a party that goes all night — is larger than any figure here,
because the capped number is the same at minute 120 as at minute 1 and the
uncapped one is not.

/live is both the most expensive minute and the only one meant to run for hours,
which is why it was the priority. /tutor is deliberately untouched here: it is a
*conversation*, it genuinely wants its history, and its cost is handled by
per-minute metering rather than by truncation.

## Guards, and what each one stops

| guard | surface | stops |
|---|---|---|
| `post_instructions: 150` | /live | cost growing with session length |
| `post_instructions: 100` | /tabletop, /call | same |
| text output + `/api/tts` | /tabletop, /call default | the single largest line item |
| `noise_reduction: near_field` | /tabletop, /call | a passing bus becoming a billed turn |
| *no* noise reduction | /live | — deliberate; see below |
| 5-min idle auto-off (30 s warning) | /live | a phone left on a table at a dinner |
| 2-h hard cap (2-min warning) | /live | a forgotten tab |
| 5-min idle disconnect | /tabletop | a party that moved on |
| 2-h hard cap | /tabletop | a session that outlives the party |
| 2-min idle hangup (30 s warning) | /call | a call left face-down |
| 60-min hard cap | /call | a forgotten tab |
| `expires_after: 120s` | all three | a leaked client secret being spendable |
| founders-only 404 | /call | anyone else minting a session at all |

**/live has no `noise_reduction` on purpose.** It would be a saving — fewer
committed segments — and it would gut the feature. `near_field` is tuned to
isolate one voice close to the microphone, and /live's entire job is the far side
of the room: the dinner table two seats down, the television, the film. /call and
/tabletop are the opposite case and both use it.

**Every auto-stop is turn-aware and warned.** /live warns 30 seconds before an
idle stop and 2 minutes before the 2-hour cap; it used to do neither — the
earpiece simply went quiet mid-dinner and the screen explained afterwards.
/tabletop never cuts anyone off mid-sentence: a cap that lands during a turn
waits for the turn to end, and the next tap mints a fresh session so invisibly
that nobody needs telling.

## Reading the meter

/call shows its own bill on screen, top-right of the video: `$0.12 · $0.058/min`.
That is **that phone's** share; the partner's phone spends its own.

/live and /tabletop have no on-screen meter, because neither client ever sees a
`response.done` — /live's summaries arrive as audio over WebRTC and /tabletop's
as streamed text, and the usage payload rides on an event the WebRTC data channel
delivers to nobody. What they have instead is a mint line:

```
vercel logs taos-lite | grep taos-live-mint
[taos-live-mint] pair=es->en model=gpt-realtime context_tokens=150 ttl=120s
[taos-tabletop-mint] pair=en->es model=gpt-realtime context_tokens=100 ttl=120s
[taos-call-mint] mode=clone pair=es->en model=gpt-realtime context_tokens=100 ttl=120s
```

The field to look at is `context_tokens`. A mint line reading `context_tokens=off`
is a session that will cost what /live used to, and it is worth being able to see
that without a redeploy.

For /call only, hang-up posts the tally and the server writes the closing line:

```
[taos-call-cost] room=AB123 mode=clone pair=es->en seconds=600 responses=48 \
  speech_s=241.3 audio_in_tok=1584 text_in_tok=15840 cached_tok=6720 \
  text_out_tok=960 audio_out_tok=0 tts=elevenlabs tts_chars=3400 \
  usd=0.2891 usd_per_min=0.0289
```

A `[taos-call-mint]` with no matching `[taos-call-cost]` is a call that crashed or
a tab closed mid-call — worth being able to see.

## What isn't on the bill

**Video is free.** /call is peer-to-peer WebRTC (`lib/call/session.ts`) — media
never touches a server, so pixels cost nothing however long the call runs or
however good the camera is. Supabase Realtime carries only the SDP/ICE handshake
and a few JSON blobs, on the project the app already pays for.

Connectivity is Google's public STUN. `NEXT_PUBLIC_TURN_URL` / `_USERNAME` /
`_CREDENTIAL` are wired but **unset**, so there is no relay today and no relay
bill. If a carrier NAT ever defeats P2P, a TURN provider becomes the first
per-gigabyte line item this app has ever had — worth pricing before it is
switched on, not after.

## Turning a cap off, or moving it

Each surface reads its own env var, and each refuses a number below 50 tokens
(about one VAD segment — below that the model answers a fragment of the sentence
it is meant to be translating, which is a quality cliff, not a saving):

```
OPENAI_LIVE_CONTEXT_TOKENS=200        # /live,     default 150
OPENAI_TABLETOP_CONTEXT_TOKENS=150    # /tabletop, default 100
OPENAI_CALL_CONTEXT_TOKENS=150        # /call,     default 100
```

Uncapped has to be asked for by name — `=off`, not `=0`. `=0` falls back to the
default. Uncapped is the setting that bills 460 % of what was said, and it should
not be reachable by fat-fingering a number.

## If these numbers go stale

`lib/call/cost.ts` holds the rate table with the date it was read. The one to
re-check first is ElevenLabs: it is the largest line item on /tabletop and in
/call's default mode, and the only rate here that depends on Tom's plan rather
than on a public list. If the meter ever disagrees with the invoice, start there.

Everything else can be re-measured rather than re-reasoned — that is what
`tests/live-fire/` is for, and it is why it is committed rather than thrown away.
