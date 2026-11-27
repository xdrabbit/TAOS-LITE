// Does the transcriber still invent text from silence? Measured, not assumed.
//
//   OPENAI_API_KEY=… npx vitest run --config vitest.measure.config.ts tests/live-fire/silence-guard.measure.ts
//
// Live fire: talks to OpenAI and spends real money — well under a cent a run
// (about two minutes of audio in total, plus second opinions).
// vitest.measure.config.ts keeps it out of `npm test` and CI.
//
// It replays the committed clips in tests/fixtures/stt-silence/ through the
// SHIPPED transcribeAudioDetailed() — the same function every route calls,
// with the options the routes pass — first with the silence guard off (the
// bug: how often does silence come back as words?) and then with it on.
//
//   SILENCE_RUNS=6     repeats per (clip, mode); the transcriber samples, so
//                      one run proves nothing
//   SILENCE_NO_LEVEL=1 pretend there is no ffmpeg, so the level is unknown —
//                      which is the truth on /api/walkie/turn, /api/fast/listen,
//                      /api/voz/line and /api/chat/voice. The guard then has
//                      only the model's confidence and the second opinion.
//   SILENCE_MODELS     comma list; default is the app's default model
//
// The clips: `silence-2s` is the Dictate repro (two seconds of digital
// silence, Opus in WebM — and the same in AAC/MP4, the iPhone container);
// `room-tone` is pink noise peaking at −53 dBFS; the `quiet-*` clips are
// synthetic speech attenuated 45 dB (peak −50 dBFS) and MUST come back as
// words; `normal-speech-en` is the control.
//
// Output is counts — kept or dropped, the reason, word counts. The clips are
// synthetic, but the table is built the way every other measure here is: safe
// to paste into a PR.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultTranscribeModel, transcribeAudioDetailed } from "@/lib/translate/transcribe";

const NO_LEVEL = process.env.SILENCE_NO_LEVEL === "1";
vi.mock("@/lib/translate/signalLevel", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/translate/signalLevel")>();
  return { ...actual, measurePeakDb: async (file: File) => (process.env.SILENCE_NO_LEVEL === "1" ? null : actual.measurePeakDb(file)) };
});

const OPENAI_KEY = process.env.OPENAI_API_KEY?.trim() ?? "";
const RUNS = Number(process.env.SILENCE_RUNS ?? 6);
const MODELS = (process.env.SILENCE_MODELS?.trim() || defaultTranscribeModel()).split(",").map((m) => m.trim()).filter(Boolean);
const FIXTURES = join(process.cwd(), "tests", "fixtures", "stt-silence");

interface Clip {
  file: string;
  mime: string;
  /** What the routes pass: a label on a manual turn, nothing on auto. */
  sourceLabel?: string;
  expect: "nothing" | "words";
  /** Words the transcript must contain to count as heard correctly. */
  mustContain?: RegExp;
}

const CLIPS: Clip[] = [
  { file: "silence-2s.webm", mime: "audio/webm", sourceLabel: "English", expect: "nothing" },
  { file: "silence-2s.webm", mime: "audio/webm", expect: "nothing" },
  { file: "silence-2s.m4a", mime: "audio/mp4", sourceLabel: "Spanish", expect: "nothing" },
  { file: "room-tone.webm", mime: "audio/webm", sourceLabel: "English", expect: "nothing" },
  { file: "room-tone.webm", mime: "audio/webm", expect: "nothing" },
  { file: "quiet-speech-en.webm", mime: "audio/webm", sourceLabel: "English", expect: "words", mustContain: /tablet.*dizzy/i },
  { file: "quiet-speech-en.webm", mime: "audio/webm", expect: "words", mustContain: /tablet.*dizzy/i },
  { file: "quiet-speech-es.webm", mime: "audio/webm", sourceLabel: "Spanish", expect: "words", mustContain: /tableta.*maread/i },
  { file: "quiet-one-word-es.webm", mime: "audio/webm", expect: "words" },
  { file: "normal-speech-en.webm", mime: "audio/webm", sourceLabel: "English", expect: "words", mustContain: /tablet.*dizzy/i }
];

function fileFor(clip: Clip): File {
  const name = clip.mime === "audio/mp4" ? "audio.mp4" : "audio.webm";
  return new File([readFileSync(join(FIXTURES, clip.file))], name, { type: clip.mime });
}

interface Tally {
  words: number;
  empty: number;
  right: number;
  refused: number;
  reasons: Map<string, number>;
  ms: number[];
}

async function runClip(clip: Clip, model: string, guard: boolean): Promise<Tally> {
  const tally: Tally = { words: 0, empty: 0, right: 0, refused: 0, reasons: new Map(), ms: [] };
  if (guard) delete process.env.TAOS_STT_SILENCE_GUARD;
  else process.env.TAOS_STT_SILENCE_GUARD = "0";
  try {
    const results = await Promise.all(
      Array.from({ length: RUNS }, async () => {
        const t0 = performance.now();
        // A provider refusal (whisper-1 will not open the ffmpeg-made .m4a
        // here) is not a transcript either way: tallied, never counted.
        const out = await transcribeAudioDetailed(OPENAI_KEY, fileFor(clip), {
          sourceLabel: clip.sourceLabel,
          model,
          timeoutMs: 60000
        }).catch(() => null);
        return { out, ms: Math.round(performance.now() - t0) };
      })
    );
    for (const { out, ms } of results) {
      tally.ms.push(ms);
      if (!out) {
        tally.refused += 1;
        tally.reasons.set("provider_refused", (tally.reasons.get("provider_refused") ?? 0) + 1);
      } else if (out.text) {
        tally.words += 1;
        if (!clip.mustContain || clip.mustContain.test(out.text)) tally.right += 1;
      } else {
        tally.empty += 1;
        const why = out.guard?.reason ? `${out.guard.reason}${out.guard.second ? `/${out.guard.second}` : ""}` : "model_empty";
        tally.reasons.set(why, (tally.reasons.get(why) ?? 0) + 1);
      }
    }
  } finally {
    delete process.env.TAOS_STT_SILENCE_GUARD;
  }
  return tally;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

describe.skipIf(!OPENAI_KEY)("silence guard, live", () => {
  it("silence and room tone come back empty; quiet and normal speech come back as words", async () => {
    // Quiet the guard's own per-drop log line; the table below is the output.
    const log = console.log;
    const rows: string[] = [];
    let inventedWithGuard = 0;
    let lostSpeechWithGuard = 0;
    let inventedWithoutGuard = 0;
    for (const model of MODELS) {
      for (const clip of CLIPS) {
        console.log = () => undefined;
        const off = await runClip(clip, model, false);
        const on = await runClip(clip, model, true);
        console.log = log;
        if (clip.expect === "nothing") {
          inventedWithGuard += on.words;
          inventedWithoutGuard += off.words;
        } else {
          lostSpeechWithGuard += on.empty;
        }
        const reasons = [...on.reasons.entries()].map(([k, n]) => `${k}×${n}`).join(" ") || "-";
        rows.push(
          [
            clip.file.padEnd(24),
            (clip.sourceLabel ?? "auto").padEnd(8),
            model.padEnd(24),
            `off: words ${off.words}/${RUNS}`.padEnd(18),
            `on: words ${on.words}/${RUNS}`.padEnd(17),
            (clip.expect === "words" ? `correct ${on.right}/${RUNS}` : `empty ${on.empty}/${RUNS}`).padEnd(14),
            `${median(off.ms)}→${median(on.ms)}ms`.padEnd(14),
            reasons
          ].join(" ")
        );
      }
    }
    console.log(
      `\nsilence guard — ${RUNS} runs per clip per mode, through transcribeAudioDetailed()` +
        ` — level probe ${NO_LEVEL ? "OFF (no ffmpeg: confidence only)" : "on"}\n`
    );
    console.log(
      ["clip".padEnd(24), "source".padEnd(8), "model".padEnd(24), "guard OFF".padEnd(18), "guard ON".padEnd(17), "result".padEnd(14), "median ms".padEnd(14), "why dropped"].join(" ")
    );
    for (const row of rows) console.log(row);
    console.log(
      `\ninvented text from silence/room tone: guard OFF ${inventedWithoutGuard}, guard ON ${inventedWithGuard}` +
        ` · real speech lost with guard ON: ${lostSpeechWithGuard}\n`
    );
    expect(inventedWithGuard).toBe(0);
    expect(lostSpeechWithGuard).toBe(0);
  });
});
