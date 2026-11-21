// The SPEAKER of Interpreter mode's socket legs on the real /tabletop screen,
// in a real browser, with a KNOWN signal — so what comes out can be measured
// instead of listened to. Against a scripted provider: spends nothing.
//
//   node tests/live-fire/interpreter-pcm-playback-browser-check.mjs
//
// Tom and Liz's table, 2026-11-09: on Grok and ElevenLabs "the audio degrades
// into a folding waveform that repeats at a rapid rate". Until this check the
// socket legs' player had only ever been heard at that table.
//
// The fake ElevenLabs Realtime here (same fakes as interpreter-half-duplex-
// browser-check.mjs) answers three turns with a pure 330 Hz tone, cut the way
// the wire cuts it:
//
//   1. BURST    6 s in frames of 1,518 × n bytes, 20 ms apart — the shape
//               measured against the real ElevenLabs on 2026-11-09
//               (interpreter-engines.measure.ts: 3–5 s of audio in 40–250 ms).
//   2. ODD      5 s in irregular frames, many an ODD number of bytes — what an
//               engine that does not frame on samples sends.
//   3. TRICKLE  4 s in 40 ms frames at exactly real time — a provider that
//               paces its audio, where the queue can run dry.
//
// What it reads back, from the page:
//   · the SOUND each leg's <audio> element was given — tapped off the element's
//     own MediaStream by a second AudioContext — fitted against a 330 Hz sine
//     ten cycles at a time. A window is CLEAN if the fit explains ≥ 90 % of
//     it, GARBAGE if it is LOUDER than the tone and the fit explains under
//     half (samples read a byte out of step are near full scale); anything
//     else that is not clean is a HOLE — a gap cut into the tone. Counts only;
//     the samples never leave the page.
//   · the AudioBufferSourceNode hooks (was anything stopped or left unplayed);
//   · the app's own exported timeline: the `audio-ctx` and `pcm-stats` rows.
//
// Knobs:
//   INTERPRETER_CHECK_APP_DIR=<checkout>   run it against an older commit —
//                                          on main before this fix, turn 2
//                                          comes out as garbage. That is what
//                                          says the check can see the fault.
//   INTERPRETER_CHECK_QUERY="?pcmout=direct"   the page's query string (the
//                                          phone test's switches). With
//                                          pcmout=direct there is no <audio>
//                                          element to tap: hooks and timeline
//                                          only.
//
// What it CANNOT see: an iPhone. A context whose rate no longer matches the
// hardware under it (lib/tabletop/audio.ts) does not happen in a desktop
// browser. `ctx_rate` / `ctx_rate_was` on the phone's own diagnostics line is
// what proves or kills that one.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP_DIR = process.env.INTERPRETER_CHECK_APP_DIR ?? process.cwd();
const require = createRequire(join(APP_DIR, "package.json"));
const { WebSocketServer } = require("ws");

const APP_PORT = Number(process.env.INTERPRETER_CHECK_PORT ?? 3079);
const SUPA_PORT = 54395;
const ELEVEN_PORT = 54394;
const CDP_PORT = 9347;
const FOUNDER = "interpreter-probe@example.com";
const RATE = 24_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const at = () => Date.now() - t0;

// ── fake Supabase: auth says "founder" ─────────────────────────────────────
const fakeUser = { id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated", email: FOUNDER };
const supa = createServer((req, res) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "*",
    "Content-Type": "application/json"
  };
  if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
  req.resume();
  const url = req.url ?? "";
  if (url.startsWith("/auth/v1/user")) return res.writeHead(200, cors).end(JSON.stringify(fakeUser));
  if (url.startsWith("/rest/v1/")) return res.writeHead(200, cors).end("[]");
  res.writeHead(200, cors).end("{}");
}).listen(SUPA_PORT, "127.0.0.1");

// ── fake ElevenLabs Realtime ───────────────────────────────────────────────
/** secret → the language that leg listens for (read from the mint's session). */
const legOfSecret = new Map();
let minted = 0;
const eleven = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (req.method === "POST" && (req.url ?? "").endsWith("/convai/realtime/client_secrets")) {
      const session = JSON.parse(body || "{}").session ?? {};
      const secret = `fake-secret-${++minted}`;
      legOfSecret.set(secret, {
        lang: session?.audio?.input?.transcription?.language ?? "?",
        vad: session?.audio?.input?.turn_detection?.type ?? "?"
      });
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ value: secret }));
      return;
    }
    res.writeHead(404).end("{}");
  });
}).listen(ELEVEN_PORT, "127.0.0.1");

/** Per leg: the socket, and every mic append as { t, peak }. */
const legs = new Map();
const wss = new WebSocketServer({
  server: eleven,
  handleProtocols: (protocols) => (protocols.has("realtime") ? "realtime" : false)
});
wss.on("connection", (socket, req) => {
  const offered = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((s) => s.trim());
  const secret = (offered.find((p) => p.startsWith("openai-insecure-api-key.")) ?? "").split(".").slice(1).join(".");
  const info = legOfSecret.get(secret) ?? { lang: "?", vad: "?" };
  const leg = { lang: info.lang, socket, mic: [] };
  legs.set(info.lang, leg);
  const send = (msg) => socket.readyState === 1 && socket.send(JSON.stringify(msg));
  leg.send = send;
  socket.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.type !== "input_audio_buffer.append" || typeof msg.audio !== "string") return;
    const pcm = Buffer.from(msg.audio, "base64");
    let peak = 0;
    for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
    leg.mic.push({ t: at(), peak, bytes: pcm.length });
  });
  send({
    type: "session.created",
    session: {
      model: "eleven_realtime_v1_mini",
      audio: {
        input: { format: { type: "audio/pcm", rate: RATE }, turn_detection: { type: info.vad, eagerness: "medium" } },
        output: { format: { type: "audio/pcm", rate: RATE } }
      }
    }
  });
  maybeStartScript();
});

const QUERY = process.env.INTERPRETER_CHECK_QUERY ?? "";
const TONE_HZ = 330;
const TONE_AMP = 6000;

/** `seconds` of one continuous 330 Hz tone, 24 kHz s16 — "the interpreter's voice". */
function tone(seconds) {
  const samples = Math.round(RATE * seconds);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(TONE_AMP * Math.sin((2 * Math.PI * TONE_HZ * i) / RATE)), i * 2);
  }
  return buf;
}

/** Cut a reply into frames of the given sizes (cycled); the last takes the rest. */
function cut(pcm, sizes) {
  const frames = [];
  for (let at = 0, k = 0; at < pcm.length; k++) {
    const size = Math.max(1, sizes[k % sizes.length]);
    frames.push(pcm.subarray(at, at + size));
    at += size;
  }
  return frames;
}

/** The three shapes. `everyMs` = how far apart the frames are sent. */
const SHAPES = {
  // Measured, ElevenLabs, 2026-11-09: multiples of 1,518 bytes, in a burst.
  burst: { seconds: 6, sizes: [1, 3, 5, 2, 8, 20, 20, 15, 5, 12].map((n) => n * 1518), everyMs: 20 },
  // Irregular and mostly odd.
  odd: { seconds: 5, sizes: [1001, 2999, 4801, 333, 1920, 2401, 7, 3841, 1535, 2880], everyMs: 12 },
  // 40 ms of audio every 40 ms.
  trickle: { seconds: 4, sizes: [1920], everyMs: 40 }
};

/** Each reply the script played: who, which shape, how many frames, how long. */
const replies = [];
let scriptDone = null;
const scriptFinished = new Promise((r) => (scriptDone = r));

async function turn(n, speaker, heard, said, shapeName) {
  const shape = SHAPES[shapeName];
  const quiet = speaker === "en" ? "es" : "en";
  const mine = legs.get(speaker);
  const other = legs.get(quiet);
  mine.send({ type: "input_audio_buffer.speech_started", item_id: `i${n}` });
  await sleep(50);
  other.send({ type: "input_audio_buffer.speech_started", item_id: `q${n}` });
  await sleep(1500);
  mine.send({ type: "input_audio_buffer.speech_stopped", item_id: `i${n}` });
  mine.send({ type: "input_audio_buffer.committed", item_id: `i${n}` });
  mine.send({ type: "conversation.item.input_audio_transcription.completed", item_id: `i${n}`, transcript: heard });
  mine.send({ type: "response.created", response: { id: `r${n}` } });
  mine.send({ type: "response.output_audio_transcript.delta", response_id: `r${n}`, delta: said });
  const frames = cut(tone(shape.seconds), shape.sizes);
  replies.push({
    n,
    speaker,
    shape: shapeName,
    frames: frames.length,
    oddFrames: frames.filter((f) => f.length % 2).length,
    seconds: shape.seconds
  });
  let next = Date.now();
  for (const frame of frames) {
    mine.send({ type: "response.output_audio.delta", response_id: `r${n}`, delta: frame.toString("base64") });
    next += shape.everyMs;
    await sleep(Math.max(0, next - Date.now()));
  }
  mine.send({ type: "response.output_audio_transcript.done", response_id: `r${n}`, transcript: said });
  mine.send({ type: "response.done", response: { id: `r${n}`, status: "completed", usage: {} } });
  // Let it play out, and the half-duplex tail pass, before the next turn.
  await sleep(shape.seconds * 1000 + 1500);
}

let scriptStarted = false;
let scriptGo = null;
const scriptMayStart = new Promise((r) => (scriptGo = r));
function maybeStartScript() {
  if (scriptStarted || !legs.has("en") || !legs.has("es")) return;
  scriptStarted = true;
  void (async () => {
    await scriptMayStart; // the page's tap on the speaker is in place
    await sleep(500);
    await turn(1, "en", "So how was your day?", "¿Y cómo estuvo tu día?", "burst");
    await turn(2, "es", "Más o menos, me quedé en casa.", "So-so, I stayed home.", "odd");
    await turn(3, "en", "Shall we order?", "¿Pedimos?", "trickle");
    scriptDone();
  })();
}

// ── the fake microphone: steady noise, so "the room" is never silent ───────
const dir = mkdtempSync(join(tmpdir(), "taos-pcmplay-"));
const wav = join(dir, "mic.wav");
{
  const seconds = 10;
  const pcm = Buffer.alloc(48_000 * 2 * seconds);
  let seed = 12345;
  for (let i = 0; i < pcm.length / 2; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    // Noise under a 3 Hz envelope plus a tone — speech-shaped enough that
    // noise suppression does not flatten it to digital zero.
    const env = 0.55 + 0.45 * Math.sin((2 * Math.PI * 3 * i) / 48_000);
    const tone = Math.sin((2 * Math.PI * 220 * i) / 48_000);
    const noise = (seed / 0x3fffffff - 1) * 0.5;
    pcm.writeInt16LE(Math.round(9000 * env * (tone + noise)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(48_000, 24);
  header.writeUInt32LE(96_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  writeFileSync(wav, Buffer.concat([header, pcm]));
}

// ── the app, pointed at the fakes ──────────────────────────────────────────
const serverLog = [];
const app = spawn("node", ["node_modules/next/dist/bin/next", "dev", "--port", String(APP_PORT)], {
  cwd: APP_DIR,
  env: {
    ...process.env,
    // Nothing real: the key is a placeholder and both ElevenLabs URLs are ours.
    ELEVENLABS_API_KEY: "fake-elevenlabs-key",
    ELEVENLABS_API_BASE_URL: `http://127.0.0.1:${ELEVEN_PORT}/v1`,
    ELEVENLABS_REALTIME_WS_URL: `ws://127.0.0.1:${ELEVEN_PORT}/v1/convai/realtime`,
    TAOS_INTERPRETER_ENABLED: "1",
    // Hidden in production since #124; this check is about that engine.
    TAOS_INTERPRETER_EXPERIMENTAL_ENGINES: "grok-voice,elevenlabs-realtime",
    TAOS_INTERPRETER_LEGS: "2",
    NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${SUPA_PORT}`,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "fake-anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "fake-service-role-key",
    NEXT_PUBLIC_FOUNDER_EMAILS: FOUNDER,
    NEXT_TELEMETRY_DISABLED: "1"
  },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true
});
let chrome = null;
const shutdown = () => {
  try { process.kill(-app.pid, "SIGKILL"); } catch { /* already gone */ }
  try { chrome?.kill(); } catch { /* already gone */ }
  try { supa.close(); eleven.close(); } catch { /* already closed */ }
};
process.on("exit", shutdown);
process.on("SIGINT", () => process.exit(130));
process.on("uncaughtException", (e) => { console.error(e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error(e); process.exit(1); });
for (const stream of [app.stdout, app.stderr]) {
  stream.on("data", (d) => {
    for (const line of String(d).split("\n")) if (line.includes("[taos-interpreter")) serverLog.push(line.trim());
  });
}
const APP = `http://localhost:${APP_PORT}`;
for (let i = 0; i < 120; i++) {
  try {
    const r = await fetch(`${APP}/robots.txt`);
    if (r.status < 500) break;
  } catch { /* not up yet */ }
  await sleep(500);
}

chrome = spawn("google-chrome", [
  "--headless=new",
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${join(dir, "profile")}`,
  "--no-sandbox",
  "--disable-gpu",
  "--autoplay-policy=no-user-gesture-required",
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
  `--use-file-for-fake-audio-capture=${wav}`,
  "--window-size=390,844",
  "about:blank"
], { stdio: "ignore" });

async function pageSocket() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error("Chrome did not start.");
}
const ws = new WebSocket(await pageSocket());
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map();
ws.onmessage = ({ data }) => {
  const msg = JSON.parse(String(data));
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const cdp = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
};
const waitFor = async (expression, ms = 30_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await evaluate(expression)) return true;
    await sleep(250);
  }
  return false;
};

// Before any page script: count what the SPEAKER was asked to do, and catch
// the usage POST and the exported timeline file.
await cdp("Page.enable");
await cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    window.__spk = { started: 0, stoppedEarly: 0, ended: 0 };
    window.__usage = []; window.__timeline = null;
    const origStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...a) {
      window.__spk.started++;
      this.addEventListener("ended", () => { window.__spk.ended++; });
      return origStart.apply(this, a);
    };
    const origStop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.stop = function (...a) {
      window.__spk.stoppedEarly++;
      return origStop.apply(this, a);
    };
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      try { if (String(input).includes("/interpreter/usage")) window.__usage.push(JSON.parse(init.body)); } catch {}
      return origFetch.apply(this, arguments);
    };
    const origUrl = URL.createObjectURL;
    URL.createObjectURL = function (blob) {
      try { blob.text().then((text) => { try { window.__timeline = JSON.parse(text); } catch {} }); } catch {}
      return origUrl.apply(this, arguments);
    };
    try { delete Navigator.prototype.canShare; } catch {}
  `
});

await cdp("Page.navigate", { url: `${APP}/robots.txt` });
await sleep(1500);
const session = {
  access_token: "fake-access-token",
  refresh_token: "fake-refresh-token",
  token_type: "bearer",
  expires_in: 86_400,
  expires_at: Math.floor(Date.now() / 1000) + 86_400,
  user: fakeUser
};
await evaluate(`
  localStorage.setItem("sb-127-auth-token", ${JSON.stringify(JSON.stringify(session))});
  localStorage.setItem("taos.interpreter.engine", "elevenlabs-realtime");
  true
`);

const checks = [];
const check = (ok, label, detail = "") => {
  checks.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};
const finish = () => {
  const failed = checks.filter((ok) => !ok).length;
  console.log(`\n${failed ? `FAILED (${failed} of ${checks.length})` : `ALL PASSED (${checks.length})`}`);
  ws.close();
  process.exit(failed ? 1 : 0);
};

await cdp("Page.navigate", { url: `${APP}/tabletop${QUERY}` });
if (!(await waitFor(`!!document.querySelector("[data-tabletop-interpreter]")`, 120_000))) {
  check(false, "the Interpreter chip appeared on /tabletop");
  finish();
}
await evaluate(`document.querySelector("[data-tabletop-interpreter]").click(); true`);
await waitFor(`!!document.querySelector('[data-interpreter-engine="elevenlabs-realtime"]')`);
await evaluate(`document.querySelector('[data-interpreter-engine="elevenlabs-realtime"]').click(); true`);
await evaluate(`document.querySelector("[data-interpreter-toggle]").click(); true`);
const live = await waitFor(`document.querySelector("[data-interpreter-toggle]")?.getAttribute("aria-pressed") === "true"`, 60_000);
if (!live) {
  const err = await evaluate(`document.querySelector("[data-interpreter-error]")?.textContent ?? ""`);
  check(false, "the session went live on the scripted provider", err);
  finish();
}
// ── tap the speaker: what each leg's <audio> element is actually given ─────
const tapped = await evaluate(`(() => {
  window.__cap = [];
  const C = new AudioContext();
  window.__capCtx = C;
  for (const el of document.querySelectorAll("audio")) {
    const stream = el.srcObject;
    if (!stream || !stream.getAudioTracks || !stream.getAudioTracks().length) continue;
    const src = C.createMediaStreamSource(stream);
    const sp = C.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    sp.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    const zero = C.createGain();
    zero.gain.value = 0;
    src.connect(sp); sp.connect(zero); zero.connect(C.destination);
    window.__cap.push({ chunks, keep: [src, sp, zero] });
  }
  return { elements: window.__cap.length, rate: C.sampleRate, state: C.state };
})()`);
console.log(`live on the scripted provider (mints: ${minted}, legs: ${[...legs.keys()].join("+")}); tapped ${tapped.elements} <audio> element(s) at ${tapped.rate} Hz${QUERY ? `; query ${QUERY}` : ""}\n`);
scriptGo();
await scriptFinished;

// Fit every ten cycles of what was captured against a 330 Hz sine. Numbers out.
const heard = await evaluate(`(() => {
  const rate = window.__capCtx.sampleRate;
  const N = Math.round((rate * 10) / ${TONE_HZ});
  const w = (2 * Math.PI * ${TONE_HZ}) / rate;
  return window.__cap.map(({ chunks }) => {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const x = new Float32Array(total);
    let at = 0;
    for (const c of chunks) { x.set(c, at); at += c.length; }
    // Pass 1: every window's loudness and how much of it the sine explains.
    const wins = [];
    for (let s = 0; s + N <= total; s += N) {
      let e = 0, a = 0, b = 0, pk = 0;
      for (let i = 0; i < N; i++) { const v = x[s + i]; e += v * v; a += v * Math.cos(w * i); b += v * Math.sin(w * i); if (Math.abs(v) > pk) pk = Math.abs(v); }
      const fit = (2 / N) * (a * a + b * b);
      wins.push({ rms: Math.sqrt(e / N), purity: e > 0 ? Math.min(1, fit / e) : 0, pk });
    }
    // Pass 2: a window next to silence is where a reply starts or stops — it
    // is half tone, half nothing, and says nothing about the player.
    let active = 0, clean = 0, garbage = 0, peak = 0, edges = 0;
    const dirtyAt = [];
    for (let k = 0; k < wins.length; k++) {
      const win = wins[k];
      if (win.rms < 0.01) continue;
      const quietNeighbour = (wins[k - 1]?.rms ?? 0) < 0.01 || (wins[k + 1]?.rms ?? 0) < 0.01;
      if (quietNeighbour && win.purity < 0.9) { edges++; continue; }
      active++;
      if (win.purity >= 0.9) { clean++; if (win.pk > peak) peak = win.pk; }
      else {
        dirtyAt.push(+((k * N) / rate).toFixed(2));
        if (win.purity < 0.5 && win.rms > ${(TONE_AMP / 32768 / Math.SQRT2) * 1.25}) garbage++;
      }
    }
    return { seconds: +(total / rate).toFixed(1), activeS: +(((active + edges) * N) / rate).toFixed(2), active, clean, garbage, edges, dirtyAt: dirtyAt.slice(0, 12), cleanPeak: +peak.toFixed(3) };
  });
})()`);

const screen = await evaluate(`(() => {
  const lines = (which) => Array.from(document.querySelectorAll('[data-interpreter-pane="' + which + '"] [data-caption]')).map((el) => el.textContent.replace("▍", ""));
  return { far: lines("far"), near: lines("near"), spk: window.__spk, error: document.querySelector("[data-interpreter-error]")?.textContent ?? "" };
})()`);
await evaluate(`document.querySelector("[data-interpreter-toggle]").click(); true`);
await waitFor(`window.__usage.length > 0`, 8000);
const usage = await evaluate(`window.__usage[0] ?? null`);
await waitFor(`!!document.querySelector("[data-interpreter-diag-save]")`, 5000);
await evaluate(`document.querySelector("[data-interpreter-diag-save]")?.click(); true`);
await waitFor(`!!window.__timeline`, 5000);
const timeline = await evaluate(`window.__timeline`);

// ── 1. the sound ──────────────────────────────────────────────────────────
const direct = /pcmout=direct/.test(QUERY);
console.log("the sound (each leg's <audio> element, fitted against the 330 Hz it was sent):");
for (const r of replies) console.log(`  turn ${r.n} [${r.speaker}] ${r.shape}: ${r.seconds} s in ${r.frames} frames, ${r.oddFrames} of them an odd number of bytes`);
if (direct) {
  check(tapped.elements === 0, "pcmout=direct: no <audio> element carries a leg", `${tapped.elements} found`);
} else {
  check(tapped.elements === 2, "both legs play through an <audio> element", `${tapped.elements} found`);
  const sent = replies.reduce((a, r) => a + r.seconds, 0);
  const activeS = heard.reduce((a, h) => a + h.activeS, 0);
  for (const [i, h] of heard.entries()) {
    console.log(`  element ${i}: ${h.activeS} s of sound in ${h.seconds} s captured — ${h.clean} of ${h.active} windows clean, ${h.garbage} garbage, ${h.edges} start/stop edges, clean peak ${h.cleanPeak}${h.dirtyAt.length ? `; not clean at ${h.dirtyAt.join(", ")} s` : ""}`);
    check(h.garbage === 0, `element ${i}: no window of it is garbage`, `${h.garbage} of ${h.active}`);
    check(h.active > 0 && h.clean / h.active >= 0.97, `element ${i}: what came out is the tone that went in`, `${h.active ? ((100 * h.clean) / h.active).toFixed(1) : 0}% of windows clean, ${h.active - h.clean - h.garbage} with a hole`);
    // Two buffers sounding at once would add up; half of one missing would not reach the peak.
    check(Math.abs(h.cleanPeak - TONE_AMP / 32768) < 0.03, `element ${i}: at the level it was sent (nothing doubled)`, `peak ${h.cleanPeak} vs ${(TONE_AMP / 32768).toFixed(3)}`);
  }
  check(Math.abs(activeS - sent) < 0.6, "as much sound came out as was sent — nothing lost, nothing repeated", `${activeS.toFixed(2)} s out vs ${sent} s in`);
}

// ── 2. the speaker's own bookkeeping ──────────────────────────────────────
console.log("\nthe speaker (hooks on AudioBufferSourceNode, in the page):");
const frames = replies.reduce((a, r) => a + r.frames, 0);
check(screen.spk.started > 0 && Math.abs(screen.spk.started - frames) <= 4, "every frame was scheduled once", `${screen.spk.started} buffers for ${frames} frames`);
check(screen.spk.stoppedEarly === 0, "no playing source was ever stopped", `stop() calls: ${screen.spk.stoppedEarly}`);
check(screen.spk.ended === screen.spk.started, "every buffer played to its end", `${screen.spk.ended} of ${screen.spk.started}`);
check(screen.far.length > 0 && screen.near.length > 0, "an interpretation reached BOTH panes", `far ${screen.far.length}, near ${screen.near.length}${screen.error ? `, error: ${screen.error}` : ""}`);

// ── 3. the timeline: what the next phone test will say for itself ─────────
console.log("\nthe exported timeline (the founder's ⬇ button):");
if (!timeline) {
  check(false, "the timeline was exported");
} else {
  const ctxRows = timeline.rows.filter((r) => r.type === "audio-ctx");
  const statRows = timeline.rows.filter((r) => r.type === "pcm-stats");
  for (const r of ctxRows) console.log(`  leg ${r.leg} audio-ctx ${JSON.stringify(r.cfg)}`);
  for (const r of statRows) console.log(`  leg ${r.leg} pcm-stats ${JSON.stringify(r.cfg)}`);
  check(ctxRows.length === 2 && ctxRows.every((r) => r.cfg?.renewed === "1"), "each leg plays on a context made for THIS session", `${ctxRows.length} rows`);
  check(ctxRows.every((r) => Number(r.cfg?.rate) > 0 && r.cfg?.rate_was !== undefined), "…and says its rate, and the rate of the one it replaced");
  check(ctxRows.every((r) => r.cfg?.direct === (direct ? "1" : "0")), `…and which way it was routed (${direct ? "direct" : "<audio> element"})`);
  const odd = statRows.reduce((a, r) => a + Number(r.cfg?.odd ?? 0), 0);
  const sentOdd = replies.reduce((a, r) => a + r.oddFrames, 0);
  check(statRows.length === 2 && odd === sentOdd, "the odd frames were counted", `${odd} counted, ${sentOdd} sent`);
  check(statRows.every((r) => r.cfg?.rate === r.cfg?.rate_now), "the context's rate did not move under the session");
  const under = statRows.reduce((a, r) => a + Number(r.cfg?.underruns ?? 0), 0);
  const gap = statRows.reduce((a, r) => a + Number(r.cfg?.gap_ms ?? 0), 0);
  console.log(`  starvation gaps (the real-time trickle is where they can happen): ${under}, ${gap} ms of silence`);
}
await sleep(1500);
console.log(`\nusage diag posted: ${usage?.diag ? "yes" : "no"}`);
check(!!usage?.diag?.every((d) => d.ctx_renewed === 1 && d.ctx_rate > 0), "the posted digest carries the context's numbers");
for (const line of serverLog) console.log(`  ${line}`);
check(serverLog.some((l) => l.includes("[taos-interpreter-diag]") && l.includes("ctx_renewed=1") && l.includes("pcm_odd_frames=")), "…and they reach the [taos-interpreter-diag] line");

finish();
