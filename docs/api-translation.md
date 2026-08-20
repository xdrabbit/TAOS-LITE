# Translation API

Two JSON endpoints for Spanish↔English, both backed by OpenAI (reusing
`OPENAI_API_KEY` and the `OPENAI_PARAPHRASE_MODEL` fast tier via
[`lib/translateProvider.ts`](../lib/translateProvider.ts)). Neither touches the
existing voice flow (`/api/translate`), ElevenLabs wiring, or turn caps.

Base URL in local dev is `http://localhost:3017` (see the `dev` script).

---

## `POST /api/live-translate`

Real-time "follow along" for a live conversation. Returns a **micro-summary of
the concept** (3–12 words), _not_ a translation. Optimized for latency: fast
model tier, `max_tokens ≈ 60`, low temperature.

### Request body

| Field       | Type                       | Required | Default   | Notes                                                                 |
| ----------- | -------------------------- | -------- | --------- | --------------------------------------------------------------------- |
| `text`      | `string`                   | yes      | —         | The latest speech chunk. Empty/whitespace → `400`.                    |
| `direction` | `"es-en" \| "en-es"`       | no       | `"es-en"` | Source→target language.                                               |
| `context`   | `string[]`                 | no       | `[]`      | Prior chunks/summaries, oldest first. Capped to the last 10 entries.  |

### Response `200`

```json
{ "concept": "she's asking about the rent payment", "isGuess": false, "direction": "es-en" }
```

- `concept` — the micro-summary (the `~` prediction marker is stripped from this field).
- `isGuess` — `true` when the model prefixed its output with `~` (a prediction/guess from context rather than clearly stated content).
- `direction` — echoes the resolved direction.

### Errors

- `400` — empty `text` or non-JSON body.
- `500` — `OPENAI_API_KEY` not configured.
- `502` — provider error (`{ "error": string, "details": string }`).

### Example

```bash
curl -s http://localhost:3017/api/live-translate \
  -H 'Content-Type: application/json' \
  -d '{
    "text": "y entonces le dije que no podía pagar hasta el viernes",
    "direction": "es-en",
    "context": ["talking about money", "landlord called earlier"]
  }'
```

---

## `POST /api/text-translate`

A **proper** translation for typed exchanges (when it is too loud for voice).
Natural, conversational register — not stiff or textbook-literal.

Takes a language **pair**, out of `lib/languages/catalog.ts`, like every other
language surface in the app. It spoke `"en-es" | "es-en"` until 8/19 and that
string is still accepted (see *Legacy* below), but it is no longer how the app
calls it.

### Request body

| Field            | Type                           | Required | Default  | Notes                                                        |
| ---------------- | ------------------------------ | -------- | -------- | ------------------------------------------------------------ |
| `text`           | `string`                       | yes      | —        | Text to translate. Empty/whitespace → `400`.                 |
| `sourceLanguage` | catalog code                   | no       | —        | The language the text is written in.                          |
| `targetLanguage` | catalog code                   | no       | —        | The language to translate into.                               |
| `direction`      | `"es-en" \| "en-es" \| "auto"` | no       | `"auto"` | Legacy. `"auto"` detects the source and flips to the other.   |

Send `sourceLanguage` **and** `targetLanguage` together — one alone is not a
pair and falls back as if neither was sent. They must be two *different*
languages; a repeated one is a `400`.

`"auto"` combines with an explicit pair: send both codes plus
`direction: "auto"` when you know the two languages but not which of them
typed. Detection then chooses between those two, not between English and
Spanish.

### Response `200`

```json
{
  "translation": "Zdravo, kako si? Puno mi nedostaješ.",
  "detectedSource": "en",
  "sourceLanguage": "en",
  "targetLanguage": "bs",
  "direction": "en-bs"
}
```

- `translation` — the natural-register translation.
- `sourceLanguage` / `targetLanguage` — the resolved pair, as catalog codes.
- `detectedSource` — same as `sourceLanguage`. In `auto` mode it is what the
  model detected; otherwise it is what was asked for. Kept for old clients.
- `direction` — the resolved pair as `"<source>-<target>"`. Now any pair of
  codes, not one of two strings.

### Tiers

Every catalog language is translatable as **text**, including tier-2 languages
that have no voice (`tts: false`). Nothing on this route consults the tier —
speech is decided at synthesis time by `requestSpeech` (`lib/tts/speech.ts`).

### Legacy

`direction: "es-en" | "en-es"` still resolves to that pair. Explicit language
codes win when both are sent. A body of `{ text }` alone still auto-detects
between English and Spanish, exactly as before.

### Errors

- `400` — empty `text`, non-JSON body, or `sourceLanguage` equal to `targetLanguage`.
- `500` — `OPENAI_API_KEY` not configured.
- `502` — provider error (`{ "error": string, "details": string }`).

### Example

```bash
curl -s http://localhost:3017/api/text-translate \
  -H 'Content-Type: application/json' \
  -d '{ "text": "I miss you a lot.", "sourceLanguage": "en", "targetLanguage": "bs" }'
```
```
