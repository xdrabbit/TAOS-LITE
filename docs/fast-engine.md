# /fast — which engine, and what it costs

The `/fast` quickie box is the only surface in TAOS that translates
**literally**. Everything else asks for the translation "a fluent friend would
say"; this one asks for the plain word. That contrast is the feature, and it is
what made the engine an open question rather than "reuse what we have".

Measured 2026-08-30 on `feat/fast-route`. Rigs:

```
npx vitest run --config vitest.measure.config.ts tests/live-fire/fast-engine.measure.ts   # bake-off
npx vitest run --config vitest.measure.config.ts tests/live-fire/fast-route.measure.ts    # the shipped route
node tests/live-fire/fast-typing-browser-check.mjs                                        # the client's two clocks
```

---

## The decision

> **What is running today: `gpt-4.1-nano` with a literal prompt.** Every
> `/fast` translation in production comes from it. The Azure Translator
> resource **has not been created** — `AZURE_SPEECH_KEY` is a different
> resource kind and cannot open that API — so the code path that prefers Azure
> has never once executed outside a test. The badge on screen says which engine
> answered, so nobody reads an LLM translation believing otherwise.

`lib/fast/engine.ts` is *written* to prefer Azure Translator, and the reasoning
for that preference is below. It is a **design intent, not a measurement**, and
the honest state of it is worth stating plainly because the first version of
this page did not:

- Azure's register was compared on **fixtures**, not through the shipped route.
- Azure's **latency was never measured at all** — the table below says
  "not measured" in its own row, and the "roughly five times faster" figure
  quoted elsewhere came from Microsoft's documentation, not from this account.
- Azure's **cost is the one number that was measured**, and it came out
  backwards from the assumption: for a short quickie an LLM is roughly an
  order of magnitude *cheaper* than a per-character MT service.

So the decision to promote Azure is **pending Tom creating the resource** and
a re-run of the rigs above. Until then `gpt-4.1-nano` is not a fallback that
happens to be running — it is the engine, and the measured one. The ten catalog
languages Azure cannot translate at all stay on it permanently either way.

---

## Latency

| engine | p50 | p95 | how measured |
| --- | --- | --- | --- |
| `gpt-4.1-nano` | 559 ms | 1156 ms | 20 calls, provider only |
| `gpt-4.1-mini` | 593 ms | 779 ms | 20 calls, provider only |
| `gpt-5.4-nano` (`reasoning_effort: none`) | 470 ms | 1018 ms | 20 calls, provider only |
| **through the shipped route**, EN→ES | 702 ms | 751 ms | 6 quickies, `gpt-4.1-nano` |
| **through the shipped route**, EN→PL | 627 ms | 672 ms | 6 quickies, `gpt-4.1-nano` |
| Azure Translator | **not measured** | | no key on this account yet — see below |

Azure's *network* floor from the dev machine was measured against its
unauthenticated `/languages` endpoint: **181–236 ms** wall clock, of which
**57–110 ms** is TCP + TLS connect. So one warm request is on the order of
**100–120 ms** of round trip plus Azure's own processing. A warm Fluid Compute
instance amortises the connect entirely. Published guidance for the service is
sub-100 ms; **this repo has not confirmed that number and should not quote it
as measured** until the rig is run with a key.

## Cost per quickie

| engine | $/request | basis |
| --- | --- | --- |
| `gpt-5.4-nano` | $0.0000159 | measured token usage × $0.05/$0.40 per Mtok |
| `gpt-4.1-nano` | **$0.0000272** | measured token usage × $0.10/$0.40 per Mtok |
| `gpt-4.1-mini` | $0.0001090 | measured token usage × $0.40/$1.60 per Mtok |
| Azure Translator | **~$0.00026** | $10 per 1M source characters × a ~26-char quickie |
| Azure Translator, **auto-detect** | ~$0.00052 | auto sends both pair languages as targets, and Azure bills per character *per target* |

So Azure is **~10–20× the price of `gpt-4.1-nano` per quickie** — and still
only a fiftieth of a cent. At the server's own ceiling of 600 requests/hour per
account (`lib/fast/rateLimit.ts`) the worst case is **$0.31/hour on Azure** or
**$0.016/hour on nano**. Neither is a number worth optimising; the register is.

## Register — why Azure wins anyway

The literal prompt had to be measured twice, because the first version of it
was actively harmful.

**Draft 1** ("word for word, keeping the original word order"):

| input | `gpt-4.1-nano` EN→PL | what is wrong |
| --- | --- | --- |
| how much does this cost | `ile to to kosztuje` | word doubled |
| how do I get to the | `jak ja dostanę się do the` | English article left in a Polish sentence |
| two coffees please | `dwa kawy proszę` | wrong gender (`dwie`) |
| I am looking forward to it | `Ja jestem oczekując na to` | ungrammatical |

Told to preserve source word order at any cost, a model will break the target
language's grammar to do it. A broken quickie is not a more faithful quickie.

**Draft 2** (the shipped `LITERAL_RULE`) keeps the register and states the
grammar floor out loud. Every one of those defects cleared:
`ile to kosztuje`, `jak dostać się do tego`, `dwie kawy proszę`. Same lesson as
the 7/27 dropout fence — a prompt fence that only pushes one way pushes past
the thing it was protecting.

But draft 2 also exposed the real split. With the grammar floor in place, the
larger models **drift back to idiomatic**, which is the one thing this screen
must not do:

| input | `gpt-4.1-nano` | `gpt-4.1-mini` | `gpt-5.4-nano` |
| --- | --- | --- | --- |
| it costs an arm and a leg (PL) | `to kosztuje rękę i nogę` ✅ literal | `to kosztuje ramię i nogę` ✅ | `to kosztuje majątek` ❌ idiomatic |
| I am looking forward to it (PL) | `Czekam na to` | `Nie mogę się tego doczekać` ❌ | `Na to czekam` |
| no worries (PL) | `nie martwi się` | `nie martw się` | `bez obaw` ❌ idiomatic |
| I am looking forward to it (ES) | `Estoy mirando hacia adelante a ello` ✅ | `Estoy esperando con ansias eso` ❌ | `Estoy deseando eso` ❌ |

`gpt-4.1-nano` held the literal register best **and** was a quarter the price of
mini — which is why it is the fallback model rather than the app's usual
`OPENAI_PARAPHRASE_MODEL` (gpt-4.1-mini). `lib/fast/engine.ts` reads its own
`OPENAI_FAST_MODEL` var for exactly this reason: a screen whose brand is the
literal register must not move when somebody retunes a conversational one.

A neural MT model needs none of this argument. It cannot be talked into
answering the question instead of translating it, it cannot drift idiomatic
under a longer prompt, and it does not need a grammar floor written down. That
is what Azure is being bought for.

---

## Setting up the Azure resource — steps for Tom

The app already has `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION` (tutor Crawl
pronunciation scoring). **Those do not work here.** Translator is a separate
resource kind with its own keys; a Speech key sent to the Translator API comes
back 401. `lib/fast/azure.ts` deliberately does not read the Speech vars, so
"the resource does not exist yet" stays a readable state instead of becoming a
401 nobody can explain.

1. **Portal** → <https://portal.azure.com> → **Create a resource** → search
   **Translator** → *Create*.
2. Subscription + resource group: the same ones the Speech resource uses.
   **Region:** pick the one nearest the users (e.g. `eastus`) — the region is
   part of the credential and has to match what goes in the env var.
   **Pricing tier:** **F0 (Free)** is 2M characters/month and is several
   hundred thousand quickies — start there. **S1** is the $10/1M-characters
   pay-as-you-go tier if F0 is ever exceeded.
3. When it deploys: **Keys and Endpoint** → copy **KEY 1** and the **Location /
   Region** (the short form, e.g. `eastus`, not "East US").
4. Add both to Vercel — **Production and Preview**, and nothing else. Scope
   them explicitly; the Stripe live key leaked into Preview in August because
   Vercel's default is shared:

   ```
   vercel env add AZURE_TRANSLATOR_KEY production
   vercel env add AZURE_TRANSLATOR_KEY preview
   vercel env add AZURE_TRANSLATOR_REGION production
   vercel env add AZURE_TRANSLATOR_REGION preview
   ```

5. Redeploy. `/fast` switches engines by itself — no code change — and the
   badge at the bottom of the screen changes from "literal AI" to
   "Azure Translator", which is how to confirm it took.
6. Fill in the Azure row of the latency and cost tables above:

   ```
   AZURE_TRANSLATOR_KEY=… AZURE_TRANSLATOR_REGION=… \
     npx vitest run --config vitest.measure.config.ts tests/live-fire/fast-engine.measure.ts
   ```

**Until then `/fast` works**, on `gpt-4.1-nano`, and says so on screen. It does
not fail, and it does not pretend to be Azure.

---

## Language coverage

Azure Translator covers **90 of the catalog's 100** languages. Five need a code
translation, and each is a script or register choice rather than a rename:

| catalog | Azure | why |
| --- | --- | --- |
| `zh` | `zh-Hans` | Azure splits Chinese by script; the catalog's 中文 row means Simplified. `yue` is its own row in both. |
| `tl` | `fil` | Azure ships Filipino, the standardised register of Tagalog. |
| `no` | `nb` | No macrolanguage "no"; Bokmål is what the Norsk row means (`nn` is separate). |
| `mn` | `mn-Cyrl` | Mongolian in Cyrillic. |
| `sr` | `sr-Cyrl` | Serbian in Cyrillic — the official script. |

**Ten have no Azure support at all** and always take the LLM engine:
Breton, Hawaiian, Javanese, Latin, Norwegian Nynorsk, Occitan, Sanskrit,
Sundanese, Tajik, Yiddish.

Both lists are checkable without a key, which is why they are asserted rather
than trusted (`tests/fast-engine.test.ts`):

```
curl "https://api.cognitive.microsofttranslator.com/languages?api-version=3.0&scope=translation"
```

---

## What a keystroke storm costs

`/fast` is the only route in the app called *while somebody is still typing*, so
"many requests a minute from one account" is its normal shape. Two separate
controls, and conflating them is the bug this screen could most easily have
shipped.

| control | value | what it bounds |
| --- | --- | --- |
| client debounce | 300 ms | provider calls — the cost of the screen working |
| client settle | 1500 ms | `taos_lite_translations` rows — the cost to the person |
| server per-user | 60/min | a runaway that ignores both |
| server per-user | 600/hr | a runaway nobody notices until morning |

Measured on the real component in a real browser (21 characters, two bursts
around a 700 ms think):

```
  mid-think:  1 POST /api/fast   0 billed rows
  settled:    2 POST /api/fast   1 billed rows
  per-keystroke would have been 21 of each.
```

Measured against the real route with a driver that ignores the debounce
entirely (70 requests as fast as a loop can send them):

```
  60 served, 6 refused (429), 60 provider calls paid for
```

The free monthly allowance is a **count of `taos_lite_translations` rows**
(`lib/supabase.ts`, `getMonthlyUsage`) — the same rows the home screen writes
when a spoken turn finishes. `/fast` writes one per *settled* input, so it
meters into the normal allowance rather than growing a private counter that
would have to be reconciled later. It is the History entry too.

## The mic

`/fast` is a typing screen with a mic on it, and that ordering is the design.
Dictating does not produce a *translation* — it produces **text in the input
box**, which the two clocks above then translate and bill exactly as if it had
been typed. That is what makes it a quickie rather than a spoken turn: the
transcript is a draft you can fix before it means anything, and a mis-heard
word costs a keystroke instead of a lookup.

### Two mics, one button

The mic runs in one of two modes, decided **per press** (`lib/fast/useLiveDictation.ts`):

| | **stream** (preferred) | **batch** (fallback) |
| --- | --- | --- |
| provider | Azure Speech, websocket from the phone | OpenAI Whisper, via `POST /api/fast/listen` |
| feels like | words appear while you talk | one lump on release |
| languages | 76 of the catalog's 100 | all 100 |
| credential | 10-min token from `POST /api/fast/speech-token` | the session's own bearer token |

Streaming is why the mic exists in this shape. The first version was batch-only,
and Tom's field report was that it *feels dead while talking* — right feature,
wrong screen for a progress bar. `/fast` is the screen whose whole soul is
instant.

**Audio does not go through Vercel.** The socket is opened from the browser
straight to Azure, because a function hop per 100 ms of speech would spend
exactly the latency this exists to save. That means a credential has to live in
the browser — so `AZURE_SPEECH_KEY` never does. `POST /api/fast/speech-token`
mints a ten-minute JWT that can do nothing but recognise speech, the same shape
as `/api/realtime/session` minting an ephemeral OpenAI key. It carries the same
`fastVisibleTo()` gate and the same `checkFastRate` buckets as everything else
on `/fast`.

> **The Speech resource is not the Translator resource.** `AZURE_SPEECH_KEY` /
> `AZURE_SPEECH_REGION` already exist in Vercel — the tutor's Crawl
> pronunciation scoring uses them, and streaming recognition is another API on
> that same resource kind. They are **not** `AZURE_TRANSLATOR_KEY` /
> `AZURE_TRANSLATOR_REGION`, which are still uncreated and which the literal
> translation engine above wants. Crossing the two gives a 401 that reads like
> a bug.

**Partials are drawn; only finals are text.** This is the one rule that makes a
live mic affordable here, and it is invisible when it breaks — nothing looks
wrong, it just costs more. Azure emits a re-guessed hypothesis several times a
second. Those render as a dimmed tail and are held *outside* `input`, so they
never start the 300 ms debounce. Finalized segments become real editable text
and are translated like any other keystroke — roughly one translation per pause
for breath, which is the same rate a person typing the phrase would produce.
Wiring partials into the box instead would have fired dozens of per-character
billed Azure Translator calls per spoken phrase to render text that was about to
be replaced anyway. `lib/fast/liveTranscript.ts` holds the rule.

The **settle clock is untouched**: one settled input still bills one row, however
many segments it arrived in.

### Auto-detect: what it costs, measured

The obvious design was "fill the candidate list" — Azure allows 4 languages for
at-start identification and 10 for continuous, so why not send the pair plus
whatever else this phone has been reaching for? Because it is the difference
between the feature working and not.

Same 4.15 s clip, pushed at wall-clock speed to a real Azure endpoint, two runs
each. **Time until the first word appears on screen:**

| candidates | LID mode | first word |
| --- | --- | --- |
| 1 (pinned direction) | none | **795 / 821 ms** |
| 2 (the pair) | Continuous | **2422 / 2416 ms** |
| 2 (the pair) | AtStart | 3826 / 3845 ms |
| 4 | AtStart | 3806 / 3807 ms |
| 4 | Continuous | 4493 / 4494 ms |

**All five produced an identical transcript.** So the extra candidates bought
nothing at all and cost up to two seconds of the one thing this feature exists
to deliver. A quickie is often shorter than four seconds — with a four-candidate
list the words would land *after* you stopped talking, which is the batch mic
with extra steps.

Hence: **never more than the two pills, and Continuous rather than AtStart.**
AtStart buffers ~3 s of audio to decide once; Continuous keeps deciding, which
is worth 1.4 s here. The mode name is misleading for this use — nobody changes
language mid-quickie; it is bought purely for the latency.

A third language could not have helped anyway. `/fast` translates *between* the
two pills, so a sentence confidently recognised in a language on neither of them
is one this screen cannot do anything with — and Azure returns one of the
candidates even when the audio was none of them.

**Pinning the direction is the fast path**, and it is a real reason to touch the
swap button: one language means no identification step at all, ~800 ms instead
of ~2400 ms. It also rescues pairs Auto has to refuse — pinning needs only the
*one* language to be streamable, so English-with-Latin still streams if you pin
to English, where Auto hands the whole job to Whisper.

In Auto both sides are required, for the reason above: a recogniser that hears
only one pill would silently mangle every sentence said in the other.

The 24 catalog languages Azure Speech cannot hear are permanently batch-mic
languages, listed in `lib/fast/speechLocale.ts` and pinned in
`tests/fast-live-dictation.test.ts`. Where both providers know a language, the
locale table **agrees with the tutor's** (`es-MX`, `pt-BR`, `ar-EG`, `zh-HK`) —
a phone that scores Tom's Spanish as `es-MX` and transcribes it as `es-ES` would
be two opinions about the same voice.

**The fallback is silent, and it is frequent by design.** Token failure, a dead
socket, an unsupported browser, an unstreamable pair — all of them land in the
batch mic with nothing said about it. A mic that explains why it is in its
slower mode is a mic that interrupts somebody mid-errand to discuss
infrastructure. The decision is re-made on every press, because the reasons
streaming fails are mostly weather; a phone that fell back once and then refused
to stream for the rest of the trip would be a worse bug than the one this fixes,
and an invisible one.

While the tail is on screen the box is a live view rather than a `<textarea>` —
same box, same metrics, no caret. A dimmed tail cannot be drawn inside a
textarea, and showing tentative words as though they were settled text would be
the worse lie. It ends the moment you stop talking, and the textarea returns
with the caret at the end. For the same reason the stop button is labelled
**Done** while streaming (the words are already in the box; there is nothing to
take back) and **Cancel** in batch (stopping really does discard).

### Walked against real Azure, 2026-08-30

`AZURE_SPEECH_KEY` is a write-only Vercel secret, so the token was minted by a
temporary secret-guarded probe route deployed with `vercel deploy --env`
(deployment-scoped), then the audio was pushed to Azure at wall-clock speed —
100 ms of PCM every 100 ms, because a rig that shoves the whole wav in at once
reports latencies no microphone can produce. Both the probe route and the
deployments carrying it were removed afterwards.

Auto (`["en-US","es-MX"]`, Continuous), 4.15 s of English:

```
  2374ms  partial  "where is the pharmacy"
  2471ms  partial  "where is the pharmacy i have"
  2573ms  partial  "where is the pharmacy i have a headache"
  ...
   FINAL  "Where is the pharmacy? I have a headache and I need
           something for it please."            [en-US]
  -> first words on screen 1777ms BEFORE the speech ended
```

The same pair, unchanged, given 6.25 s of Spanish — nobody told it which:

```
  2478ms  partial  "dónde está"
  2579ms  partial  "dónde está la farmacia"
  2603ms  FINAL    "¿Dónde está la farmacia?"   [es-MX]
  3218ms  partial  "me"
  ...
  -> first words 3773ms BEFORE the speech ended
```

That second run is also the partial→final→commit→new-partial cycle happening
for real: a finished clause commits and the tail empties, then the next clause
starts guessing again. It is what `stepTranscript` is written against.

Pinned to English (one language, no LID): first words at **803 ms**.

**The fallback was walked separately**, in a real browser with a real
`MediaRecorder` and a fake microphone
(`tests/live-fire/fast-dictation-browser-check.mjs`, run with no
`AZURE_SPEECH_KEY` present). `/api/fast/speech-token` answered 404, the mic
degraded to the batch path without a word about it, and the whole batch flow
passed unchanged: 1 upload → transcript in the box → 1 billed row → every audio
track ended → tap-to-latch still works.

### The batch path

`POST /api/fast/listen` — audio in, transcript out, and nothing else.

| | |
| --- | --- |
| gate | `fastVisibleTo()`, same 404-not-403 as `POST /api/fast` |
| meter | the **same** `checkFastRate` buckets as typing — 60/min, 600/hr |
| allowance | none of its own; the row is still written when the input settles |
| max recording | 30 s (client), 2 MB (server) |
| min recording | 600 ms — below that it is a fumbled tap, dropped before upload |
| upstream timeout | 45 s, under the route's 60 s `maxDuration` |

Three deliberate choices worth keeping:

**It is not a call to `/api/translate`.** That route transcribes *and*
paraphrases, and `/fast` would throw the paraphrase away: it wants the words in
a box, and the translation then comes from the literal engine above rather than
the house voice. Calling it would have bought a `gpt-4.1` completion per
dictation, in the wrong register, to discard it.

**The transcriber is shared, not copied.** `lib/translate/transcribe.ts` is
`/api/translate`'s transcriber lifted out unchanged, and both routes call it.
Its fences are not incidental — `STT_NO_GUESS_RULE` (Liz, 7/27: a signal dip
turned *montar bicicleta* into *montar un caballo*), the Cantonese
colloquial-written-form hint, and the "no usable speech" path that makes a
rapid double-tap a gentle retry instead of raw provider JSON. A fourth
hand-rolled copy of that fetch would have shipped with none of them.

**The rate buckets are shared on purpose.** A mic with its own counter is a
second way to spend on `/fast` that the `/fast` ceiling cannot see, and it is
the *pricier* of the two calls. Speaking is metered against the same minute as
typing.

Walked in a real browser with a real `MediaRecorder`
(`tests/live-fire/fast-dictation-browser-check.mjs`, 2026-08-30):

```
  held the mic 1.5s
  upload(s) to /api/fast/listen  1
  transcript landed in the box   "where is the pharmacy"
  translation on screen          "dónde está la farmacia"
  billed rows                    1
  every track ended afterwards   true

  then " open" typed onto the transcript:
  billed rows (cumulative)       2     <- an edit is a second, honest lookup

  then a TAP instead of a hold:
  still listening after release  true  <- latched; the next tap ends it
```

One trap for whoever runs that rig next: Chrome's fake-microphone flag is
`--use-fake-device-for-media-**stream**`, not `-for-media-capture`. A
misspelled Chrome flag is silently ignored, so the first run opened the
machine's real microphone, got `NotReadableError`, and looked exactly like a
broken mic button.

### The iPhone, and the mic that looked alive

**2026-08-31.** Tom's field report: the mic "has trouble" on iPhone. Desktop
fine. The failure was the worst shape a mic can take — the button lit, the
timer counted, the socket to Azure was genuinely open, and no word ever
appeared. A dead mic wearing a working one's face.

**Root cause: the AudioContext was built outside the tap.** The Speech SDK's
`MicAudioSource.turnOn()` does three things in this order —
`new AudioContext({ sampleRate: 16000 })`, then `resume()` if it is suspended,
then `getUserMedia`. WebKit only lets an AudioContext start if it was
constructed *inside* a user gesture, and only lets `resume()` start one if
`resume()` is itself called inside one. The SDK does both from inside
`startContinuousRecognitionAsync`, and the hook reached that only after
`await ensureWarm()` — a token fetch. By then the tap's task was over.

WebKit does not throw for this. It resolves the promise and leaves the context
stopped. So:

```
  press → token fetched → recogniser starts → socket OPENS → button lights
        → AudioWorklet never runs → zero PCM sent
        → Azure hears digital silence on a continuous session
        → no partial, no final, NO CANCELLATION
        → nothing rejects → nothing falls back → dead until you leave the page
```

The old fallback fired on exactly one signal — `beginStream` threw — and this
is the one platform that never throws.

**The fix (`lib/fast/micCapture.ts`).** The hook owns the microphone now. The
context is constructed, resumed, and handed `getUserMedia` **synchronously in
the press handler**, with no `await` in front of any of them, and the PCM is
pushed into the recogniser through `AudioConfig.fromStreamInput`. The SDK never
touches the mic. Two details are load-bearing:

- **No forced sample rate.** The SDK asks for a 16 kHz context; iOS runs its
  capture session at the hardware rate and a graph built at a rate the session
  is not running at is a second, separate silence bug. Take what the phone
  gives and resample (the same box average the SDK's own `RiffPcmEncoder` uses,
  so Azure hears what it always did).
- **`openMicCapture` is not `async`.** The moment it becomes an async function
  the three calls move behind a microtask and the bug returns invisibly. There
  is a test that fails if it does.

**Four ways streaming gives up, not one.** Three of them are watchdogs
(`micVerdict`), because the failure that mattered never raised anything:

| # | signal | fence | what happens |
| --- | --- | --- | --- |
| 1 | `beginStream` threw | — | batch mic, silently |
| 2 | handshake still hanging | `STREAM_CONNECT_MS` 3 s | batch mic, silently |
| 3 | **zero PCM delivered** | `MIC_SILENT_MS` 1.5 s | batch mic — the iPhone case; nothing was heard, so nothing is lost |
| 4 | voiced audio, no hypothesis back | `STREAM_DEAF_MS` 4 s | **salvage**: keep the capture, post what it already holds as one WAV |

Row 4 is measured in *voiced* audio and not wall clock, so somebody who presses
the mic and then thinks for ten seconds is not read as a broken socket. And it
salvages rather than restarts, because restarting into the batch mic would
throw away exactly the four seconds that diagnosed the problem.

One press opens **one** microphone however many recognisers it passes
through — *unless the microphone is what is being accused*. A socket-side
failure (row 1 and row 2 above) hands its already-granted stream down via
`detachStream()` / `adopt`, rather than stopping every track and asking the
phone again; the browser rig counts the streams and caught that regression
when it was written the other way.

The **dead-graph** verdict is the exception, and the reason is the whole
layer-2 argument. Rule 3 of that verdict fires when chunks *are* arriving and
every sample in them is zero, which rules out the AudioContext and points at
the **track**. Handing that track to `MediaRecorder` records the same zeroes —
both lanes dead, one field report. So that path stops every track and lets
`useDictation` call `getUserMedia` for itself.

It rests on an assumption that **no engine here can check**: that a second
`getUserMedia` in the same document does not re-prompt once permission has
been granted — `getUserMedia`, unlike `AudioContext.resume`, has no transient
activation requirement, and Safari's grant is per-document. If that is wrong
on a real iPhone the failure is benign and visible: the prompt goes up
mid-press, and `useDictation`'s pending-latch rule already holds that press
open until the answer lands (it was written for the permission prompt in the
first-ever dictation). A refused second grant surfaces as *"Microphone access
was denied"* rather than a lit button, and `tests/fast-mic-fresh-stream.test.ts`
pins that path too.

**What no engine here could prove.** Chrome reports a fresh `AudioContext` as
`running` at birth — measured both with and without
`--autoplay-policy=user-gesture-required`, and with and without microphone
permission. Firefox has no gesture rule for the capture graph either.
Playwright's WebKit is a desktop build that does not enforce the phone's
audio-session rules, and on this machine will not launch without root-installed
system libraries. **This bug is invisible to every engine CI can reach**, which
is exactly why it shipped. What *is* proven automatically:

- `tests/fast-mic-capture.test.ts` — the three calls and their order, against a
  fake Web Audio that stays suspended the way WebKit does; every counter and
  every `micVerdict` branch. Mutation-checked: reintroducing the await, forcing
  16 kHz, or dropping the dead-graph rule each turns a test red.
- `tests/live-fire/fast-mic-capture-browser-check.mjs` — the shipped module in
  real Chrome, opened from a real click: 960 frames, 2.58 s of genuine 16 kHz
  mono PCM, a valid WAV.

### The two-minute phone check — for Tom

Run it **twice**: once in a **Safari tab**, once in the **installed PWA**
(Share → Add to Home Screen, then open from the icon). Permission and capture
behave differently in standalone, and that is the pair that has never been
compared.

1. Open `/fast`. Leave the pills on **Auto**, English ↔ Spanish.
2. **Hold** the mic and say, slowly: *"where is the pharmacy"*. Keep holding
   for a beat after you finish, then let go.

   Watch the box **while you are still talking**, and score it:

   | | what you see | verdict |
   | --- | --- | --- |
   | ✅ | dim words appear mid-sentence and firm up as you go | **streaming** — fixed |
   | ⚠️ | nothing until you let go, then the whole phrase lands ~1–3 s later | **lumpy** — the fallback did its job; say which |
   | ❌ | nothing lands, ever, button stays lit | **dead** — not fixed; say so |

   The first press of the visit includes the permission prompt, so judge on the
   **second** press.
3. **Tap** the mic instead of holding it. The banner must read *"Listening —
   tap to stop"* and it must keep listening with your finger off the glass.
   Say something, tap again, check the words land.
4. Fix one word in the box by typing. The translation underneath should follow.
5. Only if you saw ⚠️ or ❌: note **which context** (tab or PWA), whether the
   first press differed from the second, and whether it was on **wifi or
   cellular**.

That is the whole run. What matters most is step 2's three-way answer in each
of the two contexts — six observations, and the difference between "the fix
landed", "it fell back safely" and "it is still broken".

#### What each answer would actually mean

Round 3 added a second layer to the fallback, so the ⚠️ and ❌ answers now
say different things than they did. Worth knowing before you look:

- ✅ **live words** — the win. The streaming mic works on your phone; nothing
  below applies.
- ⚠️ **lumpy lump** — the layer-2 fix is working and streaming is still dying.
  The mic is not dead, the fallback caught it, and a fresh `getUserMedia`
  recorded what the streaming track would not. **Report this one** — it means
  the zeroes are coming from the capture track, which is the hypothesis this
  round was built on and nothing here can confirm without your phone.
- ❌ **4 seconds and nothing** — there is a *third* layer, below both of
  these. Both a Web Audio graph and a brand-new MediaRecorder stream came back
  empty, which is a phone that is not giving this page audio at all.
- 🔁 **works, then goes lumpy after several reloads** — not the microphone.
  That is `TAOS_FAST_SPEECH_LIVE_TOKENS` (default 6) refusing a seventh live
  credential; a token lives ten minutes and does not survive a reload, so a
  reload-heavy test can legitimately reach it. The runtime log says
  `speech_tokens_live`. Raise the number for the test rather than lowering it
  for production.

Press the mic **more than once** in each context, and reload at least once.
Several of the bugs found in rounds 2 and 3 only show on the second press or
after a reload, which is exactly the press a desktop walkthrough never makes.
