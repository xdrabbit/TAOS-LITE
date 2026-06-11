# TAOS-LITE

A fast, dead-simple **push-to-talk translator** for two people sharing one iPhone.
Built for English ↔ Spanish, concept-level (not word-for-word) translation, with
optional spoken playback.

## How it works

1. **Speak** — tap the mic, say a full thought (a sentence or a 10-minute story), tap again.
2. **Translate** — audio is transcribed (OpenAI `gpt-4o-transcribe`) and rewritten as a
   natural, **first-person, concept-level paraphrase** in the other language (no robotic
   "he is saying…" narration).
3. **Read / hear it** — the translation appears in large text and reads aloud
   (ElevenLabs or OpenAI voice), automatically or on tap.

### Modes

- **Casual** — warm, conversational gist. Trims filler.
- **Detailed** — for important conversations. Preserves nuance, numbers, names, and emotion.
- **Swap** — flip the direction (Liz · Español ↔ Tom · English) with one tap.
- **Auto-play voice** — speak the translation automatically after each turn (Use Case 2),
  or turn it off and tap the speaker icon (Use Case 1).

The whole app is one screen: who's speaking, a tone toggle, the translation, and a big mic button.

## Pipeline

```
mic → MediaRecorder → POST /api/translate (transcribe → paraphrase) → text
                                                        ↓ (auto or on tap)
                                            POST /api/tts → spoken audio
```

All API keys stay **server-side** in Vercel env vars. The phone never sees a key.

## Environment

Copy `.env.example` to `.env.local` and fill in keys. Required: `OPENAI_API_KEY`.
For voice playback: `ELEVENLABS_API_KEY` (default engine) and/or the OpenAI key (OpenAI TTS).

`.env.local` is gitignored — never commit secrets.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3017`.

### iPhone / Safari microphone

`getUserMedia` requires a **secure context (HTTPS)**. Plain `http://` over the LAN will not
grant mic access in Safari. For real iPhone testing use the deployed HTTPS URL (Vercel), or a
local HTTPS tunnel (Tailscale Serve, ngrok, mkcert). Open in Safari and accept the mic prompt.

## Deploy (Vercel)

Push to a Git repo, import into Vercel, and add the env vars from `.env.example` in the Vercel
project settings. Vercel serves HTTPS by default, so iPhone mic + audio autoplay work out of the box.

## Validation

```bash
npm run lint
npm run typecheck
npm run build
```

Real mic + voice still require valid keys and a secure browser context.
