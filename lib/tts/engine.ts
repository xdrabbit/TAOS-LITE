// Which provider speaks a line on /api/tts. Its own module, apart from
// lib/tts/speech.ts, so a screen test that mocks the speech request still
// sees the real default.

export type TtsEngine = "elevenlabs" | "openai" | "fishaudio";

/**
 * The engine a subscriber's home screen starts on. ElevenLabs again since
 * 10/07: Fish Audio sounded acceptable on a computer and bad on the phone
 * (Tom, the morning after #85 made it the default). Fish stays one tap away
 * on the picker for more testing — it is just never chosen for anyone.
 * Pinned by tests/tts-default-engine.test.ts.
 */
export const SUBSCRIBER_DEFAULT_ENGINE: TtsEngine = "elevenlabs";
