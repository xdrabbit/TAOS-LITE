# What a translated call costs

*Measured 2026-08-27, against live `gpt-realtime` sessions. Everything below is
a number that came back from the API, not an estimate of one.*

/call was pulled from RC1 for two reasons. The first — it was never wired to the
language catalog — was a bug. The second was this: **nobody could say what a
minute of it cost.** The July 14/22 OpenAI spikes were noticed on a bill, weeks
after the calls that caused them, with no way to attribute them to anything.

This document is the answer, and `lib/call/cost.ts` is the same arithmetic
running on the phone while the call is happening.

## The four things a call pays for

| | rate | what drives it |
|---|---|---|
| audio **in** | $32 / Mtok | speech the input VAD **commits** — 1 token per 100 ms |
| audio **out** | $64 / Mtok | speech the model **generates** — ~25 tok/s |
| text in / out | $4 / $16 per Mtok | the instructions, re-sent every response |
| transcription | $0.003 / min | `gpt-4o-mini-transcribe`, on committed audio |
| ElevenLabs | $0.05 / 1k chars | flash v2.5, when the app speaks instead of the model |

Two phones are on a call, each running its own interpreter session on the
*other* person's audio. Every figure below is **per phone**; a call costs twice
it.

## The finding that mattered

The obvious saving was to stop streaming silence into the session. It turns out
there was nothing there to save:

> "Audio input is billed at 1 token per 100 ms. Voice activity detection will
> effectively filter out empty input audio, so empty audio doesn't count as
> input tokens." — OpenAI, *Managing costs*

Measured: 34.1 s of audio streamed into a session, **22.7 s billed**. The
difference was the silence between utterances. A client-side speech gate would
have bought a way to clip the first syllable of a sentence in exchange for
nothing — so `/call` doesn't have one.

The real cost was somewhere much less obvious. **Every response re-reads the
whole conversation, as audio, at $32/Mtok.** Five consecutive Spanish
utterances, same audio each run, changing only the `truncation` setting:

| `truncation` | input audio billed | per-turn `in_audio` | model cost, 5 turns |
|---|---|---|---|
| default (`"auto"`) | **209 %** of speech | 49 → 100 → 164 → 175 → 227 | $0.0154 |
| `post_instructions: 200` | 148 % | ~100–126 | $0.0245 \* |
| **`post_instructions: 100`** ← shipped | **66 %** | flat ~52 | **$0.0129** |
| `conversation.item.delete` after each turn | 51 % | flat, but see below | $0.0116 |

\* *that run drew zero cache hits; caching is luck of the draw turn to turn,
which is itself an argument for keeping the context small enough not to need it.*

Read the third column, not the fourth. Over five turns the totals are close
together; what separates them is the **trend**. Uncapped, the audio re-read per
response climbs for as long as the call lasts — a 40-minute call pays for the
first minute forty times over. Capped, it is flat, and a call's cost becomes
linear in how much people actually say.

Explicit `conversation.item.delete` was cheaper still and is **not** shipped: it
raced the response it was pruning for, and two turns came back having been given
no audio at all (`in_audio: 0`), producing degenerate output. Declarative
truncation lets the server decide what it can spare.

Translation quality at `post_instructions: 100` was indistinguishable from 200.
Both, translating Spanish into Italian:

> heard: *"El tren sale a las cuatro y media, así que tenemos como una hora."*
> → *"Il treno parte alle quattro e mezza, quindi abbiamo circa un'ora."*

## The other lever: who speaks

The same utterance, same session, measured both ways:

| | in audio | in text | out text | out audio | model cost |
|---|---|---|---|---|---|
| `output_modalities: ["text"]` | 21 | 127 | 10 | 0 | **$0.00134** |
| `output_modalities: ["audio"]` | 21 | 127 | 16 | **43** | **$0.00419** |

Model-spoken audio is 3× the cost of the entire text response. So the default
("Their voice") asks for text and hands it to `/api/tts`, which means the app's
own voices — Liz's clone reading her own sentence in English, per the
voice-follows-speaker rule in `lib/tts/voice.ts`. That is **cheaper and the
better voice**, and it is the one place on this screen where the cheap option
was also the good one.

It costs about a second: the sentence has to finish before it can be
synthesised. That second is the one thing here that could not be measured
without two real phones on real cellular, which is why "⚡ Fastest" is still a
tap away on the lobby screen. If Tom finds the lag matters more than the voice,
quality wins and the toggle is already there.

## Before and after, per minute of call

A 10-minute call, each person speaking ~40 % of it (~48 utterances each):

| | before | after (Their voice) | after (Fastest) |
|---|---|---|---|
| audio in | $0.161 | $0.051 | $0.051 |
| instructions re-sent | $0.042 | $0.042 | $0.042 |
| transcription | $0.012 | $0.012 | $0.012 |
| model speech out | $0.401 | — | $0.401 |
| text out | — | $0.015 | — |
| ElevenLabs | — | $0.170 | — |
| **per phone** | **$0.616** | **$0.290** | **$0.506** |
| **per call (two phones)** | **$1.23** | **$0.58** | **$1.01** |
| **per minute** | **$0.123** | **$0.058** | **$0.101** |

**53 % off, at a better voice.** And the "before" column is generous to the old
code: 209 % is what the re-read cost over *five* turns, and it was still
climbing. On a 40-minute call the old number is much worse and the new one is
not, because the cap holds it flat.

## What isn't on the bill

**Video is free.** The call is peer-to-peer WebRTC (`lib/call/session.ts`) —
media never touches a server, so pixels cost nothing however long the call runs
or however good the camera is. Supabase Realtime carries only the SDP/ICE
handshake and a few JSON blobs, on the project the app already pays for.

Connectivity is Google's public STUN. `NEXT_PUBLIC_TURN_URL` /
`_USERNAME` / `_CREDENTIAL` are wired but **unset**, so there is no relay today
and no relay bill. If a carrier NAT ever defeats P2P, a TURN provider becomes
the first per-gigabyte line item this feature has ever had — worth pricing
before it is switched on, not after.

## Guards, and what each one stops

| guard | where | stops |
|---|---|---|
| `truncation.token_limits.post_instructions: 100` | mint route | cost growing with call length |
| text output + `/api/tts` | interpreter, default | the single largest line item |
| `noise_reduction: near_field` | mint route | a passing bus becoming a billed turn |
| 2-min idle hangup (30 s warning) | interpreter | a call left face-down on a table |
| 60-min hard cap (was 4 h) | interpreter | a forgotten tab |
| `expires_after: 120s` | mint route | a leaked client secret being spendable |
| founders-only 404 | both routes | anyone else minting a session at all |

## Reading the meter

On screen, top-right of the video, while the call runs: `$0.12 · $0.058/min`.
That is **this phone's** share; the partner's phone spends its own.

At hang-up the phone posts its tally and the server writes one line:

```
vercel logs taos-lite | grep taos-call-cost
[taos-call-cost] room=AB123 mode=clone pair=es->en seconds=600 responses=48 \
  speech_s=241.3 audio_in_tok=1584 text_in_tok=15840 cached_tok=6720 \
  text_out_tok=960 audio_out_tok=0 tts=elevenlabs tts_chars=3400 \
  usd=0.2891 usd_per_min=0.0289
```

A `[taos-call-mint]` line with no matching `[taos-call-cost]` is a call that
crashed or a tab that was closed mid-call — worth being able to see.

## If these numbers go stale

`lib/call/cost.ts` holds the rate table with the date it was read. The one to
re-check first is ElevenLabs: it is the largest line item in the default mode
and the only rate here that depends on Tom's plan rather than on a public list.
If the meter ever disagrees with the invoice, start there.
