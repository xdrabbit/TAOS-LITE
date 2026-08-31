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

**Azure Translator is primary. `gpt-4.1-nano` with a literal prompt is the
fallback, and a real one** — it runs whenever the Translator resource is not
configured, and for the ten catalog languages Azure cannot translate at all.

Azure wins on **register and latency**. It loses on **cost**, by a lot, which
was the surprise: for a short quickie an LLM is roughly an order of magnitude
cheaper than a per-character MT service. Both numbers are below.

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
