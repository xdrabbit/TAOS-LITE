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
 * How long a streaming RESERVATION stays open before it is reaped.
 *
 * Not the same clock as the token above, and conflating the two was the first
 * cut's mistake. A reservation covers ONE utterance, so once the utterance cap
 * plus a minute of slack has passed there is nothing left it could be paying
 * for — a tab that died mid-sentence is billed its full grant and stops
 * encumbering the hourly budget. The JWT, meanwhile, lives its own ten minutes
 * whatever we do, and is now held across utterances rather than re-minted per
 * press (lib/fast/speechMeter.ts explains why that is less exposure, not more).
 */
export const FAST_SPEECH_HOLD_MS = FAST_MAX_DICTATION_MS + 60 * 1000;

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

/**
 * How long a started stream may deliver NO audio before it is not a mic.
 *
 * The iPhone bug this fence was written for (lib/fast/micCapture.ts): a
 * suspended AudioContext lets the recogniser start, the socket open and the
 * button light up while zero PCM is ever produced. Azure, hearing digital
 * silence on a continuous session, never emits a partial, a final OR a
 * cancellation — so nothing throws and nothing falls back. The old mic waited
 * forever. A running audio graph delivers its first chunk in a few tens of
 * milliseconds, so a second and a half is enormous headroom for "it works" and
 * still fast enough that the fallback feels like a slow mic rather than a
 * broken one.
 */
export const MIC_SILENT_MS = 1500;

/**
 * How long to wait for the socket to open before taking the batch mic.
 *
 * `startContinuousRecognitionAsync` has no timeout of its own — on a tunnelled
 * or captive network it can hang for as long as the TCP stack will let it,
 * with the button lit the whole time. Three seconds is well past a healthy
 * handshake (measured in the low hundreds of ms) and well short of somebody
 * deciding the mic is broken.
 */
export const STREAM_CONNECT_MS = 3000;

/**
 * How much SPEECH may go unanswered before the socket is presumed deaf.
 *
 * Measured in voiced audio and not wall clock, deliberately: somebody who
 * presses the mic and then thinks for four seconds has not found a bug, and
 * dropping them into the slower mic for it would be a worse one. Only audio
 * with speech-like energy in it advances this clock (lib/fast/micCapture.ts),
 * so it means what it says — four seconds of actual talking, no hypothesis
 * back, therefore nobody is listening.
 */
export const STREAM_DEAF_MS = 4000;

/**
 * How long a RUNNING graph may carry nothing at all before it is not a mic.
 *
 * MIC_SILENT_MS above catches the graph that never started: zero chunks
 * delivered. It cannot catch the shape Tom actually reported on 8/31 — button
 * lit, timer counting, Azure genuinely connected, not one word — because in
 * that failure the audio graph IS running and IS delivering chunks. They are
 * just full of zeroes: a live MediaStreamTrack that produces digital silence.
 * `frames` climbs, so the frames-based fence sees a healthy mic forever.
 *
 * The discriminator is not loudness, it is the difference between quiet and
 * nothing. A real microphone in a real room delivers self-noise, mains hum,
 * the sound of a hand on a phone — measurable within a chunk or two, and
 * orders of magnitude above DIGITAL_SILENCE_RMS. Four seconds of literal
 * zeroes is not a quiet room; it is a dead capture path.
 */
export const STREAM_MUTE_MS = 4000;

/**
 * The backstop: connected this long with no recognition event of any kind.
 *
 * The two fences above both need a signal to read — no chunks, or chunks that
 * are exactly zero. Between them sits the awkward middle: a capture path
 * delivering a DC offset or a trickle of dither, loud enough to clear
 * DIGITAL_SILENCE_RMS and far too quiet to ever become a word. Azure answers
 * that with nothing at all — no partial, no final, no cancellation — which is
 * the same wait-forever the whole watchdog exists to end.
 *
 * Twelve seconds, and the number is a trade rather than a measurement: it is
 * the longest somebody might plausibly hold the mic in silence, working out
 * what to say, before being handed the slower mic for it. Shorter would catch
 * the bug sooner and start bouncing people who were only thinking. The cost of
 * being wrong here is a lumpy transcription, not a lost one — `recoverToBatch`
 * carries the already-granted microphone across rather than asking again.
 */
export const STREAM_NO_RESULT_MS = 12000;
