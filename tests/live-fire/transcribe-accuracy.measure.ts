// Which transcriber should home's Auto-detect turns run on? Measured, not assumed.
//
//   npx vitest run --config vitest.measure.config.ts tests/live-fire/transcribe-accuracy.measure.ts
//   node tests/live-fire/transcribe-accuracy.run.mjs --clips <dir>    # plus real clips
//
// Live fire: this talks to OpenAI and spends real money — about two cents a
// run (see COST at the bottom of the table). vitest.measure.config.ts is why
// `npm test` and CI never see it.
//
// Why it exists: PR #108 found production's gpt-4o-transcribe collapses a
// two-language clip into ONE language, while gpt-4o-mini-transcribe and
// whisper-1 keep both halves. OPENAI_AUTO_TRANSCRIBE_MODEL can move the auto
// path alone — but gpt-4o-transcribe was chosen for a reason, so this measures
// what single-language accuracy costs before anybody flips it.
//
// It transcribes through the SHIPPED transcribeAudio() with exactly the auto
// path's options (no sourceLabel, so the auto prompt), only varying `model` —
// a rig that builds its own request measures a different product.
//
// Output is scores only. Transcripts are never printed: the synthetic scripts
// below are committed fixtures, but a real clip from --clips is somebody's
// voice saying something, and the table must be safe to paste into a PR.
//
// Real clips: a directory of audio files (wav, mp3, m4a, webm, ogg, flac),
// each with a sidecar `<name>.txt` holding what was actually said. A line may
// start with `en:` or `es:` to say which language it is in; a clip whose lines
// carry two different tags is scored as mixed (did both languages survive?).
// Untagged lines are guessed from accents and Spanish stopwords.
import { mkdirSync, readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { describe, it } from "vitest";
import { transcribeAudio } from "@/lib/translate/transcribe";

const OPENAI_KEY = process.env.OPENAI_API_KEY?.trim() ?? "";
const CLIPS_DIR = process.env.TRANSCRIBE_CLIPS_DIR?.trim() ?? "";
/** Runs per (clip, model). Two smooths latency without doubling much cost. */
const RUNS = Number(process.env.TRANSCRIBE_RUNS ?? 2);

const MODELS = ["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"] as const;

/** $/minute of audio. Update alongside the provider's pricing page. */
const PER_MINUTE: Record<string, number> = {
  "gpt-4o-transcribe": 0.006,
  "gpt-4o-mini-transcribe": 0.003,
  "whisper-1": 0.006
};
/** gpt-4o-mini-tts, ~$0.015/min of audio out (cached after the first run). */
const TTS_PER_MINUTE = 0.015;

type Lang = "en" | "es";
interface Part {
  lang: Lang;
  text: string;
}
interface Clip {
  id: string;
  group: "EN" | "ES" | "EN+noise" | "ES+noise" | "borrowed" | "mixed" | "real";
  parts: Part[];
  /** Signal-to-noise ratio of added white noise, in dB. Absent = clean. */
  snrDb?: number;
}

/**
 * Synthetic fixtures. onyx speaks English, nova Spanish (the voices PR #108's
 * live check used). ES covers numbers and names, because that is where a
 * cheaper transcriber would slip first.
 */
const SYNTHETIC: Clip[] = [
  { id: "en-keys", group: "EN", parts: [{ lang: "en", text: "Where did you put the car keys? I left them on the kitchen table this morning." }] },
  { id: "en-table", group: "EN", parts: [{ lang: "en", text: "Can you call the restaurant and ask if they have a table for four people tonight?" }] },
  { id: "en-allergy", group: "EN", parts: [{ lang: "en", text: "My daughter is allergic to peanuts, so please check the ingredients before you order dessert." }] },
  { id: "es-llaves", group: "ES", parts: [{ lang: "es", text: "¿Dónde dejaste las llaves del carro? Las puse en la mesa de la cocina esta mañana." }] },
  { id: "es-tamales", group: "ES", parts: [{ lang: "es", text: "María dice que los tamales cuestan cuarenta y cinco pesos en el mercado de San Juan." }] },
  { id: "es-vuelo", group: "ES", parts: [{ lang: "es", text: "Mi vuelo sale a las nueve de la mañana y llego a Guadalajara a las once." }] },
  { id: "en-gracias", group: "borrowed", parts: [{ lang: "en", text: "Okay, gracias, I'll meet you at the front door in ten minutes." }] },
  {
    id: "mix-en-es",
    group: "mixed",
    parts: [
      { lang: "en", text: "I think we should leave early so we are not rushed." },
      { lang: "es", text: "No, mejor salimos después del almuerzo, hay mucho tráfico." }
    ]
  },
  {
    id: "mix-es-en",
    group: "mixed",
    parts: [
      { lang: "es", text: "¿Ya comiste algo o quieres que pidamos comida?" },
      { lang: "en", text: "Yeah, I had a sandwich, but I could eat again." }
    ]
  }
];

/**
 * Clean TTS is too easy: every model scores 100% on it, which says nothing
 * about what a cheaper model costs. The same six single-language clips again
 * under white noise at 10 dB SNR (a loud café) give the comparison something
 * to separate on. Same audio cache, so they cost transcription only.
 */
const NOISY_SNR_DB = 10;
for (const clip of SYNTHETIC.filter((c) => c.group === "EN" || c.group === "ES")) {
  SYNTHETIC.push({
    ...clip,
    id: `${clip.id}+noise`,
    group: clip.group === "EN" ? "EN+noise" : "ES+noise",
    snrDb: NOISY_SNR_DB
  });
}

// ── Scoring ─────────────────────────────────────────────────────────────────

const EN_ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const EN_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const ES_ONES = ["cero", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez", "once", "doce", "trece", "catorce", "quince", "dieciseis", "diecisiete", "dieciocho", "diecinueve", "veinte", "veintiuno", "veintidos", "veintitres", "veinticuatro", "veinticinco", "veintiseis", "veintisiete", "veintiocho", "veintinueve"];
const ES_TENS = ["", "", "", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"];

/** 0-99 as words, so "45 pesos" and "cuarenta y cinco pesos" score the same. */
function numberWords(n: number, lang: Lang): string {
  if (lang === "en") {
    if (n < 20) return EN_ONES[n];
    return EN_TENS[Math.floor(n / 10)] + (n % 10 ? ` ${EN_ONES[n % 10]}` : "");
  }
  if (n < 30) return ES_ONES[n];
  return ES_TENS[Math.floor(n / 10)] + (n % 10 ? ` y ${ES_ONES[n % 10]}` : "");
}

/**
 * Lowercase, strip accents and punctuation, spell out 0-99, drop ":00".
 * Lenient on purpose: a missing tilde or "5" vs "five" is not what decides
 * this; dropped, swapped or translated words are.
 */
function normalize(text: string, lang: Lang): string[] {
  const t = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/(\d+):00\b/g, "$1")
    .replace(/\b(\d{1,2})\b/g, (_, d: string) => numberWords(Number(d), lang))
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/'/g, "");
  return t
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w === "ok" ? "okay" : w));
}

/** Word-level Levenshtein distance. */
function editDistance(ref: string[], hyp: string[]): number {
  const prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= hyp.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[hyp.length];
}

/** 1 - WER, floored at 0. */
function wordAccuracy(ref: string[], hyp: string[]): number {
  if (ref.length === 0) return hyp.length === 0 ? 1 : 0;
  return Math.max(0, 1 - editDistance(ref, hyp) / ref.length);
}

/** Share of a reference part's words that appear in the transcript at all. */
function recall(part: string[], hyp: string[]): number {
  const bag = new Map<string, number>();
  for (const w of hyp) bag.set(w, (bag.get(w) ?? 0) + 1);
  let hit = 0;
  for (const w of part) {
    const n = bag.get(w) ?? 0;
    if (n > 0) {
      hit++;
      bag.set(w, n - 1);
    }
  }
  return part.length ? hit / part.length : 1;
}

/**
 * Did both languages survive? Each language's words must be at least half
 * present. A collapsing transcriber TRANSLATES one half into the other
 * language, so that half's recall drops near zero — the threshold is not
 * close to the line in either direction.
 */
const KEPT_THRESHOLD = 0.5;

// ── Clips ───────────────────────────────────────────────────────────────────

interface Audio {
  clip: Clip;
  file: File;
  seconds: number;
}

const CACHE = join(tmpdir(), "taos-transcribe-probe");
let ttsSecondsSynthesised = 0;

function wav(pcm: Buffer, rate = 24000): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** 24 kHz 16-bit mono PCM for one part; cached so re-runs cost nothing. */
async function speak(part: Part, key: string): Promise<Buffer> {
  const path = join(CACHE, `${key}.pcm`);
  if (existsSync(path)) return readFileSync(path);
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: part.lang === "en" ? "onyx" : "nova",
      input: part.text,
      response_format: "pcm"
    })
  });
  if (!res.ok) throw new Error(`TTS failed: HTTP ${res.status}`);
  const pcm = Buffer.from(await res.arrayBuffer());
  ttsSecondsSynthesised += pcm.length / 48000;
  writeFileSync(path, pcm);
  return pcm;
}

async function syntheticAudio(clip: Clip): Promise<Audio> {
  mkdirSync(CACHE, { recursive: true });
  const gap = Buffer.alloc(Math.round(0.25 * 48000)); // 250 ms: a quick interruption
  const pieces: Buffer[] = [];
  for (const [i, part] of clip.parts.entries()) {
    if (i > 0) pieces.push(gap);
    pieces.push(await speak(part, `${clip.id.replace(/\+noise$/, "")}-${i}`));
  }
  const pcm = Buffer.concat(pieces);
  if (clip.snrDb !== undefined) addNoise(pcm, clip.snrDb);
  return {
    clip,
    file: new File([new Uint8Array(wav(pcm))], `${clip.id}.wav`, { type: "audio/wav" }),
    seconds: pcm.length / 48000
  };
}

/**
 * White noise at `snrDb` below the clip's RMS, in place. Seeded, so every
 * model and every run hears the identical noisy file.
 */
function addNoise(pcm: Buffer, snrDb: number): void {
  const n = pcm.length / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += pcm.readInt16LE(i * 2) ** 2;
  const noiseRms = Math.sqrt(sum / n) / 10 ** (snrDb / 20);
  let seed = 0x2545f491;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0xffffffff;
  };
  for (let i = 0; i < n; i++) {
    // Box-Muller: Gaussian, so the RMS is the target.
    const g = Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
    const v = Math.round(pcm.readInt16LE(i * 2) + g * noiseRms);
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
  }
}

const MIME: Record<string, string> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".webm": "audio/webm",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac"
};

function guessLang(line: string): Lang {
  if (/[ñ¿¡áéíóú]/i.test(line)) return "es";
  return /\b(que|el|la|los|las|de|y|es|por|para|con|una?|yo|tu|mi)\b/i.test(line) ? "es" : "en";
}

function parseScript(text: string): Part[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const tagged = /^(en|es)\s*:\s*(.*)$/i.exec(line);
      return tagged
        ? { lang: tagged[1].toLowerCase() as Lang, text: tagged[2] }
        : { lang: guessLang(line), text: line };
    });
}

/** Duration from a WAV header; other containers are estimated at 64 kbps. */
function seconds(buf: Buffer, ext: string): number {
  if (ext === ".wav" && buf.toString("ascii", 0, 4) === "RIFF") {
    const byteRate = buf.readUInt32LE(28);
    return byteRate ? (buf.length - 44) / byteRate : 0;
  }
  return buf.length / 8000;
}

function realAudio(dir: string): Audio[] {
  const out: Audio[] = [];
  for (const name of readdirSync(dir).sort()) {
    const ext = extname(name).toLowerCase();
    if (!MIME[ext]) continue;
    const stem = basename(name, extname(name));
    const script = join(dir, `${stem}.txt`);
    if (!existsSync(script)) {
      console.log(`  skip ${name}: no ${stem}.txt beside it`);
      continue;
    }
    const parts = parseScript(readFileSync(script, "utf8"));
    const buf = readFileSync(join(dir, name));
    out.push({
      clip: { id: stem, group: "real", parts },
      file: new File([new Uint8Array(buf)], name, { type: MIME[ext] }),
      seconds: seconds(buf, ext)
    });
  }
  return out;
}

// ── Measure ─────────────────────────────────────────────────────────────────

interface Row {
  clip: string;
  group: string;
  model: string;
  accuracy: number;
  ms: number;
  /** Runs on which both languages survived; null when the clip is not mixed. */
  kept: number | null;
}

async function score(audio: Audio, model: string): Promise<Row> {
  const { clip } = audio;
  const accs: number[] = [];
  const times: number[] = [];
  let kept: number | null = null;
  const langs = new Set(clip.parts.map((p) => p.lang));
  const mixed = langs.size > 1;
  for (let r = 0; r < RUNS; r++) {
    const t0 = performance.now();
    // Exactly the auto path's call: no sourceLabel, no hint for an en/es pair.
    const hyp = await transcribeAudio(OPENAI_KEY, audio.file, { model });
    times.push(performance.now() - t0);
    // Score against the whole script; numbers are spelled in each part's own
    // language, so normalise the transcript both ways and keep the kinder one.
    const ref = clip.parts.flatMap((p) => normalize(p.text, p.lang));
    const best = Math.max(...[...langs].map((l) => wordAccuracy(ref, normalize(hyp, l))));
    accs.push(best);
    if (mixed) {
      const both = [...langs].every((lang) => {
        const words = clip.parts.filter((p) => p.lang === lang).flatMap((p) => normalize(p.text, p.lang));
        return recall(words, normalize(hyp, lang)) >= KEPT_THRESHOLD;
      });
      kept = (kept ?? 0) + (both ? 1 : 0);
    }
  }
  return {
    clip: clip.id,
    group: clip.group,
    model,
    accuracy: accs.reduce((a, b) => a + b, 0) / accs.length,
    ms: times.reduce((a, b) => a + b, 0) / times.length,
    kept
  };
}

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

describe.skipIf(!OPENAI_KEY)("auto-mode transcriber accuracy (live fire)", () => {
  it("measures every model on the same clips", async () => {
    const audios: Audio[] = [];
    for (const clip of SYNTHETIC) audios.push(await syntheticAudio(clip));
    if (CLIPS_DIR) audios.push(...realAudio(CLIPS_DIR));

    const rows: Row[] = [];
    for (const audio of audios) {
      // Models in parallel per clip: they hit different model endpoints, and
      // a clip's three numbers then share the same network minute.
      rows.push(...(await Promise.all(MODELS.map((m) => score(audio, m)))));
    }

    const header = `| clip | group | ${MODELS.map((m) => `${m} acc / ms`).join(" | ")} |`;
    const lines = [header, `|${"---|".repeat(MODELS.length + 2)}`];
    for (const audio of audios) {
      const cells = MODELS.map((m) => {
        const r = rows.find((x) => x.clip === audio.clip.id && x.model === m)!;
        const kept = r.kept === null ? "" : ` · both ${r.kept}/${RUNS}`;
        return `${pct(r.accuracy)} / ${Math.round(r.ms)}${kept}`;
      });
      lines.push(`| ${audio.clip.id} | ${audio.clip.group} | ${cells.join(" | ")} |`);
    }
    const groups = ["EN", "ES", "EN+noise", "ES+noise", "borrowed", "mixed", ...(CLIPS_DIR ? ["real"] : [])];
    for (const g of groups) {
      const cells = MODELS.map((m) => {
        const rs = rows.filter((x) => x.group === g && x.model === m);
        if (!rs.length) return "—";
        const acc = rs.reduce((a, b) => a + b.accuracy, 0) / rs.length;
        const ms = rs.reduce((a, b) => a + b.ms, 0) / rs.length;
        return `**${pct(acc)} / ${Math.round(ms)}**`;
      });
      lines.push(`| **mean** | **${g}** | ${cells.join(" | ")} |`);
    }

    const audioMinutes = audios.reduce((a, b) => a + b.seconds, 0) / 60;
    const sttCost = MODELS.reduce((a, m) => a + PER_MINUTE[m] * audioMinutes * RUNS, 0);
    const ttsCost = (ttsSecondsSynthesised / 60) * TTS_PER_MINUTE;
    console.log(`\n${lines.join("\n")}\n`);
    console.log(
      `acc = 1 − WER (accents, punctuation, "5" vs "five" forgiven), mean of ${RUNS} runs; ms = mean latency; ` +
        `both k/n = runs on which each language's words were ≥${pct(KEPT_THRESHOLD)} present.`
    );
    console.log(
      `COST ≈ $${(sttCost + ttsCost).toFixed(4)} (STT $${sttCost.toFixed(4)} over ${audioMinutes.toFixed(2)} audio-min × ${MODELS.length} models × ${RUNS} runs; ` +
        `TTS $${ttsCost.toFixed(4)}${ttsSecondsSynthesised ? "" : ", clips cached"})`
    );
  });
});
