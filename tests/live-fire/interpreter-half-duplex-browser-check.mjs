// Interpreter mode's HALF-DUPLEX rule on the real /tabletop screen, in a real
// browser — against a SCRIPTED provider, so it spends nothing.
//
//   node tests/live-fire/interpreter-half-duplex-browser-check.mjs
//
// Needs google-chrome on PATH. No API key, no account, no network: the dev
// server it starts is pointed at a fake Supabase (as interpreter-browser-
// check.mjs does) AND at a fake ElevenLabs Realtime on localhost
// (ELEVENLABS_API_BASE_URL / ELEVENLABS_REALTIME_WS_URL), which speaks the
// event dialect the two table timelines of 2026-11-09 recorded and does to
// the app what the phone's own loudspeaker did to it at that table:
//
//   · a turn commits and its reply arrives — words, then 8 s of audio sent
//     much faster than it plays;
//   · one second into the reply, `speech_started` on BOTH legs and
//     `output_audio_buffer.cleared` for the reply — the "echo";
//   · the rest of the reply's audio, and a normal `response.done`.
//
// What it then reads back:
//   - from the BROWSER: was a playing source ever stopped? how many of the
//     reply's audio chunks were scheduled? (hooks on AudioBufferSourceNode)
//   - from the FAKE PROVIDER: what did each leg's microphone actually send
//     while the reply was playing — the room, or silence?
//   - from the app's own exported TIMELINE (the founder's ⬇ button): the
//     held-dropped bytes, the mic-muted stretches, the speech_started tags.
//
// Point INTERPRETER_CHECK_APP_DIR at a checkout of an older commit to see the
// same script FAIL there — that is what says the fake reproduces the table.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP_DIR = process.env.INTERPRETER_CHECK_APP_DIR ?? process.cwd();
const require = createRequire(join(APP_DIR, "package.json"));
const { WebSocketServer } = require("ws");

const APP_PORT = Number(process.env.INTERPRETER_CHECK_PORT ?? 3078);
const SUPA_PORT = 54397;
const ELEVEN_PORT = 54396;
const CDP_PORT = 9346;
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

/** 100 ms of a 330 Hz tone, 24 kHz s16 — "the interpreter's voice". */
const VOICE_CHUNK = (() => {
  const samples = RATE / 10;
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(6000 * Math.sin((2 * Math.PI * 330 * i) / RATE)), i * 2);
  return buf.toString("base64");
})();

/** Each reply the script played: who, when its first audio left, how long it plays. */
const replies = [];
let scriptDone = null;
const scriptFinished = new Promise((r) => (scriptDone = r));

/**
 * One turn: both legs hear speech start; `speaker` commits and replies with
 * `seconds` of audio; one second into the reply the "echo" arrives on both.
 */
async function turn(n, speaker, heard, said, seconds) {
  const quiet = speaker === "en" ? "es" : "en";
  const mine = legs.get(speaker);
  const other = legs.get(quiet);
  mine.send({ type: "input_audio_buffer.speech_started", item_id: `i${n}` });
  await sleep(50);
  other.send({ type: "input_audio_buffer.speech_started", item_id: `q${n}` });
  await sleep(2000);
  // The cascade: stop, commit, transcript, reply and first audio all at once.
  mine.send({ type: "input_audio_buffer.speech_stopped", item_id: `i${n}` });
  mine.send({ type: "input_audio_buffer.committed", item_id: `i${n}` });
  mine.send({ type: "conversation.item.input_audio_transcription.completed", item_id: `i${n}`, transcript: heard });
  mine.send({ type: "response.created", response: { id: `r${n}` } });
  mine.send({ type: "response.output_audio_transcript.delta", response_id: `r${n}`, delta: said });
  const chunks = seconds * 10;
  const reply = { n, speaker, firstAudioAt: at(), playsMs: seconds * 1000, chunks };
  replies.push(reply);
  for (let k = 0; k < chunks; k++) {
    mine.send({ type: "response.output_audio.delta", response_id: `r${n}`, delta: VOICE_CHUNK });
    if (k === Math.min(50, chunks - 10)) {
      // Up to ~1 s in: our own playback "heard" by both legs.
      mine.send({ type: "input_audio_buffer.speech_started", item_id: `e${n}` });
      other.send({ type: "input_audio_buffer.speech_started", item_id: `e${n}` });
      mine.send({ type: "output_audio_buffer.cleared", response_id: `r${n}` });
    }
    await sleep(20); // 5× faster than it plays
  }
  mine.send({ type: "response.output_audio_transcript.done", response_id: `r${n}`, transcript: said });
  mine.send({ type: "response.done", response: { id: `r${n}`, status: "completed", usage: {} } });
  // Let it play out, and the tail pass, before the next person speaks.
  await sleep(seconds * 1000 + 1500);
}

let scriptStarted = false;
function maybeStartScript() {
  if (scriptStarted || !legs.has("en") || !legs.has("es")) return;
  scriptStarted = true;
  void (async () => {
    await sleep(3000); // the open microphone, nobody speaking for us yet
    await turn(1, "en", "So how was your day?", "¿Y cómo estuvo tu día?", 8);
    await turn(2, "es", "Más o menos, me quedé en casa.", "So-so, I stayed home.", 4);
    scriptDone();
  })();
}

// ── the fake microphone: steady noise, so "the room" is never silent ───────
const dir = mkdtempSync(join(tmpdir(), "taos-halfduplex-"));
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

await cdp("Page.navigate", { url: `${APP}/tabletop` });
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
console.log(`live on the scripted provider (mints: ${minted}, legs: ${[...legs.keys()].join("+")})\n`);
await scriptFinished;

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

// ── 1. the speaker ────────────────────────────────────────────────────────
const totalChunks = replies.reduce((a, r) => a + r.chunks, 0);
console.log("the speaker (hooks on AudioBufferSourceNode, in the page):");
check(screen.spk.started === totalChunks, `every chunk of both replies was scheduled`, `${screen.spk.started} of ${totalChunks}`);
check(screen.spk.stoppedEarly === 0, `no playing source was ever stopped`, `stop() calls: ${screen.spk.stoppedEarly}`);
check(screen.spk.ended === totalChunks, `every chunk played to its end`, `${screen.spk.ended} of ${totalChunks}`);

// ── 2. the microphone, as the provider received it ────────────────────────
console.log("\nthe microphone (what each leg's socket actually carried):");
const MARGIN = 500;
for (const [lang, leg] of legs) {
  let during = 0, loudDuring = 0;
  for (const reply of replies) {
    const from = reply.firstAudioAt + MARGIN;
    const to = reply.firstAudioAt + reply.playsMs - 200;
    for (const m of leg.mic) {
      if (m.t < from || m.t > to) continue;
      during++;
      if (m.peak > 0) loudDuring++;
    }
  }
  const before = leg.mic.filter((m) => m.t < replies[0].firstAudioAt - 300);
  const loudBefore = before.filter((m) => m.peak > 0).length;
  check(loudBefore > 0, `leg ${lang}: the room IS sent when nobody is being interpreted`, `${loudBefore} of ${before.length} chunks non-silent`);
  check(during > 80 && loudDuring === 0, `leg ${lang}: only silence is sent while a reply plays`, `${loudDuring} of ${during} chunks non-silent`);
  // And it comes back afterwards: the last second of the run is the room again.
  const end = leg.mic.length ? leg.mic[leg.mic.length - 1].t : 0;
  const after = leg.mic.filter((m) => m.t > end - 1000);
  check(after.some((m) => m.peak > 0), `leg ${lang}: the room is sent again once the reply and its tail are over`);
  // No gap: the stream stays continuous in time through the muted stretch.
  let maxGap = 0;
  for (let i = 1; i < leg.mic.length; i++) maxGap = Math.max(maxGap, leg.mic[i].t - leg.mic[i - 1].t);
  check(maxGap < 600, `leg ${lang}: the stream never stops (silence, not a gap)`, `longest gap ${maxGap} ms`);
}

// ── 3. the screen and the timeline ────────────────────────────────────────
console.log("\nthe screen:");
check(screen.far.length > 0 && screen.near.length > 0, "an interpretation reached BOTH panes", `far ${screen.far.length}, near ${screen.near.length}${screen.error ? `, error: ${screen.error}` : ""}`);

console.log("\nthe exported timeline (the founder's ⬇ button):");
if (!timeline) {
  check(false, "the timeline was exported");
} else {
  const playsMs = replies.reduce((a, r) => a + r.playsMs, 0);
  for (const d of timeline.digest) {
    const meta = timeline.legs.find((l) => l.leg === d.leg);
    console.log(`  leg ${d.leg} ${meta?.source}→${meta?.target}: speech_started=${d.speechStarted} committed=${d.speechCommitted} peer=${d.speechPeer} phantom=${d.speechPhantom} in_playback=${d.speechInPlayback} · gate_opens=${d.gateOpens} held_dropped=${d.heldDroppedBytes} · mic_muted_ms=${d.micMutedMs} speaker_cuts=${d.speakerCuts}`);
    check(d.heldDroppedBytes === 0, `leg ${d.leg}: nothing held was thrown away`, `${d.heldDroppedBytes} bytes`);
    check(d.speakerCuts === 0, `leg ${d.leg}: the speaker was never cut`);
    check(Math.abs(d.micMutedMs - (playsMs + 600)) < 1500, `leg ${d.leg}: mic muted for the replies' length + tails`, `${d.micMutedMs} ms vs ${playsMs} ms of audio`);
    check(d.speechInPlayback === 2, `leg ${d.leg}: both "echo" speech_starts are tagged as during our playback`, `${d.speechInPlayback}`);
    check(d.speechCommitted === 1 && d.speechPeer === 1, `leg ${d.leg}: one turn its own (committed), one the other person's (peer)`);
  }
  const tags = timeline.rows.filter((r) => r.type === "input_audio_buffer.speech_started").map((r) => `${r.leg}:${r.speech}${r.spk ? "+spk" : ""}`);
  console.log(`  speech_started rows: ${tags.join("  ")}`);
  const settings = timeline.rows.find((r) => r.type === "mic-settings");
  check(!!settings?.cfg, "the mic's granted settings are in the timeline", JSON.stringify(settings?.cfg ?? null));
}
await sleep(1500);
console.log(`\nusage diag posted: ${usage?.diag ? "yes" : "no"}`);
for (const line of serverLog) console.log(`  ${line}`);

finish();
