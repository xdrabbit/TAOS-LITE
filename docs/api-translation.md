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

### Request body

| Field       | Type                            | Required | Default  | Notes                                            |
| ----------- | ------------------------------- | -------- | -------- | ------------------------------------------------ |
| `text`      | `string`                        | yes      | —        | Text to translate. Empty/whitespace → `400`.     |
| `direction` | `"es-en" \| "en-es" \| "auto"`  | no       | `"auto"` | `"auto"` detects the source and flips to the other. |

### Response `200`

```json
{ "translation": "Hi, how are you? I miss you a lot.", "detectedSource": "es", "direction": "es-en" }
```

- `translation` — the natural-register translation.
- `detectedSource` — `"es"` or `"en"`. In `auto` mode this is what the model detected; otherwise it is implied by `direction`.
- `direction` — the resolved concrete direction (`auto` is reported as `es-en` or `en-es`).

### Errors

- `400` — empty `text` or non-JSON body.
- `500` — `OPENAI_API_KEY` not configured.
- `502` — provider error (`{ "error": string, "details": string }`).

### Example

```bash
curl -s http://localhost:3017/api/text-translate \
  -H 'Content-Type: application/json' \
  -d '{ "text": "Hola, ¿cómo estás? Te extraño mucho.", "direction": "auto" }'
```
