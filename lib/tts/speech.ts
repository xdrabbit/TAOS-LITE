// One way to ask /api/tts for audio — and one place that knows a language
// might not have any.
//
// /translate learned this first: consult the catalog BEFORE the request, and
// when the answer is tier 2 (lib/languages/catalog.ts) show the translated
// text and say nothing else. /chat, /live, /tabletop and /tutor each had their
// own fetch and their own idea of what a failure was, so a text-only language
// reached them as a red banner — the app apologizing for working as designed.
// They all call requestSpeech() now, and it answers `null` for "there is no
// audio to be had here", which every screen can render as quiet.
//
// This is deliberately NOT a React hook: the four screens want the blob at
// different moments (a queue on /live, a per-message cache on /chat, straight
// into an <audio> on /translate) and share only the request and its two
// non-answers. A hook would have to own playback state to be worth having,
// and playback is where those screens genuinely differ.

import { canSpeak, isLanguageCode } from "@/lib/languages/catalog";
import { personalVoiceHeaders } from "./personalVoiceClient";
import { authHeaders } from "@/lib/authClient";

/**
 * The one sentence the app says about a tier-2 language, in both households'
 * languages. Lives here rather than in TranslatorShell because five screens
 * now say it and four of them would otherwise say it slightly differently.
 */
export const TEXT_ONLY_TITLE = "Text only — no voice for this language · Solo texto";

/**
 * True only for a language the catalog KNOWS it cannot speak.
 *
 * Narrow on purpose, mirroring the fence in app/api/tts/route.ts: an absent
 * or unrecognized code is NOT text-only, it is "no opinion", and it keeps the
 * old pass-through behaviour (/tutor's drills carry no target language at all,
 * and /chat reads its codes out of a database row). Widening this to
 * `!canSpeak(code)` would turn every one of those into silence.
 */
export function isTextOnlyLanguage(code: string | null | undefined): boolean {
  return typeof code === "string" && isLanguageCode(code) && !canSpeak(code);
}

export interface SpeechRequest {
  text: string;
  /** Who spoke — picks the clone, per the voice-follows-speaker rule. */
  sourceLanguage?: string | null;
  /** What to speak. A tier-2 code here means no request is made at all. */
  targetLanguage?: string | null;
  engine?: "elevenlabs" | "openai";
  /** /live trades clone fidelity for the fastest model. */
  latency?: "flash";
}

/** fetch, or a wrapper around it — lib/net's fetchWithRetry fits as-is. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface SpeechOptions {
  /** Defaults to plain fetch; pass a fetchWithRetry closure to harden it. */
  fetch?: FetchLike;
  /** What to throw when the provider genuinely fails, in the caller's voice. */
  failureMessage?: string;
}

/**
 * Audio for a line of text, or `null` when there is none to be had.
 *
 * `null` is not an error and must never be rendered as one — it means the
 * language is text only, either because the catalog said so before the call or
 * because /api/tts said so during it. That second check is the stale-client
 * case: a phone holding an old bundle after a tier flips still degrades
 * quietly instead of flashing "This language is text only." at someone.
 *
 * Real failures (dead connection, provider 502, timeout) still throw, because
 * those ARE worth telling someone about and the screens already do.
 */
export async function requestSpeech(
  req: SpeechRequest,
  options: SpeechOptions = {}
): Promise<Blob | null> {
  if (isTextOnlyLanguage(req.targetLanguage)) return null;

  const { fetch: fetchImpl = fetch, failureMessage = "Voice playback failed." } = options;
  const res = await fetchImpl("/api/tts", {
    method: "POST",
    // Three separate things travel in these headers, and they are not
    // interchangeable:
    //   Authorization  — WHO is asking. /api/tts spends money and since 8/19
    //                    refuses a stranger (lib/spendGuard.ts). Every screen
    //                    that calls requestSpeech is behind sign-in, so this
    //                    is always present in practice; /try does not come
    //                    through here (it posts to /api/tts directly, on the
    //                    anonymous allowance).
    //   personal voice — WHICH voice they may have: the code that makes this
    //                    phone eligible for Tom's or Liz's clone. Absent on
    //                    every borrowed or shared phone, and then the reply is
    //                    the standard voice.
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
      ...personalVoiceHeaders()
    },
    // undefined fields drop out of JSON.stringify, so a caller that has no
    // opinion about a language sends no key and the server keeps its own.
    body: JSON.stringify(req)
  });

  if (!res.ok) {
    // One read of the body, then decide what it was: a 422 carrying
    // textOnly:true is the route's tier-2 refusal (app/api/tts/route.ts) and
    // is not a failure at all. Reading it twice would leave the real error
    // message behind on a consumed stream.
    const p = (await res.json().catch(() => ({}))) as {
      error?: string;
      details?: string;
      textOnly?: boolean;
    };
    if (res.status === 422 && p.textOnly === true) return null;
    throw new Error(p.details || p.error || failureMessage);
  }
  return res.blob();
}
