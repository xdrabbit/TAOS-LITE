// A long home turn through the REAL route, on synthetic speech. Measured.
//
//   npx vitest run --config vitest.measure.config.ts tests/live-fire/home-long-turn.measure.ts
//
// Live fire: talks to OpenAI and spends real money — about 15 cents a run
// (three ~40 s synthetic clips made once and cached, ~6 minutes of
// transcription, eight translations). vitest.measure.config.ts keeps it out
// of `npm test` and CI. Needs OPENAI_API_KEY and ffmpeg on PATH.
//
// What it answers, that the unit tests cannot (they mock both providers):
//
//   1. Do three chunks, transcribed separately by the real transcriber, come
//      back as ONE translation in the right order through the real handler?
//   2. When a chunk is lost, is the marker where the hole is, in both the
//      transcript and the translation, with real text either side of it?
//      (First run of this rig, 2026-11-15: with the marker left INSIDE the
//      text handed to the translator, gpt-4.1 dropped it 3 times of 3 in
//      manual mode and 1 of 3 in auto. The route now translates each side of
//      a hole on its own and places the marker itself; this checks that.)
//   3. How long does ONE translation of a ten-minute turn's worth of text
//      take, against the time it is allowed (translateTimeoutFor) — and does
//      it come back whole, not summarized?
//
// The speech is synthetic and the text below is this file's own, so unlike
// the other rigs this one may print what it heard.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { countLostMarkers, LOST_MARKER_PATTERN, serializePrior, translateTimeoutFor } from "@/lib/translate/longTurn";
import { wordCount } from "@/lib/translate/shortTranscript";
import { paraphrase, PARAPHRASE_TIMEOUT_MS } from "@/lib/translate/paraphrase";

vi.mock("@/lib/spendGuard", () => ({
  guardSpend: async () => ({ ok: true, user: { id: "measure", email: "measure@example.com" }, anonymous: false })
}));

const OPENAI_KEY = process.env.OPENAI_API_KEY?.trim() ?? "";
const CACHE = join(tmpdir(), "taos-long-turn-measure");

const PASSAGES = [
  "This is part one of the story. We left the house before sunrise because the road over the pass closes when the snow starts. " +
    "My sister packed sandwiches and a thermos of coffee, and the dog sat between us on the front seat. " +
    "For the first hour nobody said very much. The valley was full of fog, and the only lights were the trucks coming down from the mine.",
  "This is part two of the story. At the top of the pass we stopped at the small restaurant with the green roof. " +
    "The owner remembered our father and would not let us pay for the soup. She told us the bridge near the river had been repaired in the spring, " +
    "so we could take the shorter road, the one that follows the water all the way to the village.",
  "This is part three of the story. We arrived in the afternoon, and the whole family was already in the garden. " +
    "My grandmother had made the bread herself, and she asked three times whether we were hungry. " +
    "That evening we sat outside until it was dark, and my uncle told the story about the horse that everybody has heard a hundred times."
];

async function synthesize(i: number): Promise<{ bytes: Uint8Array; ms: number }> {
  mkdirSync(CACHE, { recursive: true });
  const webm = join(CACHE, `part${i}.webm`);
  if (!existsSync(webm)) {
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "alloy", input: PASSAGES[i], response_format: "mp3" })
    });
    if (!res.ok) throw new Error(`speech synthesis failed: HTTP ${res.status}`);
    const mp3 = join(CACHE, `part${i}.mp3`);
    writeFileSync(mp3, new Uint8Array(await res.arrayBuffer()));
    // What the phone would have sent: Opus in WebM at the home recorder's bitrate.
    const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", mp3, "-ac", "1", "-c:a", "libopus", "-b:a", "32k", webm]);
    if (r.status !== 0) throw new Error("ffmpeg could not make the WebM");
  }
  const probe = spawnSync("ffmpeg", ["-v", "error", "-i", webm, "-f", "s16le", "-ac", "1", "-ar", "8000", "-"], { maxBuffer: 1 << 26 });
  return { bytes: new Uint8Array(readFileSync(webm)), ms: Math.round((probe.stdout.byteLength / 2 / 8000) * 1000) };
}

function request(fields: Record<string, string>, audio: Uint8Array | null): NextRequest {
  const form = new FormData();
  if (audio) form.append("audio", new File([audio as BlobPart], "audio.webm", { type: "audio/webm;codecs=opus" }));
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return new NextRequest("http://localhost/api/translate", { method: "POST", body: form });
}

describe("a long home turn, live", () => {
  it.skipIf(!OPENAI_KEY)("three chunks → one translation; a lost chunk → a marker; a ten-minute text → one call", async () => {
    const { POST } = await import("@/app/api/translate/route");
    const clips = await Promise.all([0, 1, 2].map(synthesize));
    const recMs = clips.reduce((s, c) => s + c.ms, 0);
    console.log(`\nclips: ${clips.map((c) => `${(c.ms / 1000).toFixed(1)}s/${c.bytes.byteLength}B`).join("  ")}  turn=${(recMs / 1000).toFixed(1)}s`);

    const manual = { sourceLanguage: "en", targetLanguage: "es", tone: "detailed" };
    const auto = { sourceLanguage: "auto", targetLanguage: "auto", pairA: "en", pairB: "es", tone: "detailed" };

    // ── 1. The whole turn, as the phone sends it ───────────────────────────
    console.log("\n── 1. three chunks, in order, one translation ──");
    const t0 = performance.now();
    const parts = await Promise.all(
      [0, 1].map(async (i) => {
        const res = await POST(request({ ...manual, chunk_part: "1", chunk_index: String(i), chunk_ms: String(clips[i].ms) }, clips[i].bytes));
        const body = (await res.json()) as { chunk?: { text?: string } };
        expect(res.status).toBe(200);
        return { text: body.chunk?.text ?? "", ms: clips[i].ms };
      })
    );
    const partsMs = Math.round(performance.now() - t0);
    const t1 = performance.now();
    const res = await POST(
      request(
        { ...manual, prior: serializePrior(parts), chunk_index: "2", chunk_ms: String(clips[2].ms), rec_ms: String(recMs), stitch_ms: "0", marker_lang: "en" },
        clips[2].bytes
      )
    );
    const finalMs = Math.round(performance.now() - t1);
    const whole = (await res.json()) as { original: string; translation: string };
    expect(res.status).toBe(200);
    const order = ["part one", "part two", "part three"].map((p) => whole.original.toLowerCase().indexOf(p));
    console.log(`parts (two, in parallel): ${partsMs} ms   final request (last chunk's STT + the one translation): ${finalMs} ms`);
    console.log(`original: ${whole.original.length} chars, "part one/two/three" at ${order.join(" < ")}`);
    console.log(`translation: ${whole.translation.length} chars`);
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order[0] < order[1] && order[1] < order[2]).toBe(true);
    expect(whole.translation.length).toBeGreaterThan(whole.original.length * 0.7);

    // ── 2. A lost chunk ────────────────────────────────────────────────────
    console.log("\n── 2. chunk two lost: does the translator carry the marker? ──");
    for (const [label, direction] of [
      ["manual en→es", manual],
      ["auto", auto]
    ] as const) {
      for (let run = 1; run <= 3; run += 1) {
        const lossy = await POST(
          request(
            {
              ...direction,
              prior: serializePrior([parts[0], { text: null, ms: clips[1].ms }]),
              chunk_index: "2",
              chunk_ms: String(clips[2].ms),
              rec_ms: String(recMs),
              marker_lang: "en"
            },
            clips[2].bytes
          )
        );
        const body = (await lossy.json()) as { original: string; translation: string };
        expect(lossy.status).toBe(200);
        const markers = body.translation.match(LOST_MARKER_PATTERN) ?? [];
        const at = markers.length > 0 ? body.translation.indexOf(markers[0] as string) : -1;
        const before = at < 0 ? 0 : wordCount(body.translation.slice(0, at));
        const after = at < 0 ? 0 : wordCount(body.translation.slice(at + (markers[0] as string).length));
        console.log(
          `${label} run ${run}: transcript markers=${countLostMarkers(body.original)} translation markers=${JSON.stringify(markers)}` +
            ` words before=${before} after=${after}`
        );
        expect(countLostMarkers(body.original)).toBe(1);
        expect(markers).toHaveLength(1);
        // In place: translated speech on BOTH sides of the hole.
        expect(before).toBeGreaterThan(20);
        expect(after).toBeGreaterThan(20);
      }
    }

    // ── 3. One translation of ten minutes of talk ──────────────────────────
    console.log("\n── 3. one translation of a ten-minute turn's text ──");
    // ~150 words a minute for ten minutes is ~1,500–1,800 words. The text
    // must not repeat itself: the first run of this rig retold the three
    // passages eight times and the translator (rightly) said it once. So a
    // long, non-repeating monologue is written once by the translate model
    // and cached.
    const storyPath = join(CACHE, "monologue.txt");
    if (!existsSync(storyPath)) {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4.1",
          temperature: 0.8,
          messages: [
            {
              role: "user",
              content:
                "Write a 1,700-word first-person spoken monologue, as someone would say it aloud to a friend: one continuous, " +
                "detailed account of a week-long family road trip. Plain prose, no headings, no lists, and never repeat a sentence."
            }
          ]
        })
      });
      const payload = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      writeFileSync(storyPath, payload.choices?.[0]?.message?.content ?? "");
    }
    const long = readFileSync(storyPath, "utf8").replace(/\s+/g, " ").trim();
    const allowed = translateTimeoutFor(long.length, PARAPHRASE_TIMEOUT_MS);
    const t2 = performance.now();
    const out = await paraphrase(OPENAI_KEY, long, "English", "Spanish", "detailed", null, allowed);
    const ms = Math.round(performance.now() - t2);
    console.log(
      `in=${long.length} chars (${wordCount(long)} words)  out=${out.length} chars (${wordCount(out)} words)  ${ms} ms` +
        `  (allowed ${allowed} ms; the old fixed cap was ${PARAPHRASE_TIMEOUT_MS} ms)`
    );
    // Whole, not summarized.
    expect(wordCount(out)).toBeGreaterThan(wordCount(long) * 0.8);
  });
});
