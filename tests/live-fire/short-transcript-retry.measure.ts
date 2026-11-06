// Replay a real clip through the short-transcript retry. Measured, not assumed.
//
//   TRANSCRIBE_CLIP=/path/to/turn.webm \
//   npx vitest run --config vitest.measure.config.ts tests/live-fire/short-transcript-retry.measure.ts
//
// Live fire: talks to OpenAI and spends real money (a cent or two per
// minute of clip per model). vitest.measure.config.ts keeps it out of
// `npm test` and CI.
//
// The regression fixture is the 11/5 production clip — Tom's home turn, auto
// mode, 2026-11-05 07:24 PM MT, 1:09, kept in the review bucket (row
// 69fa2ce1-3b9f-4689-92a9-c3aeb018e5a6; "Download flagged clips" on /review
// writes it as a clip set). A one-minute clip is too big to commit to
// tests/, so point TRANSCRIBE_CLIP at it. Optional:
//
//   TRANSCRIBE_CLIP_SECONDS=69     the phone's rec_ms, in seconds (else ffmpeg
//                                  decodes it when ffmpeg-static is installed,
//                                  else bytes/6400)
//   TRANSCRIBE_RUNS=2              repeats per model (latency and variance)
//   OPENAI_AUTO_TRANSCRIBE_MODEL   the first transcriber (production's auto
//                                  model); TAOS_TRANSCRIBE_FALLBACK_MODEL the
//                                  retry's
//   TRANSCRIBE_PAIR=en,es          the pair (default en,es)
//
// Output is counts only — words, a Spanish/English stopword tally, the
// verdict and milliseconds. A real clip is somebody's voice saying something,
// and this table must be safe to paste into a PR.
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { autoTranscribeModel, transcribeAudio } from "@/lib/translate/transcribe";
import { normalizeForStt } from "@/lib/translate/normalize";
import {
  estimateClipSeconds,
  fallbackTranscribeModel,
  otherPairLanguage,
  pickLongerTranscript,
  retryTranscribeOptions,
  shortTranscriptVerdict,
  wordCount
} from "@/lib/translate/shortTranscript";
import { getLanguageLabel, isSupportedLanguageCode } from "@/lib/realtime/languages";

const OPENAI_KEY = process.env.OPENAI_API_KEY?.trim() ?? "";
const CLIP = process.env.TRANSCRIBE_CLIP?.trim() ?? "";
const RUNS = Number(process.env.TRANSCRIBE_RUNS ?? 2);
const [PAIR_A = "en", PAIR_B = "es"] = (process.env.TRANSCRIBE_PAIR ?? "en,es").split(",").map((s) => s.trim());

const ES = /\b(que|el|la|los|las|de|y|es|por|para|con|una?|yo|tú|tu|mi|pero|no|sí|está|aquí|bien|muy|cuando|también|porque)\b/gi;
const EN = /\b(the|and|you|is|are|it|that|to|of|in|we|i|was|but|this|with|not|have|do|for|on|know|so|like|what)\b/gi;

function tally(text: string): string {
  const es = (text.match(ES) ?? []).length;
  const en = (text.match(EN) ?? []).length;
  return `words=${String(wordCount(text)).padStart(3)} es_stop=${String(es).padStart(2)} en_stop=${String(en).padStart(2)}`;
}

describe("short-transcript retry on a real clip", () => {
  it.skipIf(!OPENAI_KEY || !CLIP)("replays the clip through the first transcriber and the retry", async () => {
    const bytes = readFileSync(CLIP);
    const mime = CLIP.endsWith(".m4a") || CLIP.endsWith(".mp4") ? "audio/mp4" : CLIP.endsWith(".wav") ? "audio/wav" : "audio/webm";
    const file = new File([bytes], `turn.${CLIP.split(".").pop()}`, { type: mime });

    // The clip's length, the way the route gets it.
    const recMs = process.env.TRANSCRIBE_CLIP_SECONDS ? Number(process.env.TRANSCRIBE_CLIP_SECONDS) * 1000 : null;
    const norm = await normalizeForStt(file);
    const seconds = estimateClipSeconds({ recMs, decodedSeconds: norm?.seconds ?? null, bytes: file.size, mime });
    console.log(
      `clip bytes=${file.size} seconds=${seconds.toFixed(1)} (${recMs ? "rec_ms" : norm?.seconds ? "decoded" : "bytes"})` +
        ` norm_gain_db=${norm ? norm.gainDb : "na"} norm_ms=${norm?.ms ?? "?"}`
    );

    const first = autoTranscribeModel();
    const fallback = fallbackTranscribeModel();
    for (const [label, audio] of [["original", file], ...(norm && norm.gainDb > 0 ? [["normalized", norm.file] as const] : [])] as const) {
      for (let run = 1; run <= RUNS; run++) {
        const t0 = performance.now();
        const text1 = await transcribeAudio(OPENAI_KEY, audio, { model: first });
        const ms1 = Math.round(performance.now() - t0);
        const verdict = shortTranscriptVerdict(text1, seconds);
        console.log(`${label.padEnd(10)} run${run} first  ${first.padEnd(24)} ${tally(text1)} wps=${verdict.wps} short=${verdict.short ? 1 : 0} ms=${ms1}`);
        if (!verdict.short) continue;
        const other = otherPairLanguage(text1, PAIR_A, PAIR_B);
        const hint = other && isSupportedLanguageCode(other) ? { code: other, label: getLanguageLabel(other) } : null;
        const t1 = performance.now();
        const text2 = await transcribeAudio(OPENAI_KEY, audio, retryTranscribeOptions(fallback, hint));
        const ms2 = Math.round(performance.now() - t1);
        const picked = pickLongerTranscript(text1, text2);
        console.log(
          `${label.padEnd(10)} run${run} retry  ${fallback.padEnd(24)} ${tally(text2)} hint=${hint?.code ?? "none"} picked=${
            picked.picked === "second" ? "retry" : "first"
          } ms=${ms2}`
        );
      }
    }
  }, 600000);
});
