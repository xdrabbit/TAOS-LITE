// The fences on /fast's mic — the numbers the browser and the route BOTH need.
//
// /fast is a typing screen. The mic is the sausage-finger lane onto the same
// box: hold it, say the thing, and the words land in the input where they can
// still be fixed before they mean anything. That framing is what sets these
// numbers, and it is why none of them match the home screen's.
//
// A spoken TURN on the home screen can run five minutes — somebody telling a
// pharmacist what happened. A spoken QUICKIE is a phrase. So the cap here is
// thirty seconds, not three hundred, and it is a kindness as much as a bill
// limit: a pocket-dialled mic that ran to /api/translate's ceiling would
// upload five minutes of a coat before anybody noticed.
import { type LanguageCode } from "@/lib/languages/catalog";
import { CANTONESE_STT_HINT } from "@/lib/translate/prompts";

/**
 * The longest single dictation.
 *
 * Transcription is billed per second of audio, so this is the same kind of
 * fence as ANON_MAX_AUDIO_BYTES on /api/translate: not a quality limit, a
 * bill limit. Thirty seconds is several times any real quickie — FAST_MAX_CHARS
 * is 500 characters and nobody speaks that in less.
 */
export const FAST_MAX_DICTATION_MS = 30000;

/**
 * A stop this soon after a start is a fumbled tap, not a sentence.
 *
 * Same 600ms as TranslatorShell's MIN_TURN_DURATION_MS and for the same
 * reason: sub-second clips carry no usable speech and the really short ones
 * do not even have complete container headers, so OpenAI rejects them as
 * "corrupted or unsupported". Catch them before they leave the phone.
 */
export const FAST_MIN_DICTATION_MS = 600;

/**
 * The largest upload the route will transcribe.
 *
 * Thirty seconds at TranslatorShell's voice-friendly 32 kbps is ~120 KB, so
 * 2 MB is an order of magnitude of headroom for a phone that ignores the
 * bitrate hint — and still far under Vercel's request-body limit. It exists
 * because FAST_MAX_DICTATION_MS is enforced in a browser, and a browser is
 * not where a spend bound belongs.
 */
export const FAST_MAX_DICTATION_BYTES = 2 * 1024 * 1024;

/**
 * How long an Azure Speech token is good for. Microsoft's number, not ours.
 *
 * Shared by the route that mints one and the browser that holds it, so the
 * refresh margin below is measured against the same ten minutes the server
 * reported rather than against a second copy of it that could drift.
 */
export const AZURE_TOKEN_TTL_MS = 10 * 60 * 1000;

/**
 * Refresh the token once it is this close to expiring.
 *
 * A minute of margin, and the margin is the point: a token that expires
 * BETWEEN the press and the first syllable fails the recogniser open, and the
 * mic falls back to batch for a dictation that had no reason to. Renewing a
 * minute early costs one free request (issueToken is not billed — only the
 * recognition it unlocks is) and removes the whole class of failure.
 */
export const AZURE_TOKEN_REFRESH_MS = 60 * 1000;

/**
 * The transcriber hint for a pair, or undefined.
 *
 * /fast dictates in AUTO-DETECT — the box does not know which of the two
 * languages somebody is about to speak, which is the whole point of a screen
 * with a swap button on it. So there is no source label to carry the Cantonese
 * rule the way /api/translate's non-auto path does, and without the hint zh
 * and yue speech both come back as Standard Written Chinese and read as
 * Mandarin. Same rule as /api/translate's auto branch, asked of the pair.
 */
export function dictationHintFor(pair: readonly LanguageCode[]): string | undefined {
  return pair.includes("yue") ? CANTONESE_STT_HINT : undefined;
}
