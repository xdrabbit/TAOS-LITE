// Interpreter mode, end to end, in a real browser — without a phone and
// without anybody's account.
//
//   OPENAI_API_KEY=… node tests/live-fire/interpreter-browser-check.mjs [engine …]
//
// Engines default to: openai-realtime openai-translate openai-live.
// (gemini-live needs GEMINI_API_KEY in the environment, elevenlabs-realtime
// ELEVENLABS_API_KEY, grok-voice XAI_API_KEY; add them to the list.)
// Needs google-chrome on PATH. SPENDS REAL MONEY — a few cents per engine —
// so it lives beside the live-fire rig and `npm test` never runs it.
//
// What only this can answer (vitest cannot open a peer connection):
//   - do the providers ACCEPT the sessions the mint route builds?
//   - do the WebRTC legs connect, and do the events the readers are written
//     against (lib/interpreter/legEvents.ts) actually arrive, by those names?
//   - does a caption reach the screen, on the right pane?
//   - does the transcript's first word arrive before its audio starts
//     playing? (The wordless-audio gate un-mutes on words; if words trailed
//     audio it would clip the start of every sentence.)
//   - does Stop post one [taos-interpreter] line of numbers?
//
// How it gets past sign-in without a real person: the dev server it starts is
// pointed at a FAKE Supabase on localhost (NEXT_PUBLIC_SUPABASE_URL), which
// answers "who is this token?" with a made-up founder, and the browser's
// storage is seeded with a session for that fake. No real account, no real
// database, no production env: the only real thing in the loop is OpenAI.
// The microphone is Chrome's fake device playing two synthesized sentences —
// the rig's own, nobody's conversation.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEY = process.env.OPENAI_API_KEY?.trim();
if (!KEY) throw new Error("OPENAI_API_KEY is required.");
const ENGINES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["openai-realtime", "openai-translate", "openai-live"];
const APP_PORT = 3077;
const FAKE_PORT = 54399;
const CDP_PORT = 9344;
const LISTEN_MS = Number(process.env.INTERPRETER_CHECK_LISTEN_MS ?? 42_000);
const FOUNDER = "interpreter-probe@example.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── a fake Supabase: auth says "founder", the context table has a made-up row ──
const PROBE_CONTEXT =
  "The English speaker is Sam. The Spanish speaker is Ana. Ana's everyday words: 'sale' means okay/deal; 'flojera' means feeling lazy.";
const fakeUser = { id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated", email: FOUNDER };
const fake = createServer((req, res) => {
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
  if (url.startsWith("/rest/v1/taos_lite_interpreter_context")) {
    return res.writeHead(200, cors).end(JSON.stringify([{ context: PROBE_CONTEXT, updated_at: new Date().toISOString() }]));
  }
  if (url.startsWith("/rest/v1/")) return res.writeHead(200, cors).end("[]");
  res.writeHead(200, cors).end("{}");
}).listen(FAKE_PORT, "127.0.0.1");

// ── the fake microphone: EN, pause, ES, pause — looped by Chrome ──
async function tts(text, voice) {
  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice, input: text, response_format: "pcm" })
  });
  if (!r.ok) throw new Error(`TTS ${r.status}`);
  return Buffer.from(await r.arrayBuffer()); // 24 kHz s16 mono
}
const quiet = (seconds) => Buffer.alloc(24_000 * 2 * seconds);
const pcm24 = Buffer.concat([
  quiet(2),
  await tts("So how was your day? Did you get to rest at all?", "ash"),
  quiet(9),
  await tts("Más o menos. Me dio flojera salir, así que me quedé en casa toda la tarde.", "coral"),
  quiet(12)
]);
// 24 kHz → 48 kHz by sample doubling; Chrome's fake capture wants a plain WAV.
const pcm48 = Buffer.alloc(pcm24.length * 2);
for (let i = 0; i + 1 < pcm24.length; i += 2) {
  pcm24.copy(pcm48, i * 2, i, i + 2);
  pcm24.copy(pcm48, i * 2 + 2, i, i + 2);
}
const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + pcm48.length, 4);
header.write("WAVEfmt ", 8);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(48_000, 24);
header.writeUInt32LE(96_000, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(pcm48.length, 40);
const dir = mkdtempSync(join(tmpdir(), "taos-interp-"));
const wav = join(dir, "mic.wav");
writeFileSync(wav, Buffer.concat([header, pcm48]));
console.log(`mic loop: ${(pcm48.length / 96_000).toFixed(1)} s`);

// ── the app, pointed at the fake ──
const serverLog = [];
const app = spawn("node", ["node_modules/next/dist/bin/next", "dev", "--port", String(APP_PORT)], {
  env: {
    ...process.env,
    OPENAI_API_KEY: KEY,
    TAOS_INTERPRETER_ENABLED: "1",
    NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${FAKE_PORT}`,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "fake-anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "fake-service-role-key",
    NEXT_PUBLIC_FOUNDER_EMAILS: FOUNDER,
    NEXT_TELEMETRY_DISABLED: "1"
  },
  stdio: ["ignore", "pipe", "pipe"],
  // Its own process group, so the whole dev server (it forks) dies with us.
  detached: true
});
const shutdown = () => {
  try { process.kill(-app.pid, "SIGKILL"); } catch { /* already gone */ }
  try { chrome?.kill(); } catch { /* already gone */ }
  try { fake.close(); } catch { /* already closed */ }
};
process.on("exit", shutdown);
process.on("SIGINT", () => process.exit(130));
process.on("uncaughtException", (e) => { console.error(e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error(e); process.exit(1); });
let chrome = null;
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

// Before any page script: record every data-channel event's TYPE and time,
// and every usage POST. Types and numbers only.
await cdp("Page.enable");
await cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    window.__ev = []; window.__usage = []; window.__pc = 0;
    const origCreate = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function (...a) {
      const leg = window.__pc++;
      const dc = origCreate.apply(this, a);
      dc.addEventListener("message", (e) => {
        try { const m = JSON.parse(e.data); window.__ev.push({ leg, t: performance.now(), type: m.type, rid: m.response_id || (m.response && m.response.id) || "" , status: m.response && m.response.status }); } catch {}
      });
      return dc;
    };
    // Was each leg's speaker ever actually OPEN? Sampled, per <audio> element.
    window.__open = {};
    setInterval(() => {
      document.querySelectorAll("audio").forEach((a, i) => {
        if (a.srcObject && !a.muted) window.__open[i] = (window.__open[i] || 0) + 100;
      });
    }, 100);
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      try { if (String(input).includes("/interpreter/usage")) window.__usage.push(JSON.parse(init.body)); } catch {}
      return origFetch.apply(this, arguments);
    };
  `
});

// A session for the fake founder, in the storage key supabase-js derives from
// the fake's hostname.
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
  localStorage.setItem("taos.interpreter.engine", "openai-realtime");
  true
`);

let failed = false;
const report = [];
for (const engine of ENGINES) {
  console.log(`\n── ${engine} ──`);
  await cdp("Page.navigate", { url: `${APP}/tabletop` });
  if (!(await waitFor(`!!document.querySelector("[data-tabletop-interpreter]")`, 90_000))) {
    console.log("  FAIL: the Interpreter chip never appeared on /tabletop");
    failed = true;
    continue;
  }
  await evaluate(`document.querySelector("[data-tabletop-interpreter]").click(); true`);
  await waitFor(`!!document.querySelector('[data-interpreter-engine="${engine}"]')`);
  await evaluate(`window.__ev = []; window.__usage = []; window.__pc = 0; window.__open = {}; document.querySelector('[data-interpreter-engine="${engine}"]').click(); true`);
  await evaluate(`document.querySelector("[data-interpreter-toggle]").click(); true`);
  const live = await waitFor(`document.querySelector("[data-interpreter-toggle]")?.getAttribute("aria-pressed") === "true"`, 40_000);
  if (!live) {
    const err = await evaluate(`document.querySelector("[data-interpreter-error]")?.textContent ?? ""`);
    console.log(`  FAIL: never went live — ${err}`);
    failed = true;
    continue;
  }
  console.log("  live");
  await sleep(LISTEN_MS);

  const snapshot = await evaluate(`(() => {
    const lines = (which) => Array.from(document.querySelectorAll('[data-interpreter-pane="' + which + '"] [data-caption]')).map((el) => el.getAttribute("data-caption") + ": " + el.textContent.replace("▍", ""));
    const counts = {};
    for (const e of window.__ev) { const k = "leg" + e.leg + " " + e.type; counts[k] = (counts[k] || 0) + 1; }
    // Does a response's first WORD arrive before its audio starts playing?
    const leads = [];
    const firstWord = {}, started = {};
    for (const e of window.__ev) {
      if (e.type === "response.output_audio_transcript.delta" && !(e.rid in firstWord)) firstWord[e.rid] = e.t;
      if (e.type === "output_audio_buffer.started" && !(e.rid in started)) started[e.rid] = e.t;
    }
    for (const rid of Object.keys(firstWord)) if (rid in started) leads.push(Math.round(started[rid] - firstWord[rid]));
    const audio = Array.from(document.querySelectorAll("audio")).map((a) => ({ muted: a.muted, paused: a.paused, live: !!a.srcObject }));
    return {
      far: lines("far"), near: lines("near"), counts, leads, audio, open: window.__open,
      status: document.querySelector("[data-interpreter-status]")?.textContent ?? "",
      error: document.querySelector("[data-interpreter-error]")?.textContent ?? ""
    };
  })()`);
  await evaluate(`document.querySelector("[data-interpreter-toggle]").click(); true`);
  await waitFor(`window.__usage.length > 0`, 8000);
  const usage = await evaluate(`window.__usage[0] ?? null`);
  await sleep(1200);

  console.log(`  status: ${snapshot.status}${snapshot.error ? `  error: ${snapshot.error}` : ""}`);
  console.log(`  far pane (es reader):`);
  for (const l of snapshot.far) console.log(`    ${l}`);
  console.log(`  near pane (en reader):`);
  for (const l of snapshot.near) console.log(`    ${l}`);
  console.log(`  events:`);
  for (const [k, v] of Object.entries(snapshot.counts).sort()) console.log(`    ${k} ×${v}`);
  if (snapshot.leads.length) console.log(`  first word → audio start (ms, + = words first): ${snapshot.leads.join(", ")}`);
  console.log(`  audio elements: ${JSON.stringify(snapshot.audio)}`);
  console.log(`  speaker open (ms, per element): ${JSON.stringify(snapshot.open)}`);
  console.log(`  usage posted: ${JSON.stringify(usage)}`);
  // The founder Diagnostics chip is on by default: the digest rides in `diag`.
  for (const leg of usage?.diag ?? []) console.log(`  diag leg${leg.leg}: ${JSON.stringify(leg)}`);
  const perMinute =
    engine === "openai-translate" ||
    engine === "openai-live" ||
    engine === "grok-voice" ||
    engine === "elevenlabs-realtime";
  const metered = !!usage && (perMinute ? usage.billed_secs > 0 : usage.audio_out_tokens > 0);
  const ok =
    snapshot.far.some((l) => l.startsWith("incoming")) && snapshot.near.some((l) => l.startsWith("incoming")) && metered;
  console.log(`  ${ok ? "PASS" : "FAIL"}: an interpretation reached BOTH panes and Stop posted a non-zero meter`);
  if (!ok) failed = true;
  report.push({ engine, ok });
}

console.log("\n── server log ──");
for (const line of serverLog) console.log(`  ${line}`);

ws.close();
console.log(`\n${failed ? "FAILED" : "ALL PASSED"}: ${report.map((r) => `${r.engine}=${r.ok ? "ok" : "FAIL"}`).join(" ")}`);
process.exit(failed ? 1 : 0);
