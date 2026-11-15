// The seam between two chunks of a long home turn, measured in a real browser.
//
//   node tests/live-fire/chunk-boundary-browser-check.mjs [--keep <dir>]
//
// Needs google-chrome and ffmpeg on PATH. Talks to no provider; costs nothing.
//
// ── What it measures ───────────────────────────────────────────────────────
// lib/translate/chunkedRecorder.ts rolls from one MediaRecorder to the next
// on the same mic stream. tests/home-long-turn.test.ts proves the ORDER of
// that (stop, then start, in one task) against a fake MediaRecorder — and a
// fake has no encoder, so it cannot say how much audio falls between the two
// recordings. This does: the SHIPPED module runs in Chrome against Chrome's
// fake capture device playing a swept tone (400 → 3400 Hz every 3 s), so the
// pitch at any instant says what time it is. The pitch at the end of chunk N
// and at the start of chunk N+1 give the audio missing between them — the
// gap the transcriber will actually see, encoder turnaround included.
//
// ── What it cannot say ─────────────────────────────────────────────────────
// This is Chrome's Opus encoder on a desktop. Android Chrome is the same
// engine; iOS Safari (AAC in MP4, a different MediaRecorder) is not, and no
// desktop engine stands in for it. The phone test in the PR is that leg.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const PORT = Number(process.env.PORT ?? 3047);
const CHUNK_MS = 4300;
const CHUNKS = 6;
const SWEEP_SECONDS = 3;
const F0 = 400;
const F1 = 3400;
const RATE = 48000;
const keepAt = process.argv.indexOf("--keep");
const keepDir = keepAt > 0 ? process.argv[keepAt + 1] : null;

const work = mkdtempSync(join(tmpdir(), "taos-chunk-seam-"));
const out = keepDir ?? join(work, "chunks");
mkdirSync(out, { recursive: true });

// ── The swept tone ─────────────────────────────────────────────────────────
function writeSweep(path) {
  const n = RATE * SWEEP_SECONDS;
  const pcm = Buffer.alloc(n * 2);
  const k = (F1 - F0) / SWEEP_SECONDS;
  for (let i = 0; i < n; i += 1) {
    const t = i / RATE;
    pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * (F0 * t + (k * t * t) / 2)) * 0.5 * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  writeFileSync(path, Buffer.concat([header, pcm]));
}
const sweepPath = join(work, "sweep.wav");
writeSweep(sweepPath);

// ── The page: the shipped recorder, nothing else ───────────────────────────
const moduleSource = readFileSync(
  fileURLToPath(new URL("../../lib/translate/chunkedRecorder.ts", import.meta.url)),
  "utf8"
);
const moduleJs = ts.transpileModule(moduleSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 }
}).outputText;

const page = `<!doctype html><meta charset="utf-8"><body><script type="module">
import { createChunkedRecorder } from "/chunkedRecorder.js";
const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((c) => MediaRecorder.isTypeSupported(c)) ?? "";
const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
const sends = [];
const recorder = createChunkedRecorder({
  stream, mime, bitsPerSecond: 32000, chunkMs: ${CHUNK_MS},
  onChunk: (c) => {
    sends.push(fetch("/chunk?i=" + c.index + "&ms=" + Math.round(c.ms) + "&final=" + (c.final ? 1 : 0), { method: "POST", body: c.blob }));
    if (c.final) Promise.all(sends).then(() => fetch("/done?mime=" + encodeURIComponent(mime), { method: "POST" }));
  }
});
recorder.start();
const tick = setInterval(() => {
  if (recorder.shouldRoll()) {
    if (recorder.chunkCount >= ${CHUNKS}) { clearInterval(tick); recorder.stop(); stream.getTracks().forEach((t) => t.stop()); }
    else recorder.roll();
  }
}, 20);
</script>`;

const chunks = [];
let finish;
const done = new Promise((resolve) => (finish = resolve));
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html" }).end(page);
  } else if (req.method === "GET" && url.pathname === "/chunkedRecorder.js") {
    res.writeHead(200, { "Content-Type": "text/javascript" }).end(moduleJs);
  } else if (req.method === "POST" && url.pathname === "/chunk") {
    const parts = [];
    req.on("data", (b) => parts.push(b));
    req.on("end", () => {
      const i = Number(url.searchParams.get("i"));
      chunks[i] = { bytes: Buffer.concat(parts), ms: Number(url.searchParams.get("ms")), final: url.searchParams.get("final") === "1" };
      res.writeHead(204).end();
    });
  } else if (req.method === "POST" && url.pathname === "/done") {
    res.writeHead(204).end();
    finish(url.searchParams.get("mime") ?? "");
  } else {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(PORT, resolve));

const chrome = spawn(
  "google-chrome",
  [
    "--headless=new",
    "--no-first-run",
    "--disable-gpu",
    `--user-data-dir=${join(work, "profile")}`,
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${sweepPath}`,
    "--remote-debugging-port=0",
    `http://localhost:${PORT}/`
  ],
  { stdio: "ignore" }
);
const timeout = setTimeout(() => finish(null), CHUNK_MS * CHUNKS + 30000);
const mime = await done;
clearTimeout(timeout);
chrome.kill("SIGKILL");
server.close();
if (mime === null) {
  console.error("FAIL  the page never finished recording");
  process.exit(1);
}

// ── Read the pitch at each seam ────────────────────────────────────────────
const ext = mime.includes("mp4") ? "m4a" : "webm";
function decode(bytes, i) {
  const path = join(out, `chunk${i}.${ext}`);
  writeFileSync(path, bytes);
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", path, "-ac", "1", "-ar", String(RATE), "-f", "f32le", "-"], {
    maxBuffer: 1 << 28
  });
  return new Float32Array(r.stdout.buffer, r.stdout.byteOffset, Math.floor(r.stdout.byteLength / 4));
}

/** Mean frequency over [from, to) samples, from interpolated zero crossings. */
function frequency(pcm, from, to) {
  let first = null;
  let last = null;
  let count = 0;
  for (let i = Math.max(1, from); i < Math.min(pcm.length, to); i += 1) {
    if (pcm[i - 1] < 0 && pcm[i] >= 0) {
      const at = i - 1 + -pcm[i - 1] / (pcm[i] - pcm[i - 1]);
      if (first === null) first = at;
      else count += 1;
      last = at;
    }
  }
  return first === null || count === 0 ? NaN : (count * RATE) / (last - first);
}

/** Seconds into the sweep at the CENTRE of a window, or NaN when it is not a clean stretch of sweep. */
function sweepTimeAt(pcm, from, to) {
  const mid = Math.floor((from + to) / 2);
  const whole = frequency(pcm, from, to);
  const slope = (frequency(pcm, mid, to) - frequency(pcm, from, mid)) / ((to - from) / 2 / RATE);
  const expected = (F1 - F0) / SWEEP_SECONDS;
  if (!Number.isFinite(whole) || whole < F0 + 60 || whole > F1 - 60) return NaN;
  if (!Number.isFinite(slope) || Math.abs(slope - expected) > expected * 0.35) return NaN;
  return (whole - F0) / expected;
}

const decoded = chunks.map((c, i) => decode(c.bytes, i));
const EDGE = Math.round(0.03 * RATE);
const SPAN = Math.round(0.12 * RATE);
const gaps = [];
console.log(`mime=${mime} chunk_ms=${CHUNK_MS} chunks=${chunks.length}`);
for (let i = 0; i < chunks.length; i += 1) {
  const seconds = decoded[i].length / RATE;
  console.log(
    `  chunk ${i}: ${chunks[i].bytes.length} bytes, recorder clock ${chunks[i].ms} ms, decoded ${(seconds * 1000).toFixed(0)} ms${
      chunks[i].final ? " (final)" : ""
    }`
  );
}
for (let i = 0; i + 1 < decoded.length; i += 1) {
  const a = decoded[i];
  const b = decoded[i + 1];
  const endCentre = sweepTimeAt(a, a.length - EDGE - SPAN, a.length - EDGE);
  const startCentre = sweepTimeAt(b, EDGE, EDGE + SPAN);
  if (!Number.isFinite(endCentre) || !Number.isFinite(startCentre)) {
    console.log(`  seam ${i}→${i + 1}: lands on the sweep's wrap — not measurable, skipped`);
    continue;
  }
  const half = (EDGE + SPAN / 2) / RATE;
  let gap = startCentre - half - (endCentre + half);
  gap = ((gap % SWEEP_SECONDS) + SWEEP_SECONDS * 1.5) % SWEEP_SECONDS - SWEEP_SECONDS / 2;
  gaps.push(gap * 1000);
  console.log(`  seam ${i}→${i + 1}: ${(gap * 1000).toFixed(1)} ms of audio missing`);
}

if (!keepDir) rmSync(work, { recursive: true, force: true });
if (gaps.length === 0) {
  console.error("FAIL  no seam could be measured");
  process.exit(1);
}
const worst = Math.max(...gaps.map(Math.abs));
const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
console.log(`seams measured=${gaps.length} mean=${mean.toFixed(1)} ms worst=${worst.toFixed(1)} ms`);
const ok = worst <= 150;
console.log(`${ok ? "  ok  " : "FAIL  "}every seam loses at most 150 ms`);
process.exit(ok ? 0 : 1);
