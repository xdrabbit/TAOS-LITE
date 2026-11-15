// /tabletop's end-of-turn flush, on the REAL screen, in a real browser —
// against a scripted fake provider, so it needs no phone, nobody's account,
// and (apart from one free session mint) no provider at all.
//
//   OPENAI_API_KEY=… node tests/live-fire/tabletop-flush-browser-check.mjs
//   APP_DIR=/path/to/a/main/checkout … (same)      ← the "before" column
//
// Needs google-chrome on PATH. Spends nothing: minting a realtime client
// secret is free, the peer connection is the fake below, and /api/tts is
// refused in the page so no voice is ever synthesized.
//
// What only this can answer (vitest has no screen):
//   - does a turn that used to vanish now put its words on the listener's pane?
//   - is an invented sentence kept OFF it?
//   - does the button say "Still finishing…" while a slow turn drains, and do
//     both panes carry the marker when part of a turn was lost?
//   - is a turn the mic heard nothing in SAID to be one?
//
// The fake provider does what the real one was measured doing
// (tests/live-fire/tabletop-flush.measure.ts): VAD commits only on a pause; a
// segment past the context cap reaches the model with no audio and it writes
// something anyway; a manual commit is accepted with server_vad on and is not
// answered; an empty one is refused. Sign-in is the interpreter check's trick:
// a fake Supabase on localhost and a seeded session for a made-up founder.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEY = process.env.OPENAI_API_KEY?.trim();
if (!KEY) throw new Error("OPENAI_API_KEY is required (the mint route asks OpenAI for a client secret; that is free).");
const APP_DIR = process.env.APP_DIR?.trim() || process.cwd();
const APP_PORT = Number(process.env.APP_PORT ?? 3078);
const FAKE_PORT = Number(process.env.FAKE_PORT ?? 54398);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9345);
const FOUNDER = "flush-probe@example.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fakeUser = { id: "00000000-0000-4000-8000-000000000002", aud: "authenticated", role: "authenticated", email: FOUNDER };
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
  if (url.startsWith("/rest/v1/")) return res.writeHead(200, cors).end("[]");
  res.writeHead(200, cors).end("{}");
}).listen(FAKE_PORT, "127.0.0.1");

const serverLog = [];
const app = spawn("node", ["node_modules/next/dist/bin/next", "dev", "--port", String(APP_PORT)], {
  cwd: APP_DIR,
  env: {
    ...process.env,
    OPENAI_API_KEY: KEY,
    NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${FAKE_PORT}`,
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
  try { fake.close(); } catch { /* already closed */ }
};
process.on("exit", shutdown);
process.on("SIGINT", () => process.exit(130));
process.on("uncaughtException", (e) => { console.error(e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error(e); process.exit(1); });
for (const stream of [app.stdout, app.stderr]) {
  stream.on("data", (d) => {
    for (const line of String(d).split("\n")) if (line.includes("[taos-tabletop")) serverLog.push(line.trim());
  });
}
const APP = `http://localhost:${APP_PORT}`;
for (let i = 0; i < 160; i++) {
  try {
    const r = await fetch(`${APP}/robots.txt`);
    if (r.status < 500) break;
  } catch { /* not up yet */ }
  await sleep(500);
}

const dir = mkdtempSync(join(tmpdir(), "taos-flush-"));
chrome = spawn("google-chrome", [
  "--headless=new",
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${join(dir, "profile")}`,
  "--no-sandbox",
  "--disable-gpu",
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
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
    await sleep(100);
  }
  return false;
};

// ── the fake provider, installed before any page script ──
await cdp("Page.enable");
await cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `(() => {
    const scenario = () => window.localStorage.getItem("flush.scenario") || "unbroken";
    const CAP_MS = 6500;      // measured: past ~6.5 s the model is handed no audio
    const VAD_SILENCE = 550;
    window.__sent = [];       // client event TYPES
    window.__tts = 0;
    window.__metrics = [];
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = String(typeof input === "string" ? input : input.url);
      if (url.includes("/v1/realtime/calls")) return Promise.resolve(new Response("v=0\\r\\n", { status: 200 }));
      if (url.includes("/api/tts")) { window.__tts++; return Promise.resolve(new Response("{}", { status: 503 })); }
      if (url.includes("/api/tabletop/metrics")) { try { window.__metrics.push(JSON.parse(init.body)); } catch {} }
      return origFetch.apply(this, arguments);
    };
    class FakeDC extends EventTarget {
      constructor(pc) { super(); this.pc = pc; this.readyState = "open"; this.onmessage = null; this.onerror = null; }
      send(data) { const ev = JSON.parse(data); window.__sent.push(ev.type); this.pc.provider.fromClient(ev); }
      close() { this.readyState = "closed"; }
      emit(ev) { if (this.readyState === "open" && this.onmessage) this.onmessage({ data: JSON.stringify(ev) }); }
    }
    function provider(pc) {
      const kind = scenario();
      let bufferStart = null, voiceEnd = null, pendingManual = null, wordless = false, n = 0, rid = 0, micOn = false;
      const emit = (ev) => pc.dc && pc.dc.emit(ev);
      const respond = (ms, words) => {
        const id = "resp_" + (++rid);
        const fed = ms <= CAP_MS;
        emit({ type: "response.created", response: { id } });
        if (kind === "stall") { emit({ type: "response.output_text.delta", response_id: id, delta: "half a" }); return; }
        setTimeout(() => {
          emit({ type: "response.output_text.delta", response_id: id, delta: fed ? words : "INVENTED" });
          emit({ type: "response.done", response: { id, status: "completed", usage: { input_token_details: { audio_tokens: fed ? Math.round(ms / 100) : 0 } } } });
        }, 400);
      };
      const commit = (byVad) => {
        if (bufferStart === null) {
          if (!byVad) emit({ type: "error", error: { code: "input_audio_buffer_commit_empty", message: "buffer too small" } });
          return;
        }
        const ms = Math.max(0, (voiceEnd ?? Date.now()) - bufferStart);
        const words = wordless ? "CHATTER" : "PART" + (++n);
        wordless = !byVad && voiceEnd !== null;
        bufferStart = byVad ? null : Date.now();
        if (!byVad) pendingManual = { ms, words };
        emit({ type: "input_audio_buffer.committed", item_id: "item_" + n });
        emit({ type: "conversation.item.input_audio_transcription.completed", transcript: "heard" + n });
        if (byVad) respond(ms, words);
      };
      // The mic: live.ts mutes and unmutes the track; that is the voice.
      setInterval(() => {
        const on = !!(pc.track && pc.track.enabled);
        if (on === micOn) return;
        micOn = on;
        if (on) {
          if (kind === "deaf") return;
          setTimeout(() => { bufferStart = Date.now(); voiceEnd = null; emit({ type: "input_audio_buffer.speech_started" }); }, 300);
        } else {
          if (kind === "deaf" || bufferStart === null) return;
          voiceEnd = Date.now();
          if (kind === "never") return;   // VAD never hears the pause
          setTimeout(() => { emit({ type: "input_audio_buffer.speech_stopped" }); commit(true); }, VAD_SILENCE);
        }
      }, 20);
      return {
        fromClient(ev) {
          if (ev.type === "input_audio_buffer.commit") commit(false);
          if (ev.type === "response.create" && pendingManual) { const p = pendingManual; pendingManual = null; respond(p.ms, p.words); }
        }
      };
    }
    class FakePC extends EventTarget {
      constructor() { super(); this.connectionState = "new"; this.onconnectionstatechange = null; this.track = null; this.dc = null; this.provider = provider(this); }
      addTrack(track) { this.track = track; }
      createDataChannel() { this.dc = new FakeDC(this); return this.dc; }
      async createOffer() { return { type: "offer", sdp: "v=0\\r\\n" }; }
      async setLocalDescription() {}
      async setRemoteDescription() {
        this.connectionState = "connected";
        setTimeout(() => { if (this.onconnectionstatechange) this.onconnectionstatechange(); this.dispatchEvent(new Event("connectionstatechange")); }, 0);
      }
      close() { this.connectionState = "closed"; }
    }
    window.RTCPeerConnection = FakePC;
  })();`
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
await evaluate(`localStorage.setItem("sb-127-auth-token", ${JSON.stringify(JSON.stringify(session))}); true`);

// The BOTTOM pane's talk button is the last one in the DOM (the top one is
// rotated to face the other person). A real pointer press, not el.click():
// the button reads its own pointer events (lib/tabletop/paneTap.ts).
async function tapTalk() {
  const box = await evaluate(`(() => {
    const all = document.querySelectorAll("[data-tabletop-talk]");
    const r = all[all.length - 1].getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
}
const talkLabel = () => evaluate(`(() => { const all = document.querySelectorAll("[data-tabletop-talk]"); return all[all.length - 1].textContent.trim(); })()`);
const IDLE = /TAP TO TALK/;

const SCENARIOS = [
  { key: "unbroken", speakMs: 12_000, what: "12 s said straight through — no pause for VAD" },
  { key: "never", speakMs: 4000, what: "VAD never hears the voice stop (never commits)" },
  { key: "stall", speakMs: 3000, what: "the last response starts, then goes quiet" },
  { key: "deaf", speakMs: 3000, what: "the mic is open and VAD hears no voice at all" }
];

const rows = [];
for (const sc of SCENARIOS) {
  await evaluate(`localStorage.setItem("flush.scenario", ${JSON.stringify(sc.key)}); true`);
  await cdp("Page.navigate", { url: `${APP}/tabletop` });
  if (!(await waitFor(`document.querySelectorAll("[data-tabletop-talk]").length === 2`, 120_000))) {
    console.log(`  ${sc.key}: FAIL — /tabletop never rendered its panes`);
    rows.push({ key: sc.key, rendered: false });
    continue;
  }
  await sleep(800);
  await tapTalk();
  if (!(await waitFor(`/TAP WHEN DONE/.test(document.body.innerText)`, 30_000))) {
    const label = await talkLabel();
    console.log(`  ${sc.key}: FAIL — never started recording (button: ${label})`);
    rows.push({ key: sc.key, rendered: false });
    continue;
  }
  await sleep(sc.speakMs);
  const streamedWhileSpeaking = await evaluate(`/PART\\d/.test(document.body.innerText)`);
  await tapTalk();
  const endedAt = Date.now();
  let sawFinishing = false;
  while (Date.now() - endedAt < 60_000) {
    const label = await talkLabel();
    if (/Still finishing/.test(label)) sawFinishing = true;
    if (IDLE.test(label)) break;
    await sleep(100);
  }
  const drainMs = Date.now() - endedAt;
  await sleep(300);
  const dom = await evaluate(`(() => {
    const text = document.body.innerText;
    return {
      parts: Array.from(new Set(text.match(/PART\\d/g) || [])).sort(),
      invented: /INVENTED/.test(text),
      chatter: /CHATTER/.test(text),
      half: /half a/.test(text),
      partialMarks: document.querySelectorAll("[data-tabletop-partial]").length,
      notice: document.querySelector("[data-tabletop-notice]")?.getAttribute("data-tabletop-notice") ?? "",
      noticeText: document.querySelector("[data-tabletop-notice]")?.textContent ?? "",
      sent: window.__sent.filter((t) => t !== "session.update"),
      tts: window.__tts
    };
  })()`);
  // End the session so its numbers post (founder's "end" chip), then read them.
  await evaluate(`(() => { const b = Array.from(document.querySelectorAll("button")).find((x) => /end session/i.test(x.textContent)); if (b) b.click(); return true; })()`);
  await waitFor(`window.__metrics.length > 0`, 3000);
  const metrics = await evaluate(`window.__metrics[0] ?? null`);
  rows.push({ ...sc, rendered: true, streamedWhileSpeaking, sawFinishing, drainMs, dom, metrics });
  console.log(`\n── ${sc.key}: ${sc.what} ──`);
  console.log(`  streamed while still speaking: ${streamedWhileSpeaking ? "yes" : "no"}`);
  console.log(`  after the second tap: ${drainMs} ms to idle${sawFinishing ? ', button said "Still finishing…"' : ""}`);
  console.log(`  on screen: real=${JSON.stringify(dom.parts)} invented=${dom.invented} chatter=${dom.chatter} half-sentence=${dom.half} partial-markers=${dom.partialMarks} notice=${dom.notice || "none"}${dom.noticeText ? ` ("${dom.noticeText}")` : ""}`);
  console.log(`  client sent: ${JSON.stringify(dom.sent)}   tts calls refused: ${dom.tts}`);
  if (metrics) {
    const { committed_segments, drain_ms, drain_outcome, vad_profile, turns, flushed_turns, timeout_turns, forced_commits, dropped_segments, silent_turns } = metrics;
    console.log(`  metrics posted: ${JSON.stringify({ committed_segments, drain_ms, drain_outcome, vad_profile, turns, flushed_turns, timeout_turns, forced_commits, dropped_segments, silent_turns })}`);
  }
}

// ── the verdict: what a person at the table would have got ──
// lost     = the real words never reached the screen, or an invention did
// silent   = something went wrong and the screen said nothing about it
const verdict = (r) => {
  if (!r.rendered) return { lost: true, silent: true };
  const d = r.dom;
  if (r.key === "unbroken") return { lost: d.parts.length === 0 || d.invented || d.chatter, silent: d.invented };
  if (r.key === "never") return { lost: d.parts.length === 0, silent: d.parts.length === 0 && !d.notice };
  if (r.key === "stall") return { lost: false, silent: d.partialMarks === 0 && !d.notice };
  return { lost: false, silent: !d.notice };
};
let lost = 0;
let silent = 0;
console.log("\n── verdict ──");
for (const r of rows) {
  const v = verdict(r);
  if (v.lost) lost += 1;
  if (v.silent) silent += 1;
  console.log(`  ${r.key.padEnd(9)} lost=${v.lost ? "YES" : "no "}  unexplained=${v.silent ? "YES" : "no"}`);
}
console.log(`\nturns lost: ${lost} of ${rows.length}   turns that failed without a word on screen: ${silent} of ${rows.length}`);
console.log("\n── server log ──");
for (const line of serverLog) console.log(`  ${line}`);

ws.close();
// EXPECT=before inverts nothing — it only stops a main checkout's known
// failures from being reported as this script's.
const ok = process.env.EXPECT === "before" ? true : lost === 0 && silent === 0;
console.log(`\n${ok ? "ALL PASSED" : "FAILED"}`);
process.exit(ok ? 0 : 1);
