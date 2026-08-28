// The two /call audio mechanisms that only a real browser can answer for.
//
//   node tests/live-fire/call-audio-browser-check.mjs
//
// Needs google-chrome on PATH. Costs nothing and talks to no provider, so it
// is safe to re-run; it lives beside the live-fire rig rather than in tests/
// because it drives Chrome over CDP and `npm test` should not.
//
// Neither check can be made in vitest, and both guard a fix whose failure mode
// is silence on a customer's call:
//
//   A. `setMuted(true)` mid-readout must actually stop the sound, not merely
//      mute an element that goes on playing. jsdom has no audio clock, so only
//      a real element can say how long the teardown takes.
//        measured 2026-08-28: 0.50 ms, paused, src cleared.
//
//   B. The ducking control runs through a WebAudio gain node, because
//      HTMLMediaElement.volume is READ-ONLY on iOS and the three-step control
//      did nothing at all there. The design holds the gain at ZERO until an
//      analyser placed BEFORE it has seen signal — so a browser that refuses
//      to route a remote stream into WebAudio degrades to the old behaviour
//      rather than to silence. This proves the probe can see through a closed
//      gain, and that the gate really attenuates.
//        measured 2026-08-28: probe 128 at gain 0, speaker 0 / 32 / 128 at
//        gain 0 / 0.25 / 1 — exactly quarter amplitude at the "quiet" step.
import { spawn } from "node:child_process";
import { createServer } from "node:http";

// getUserMedia and AudioContext need a SECURE CONTEXT. about:blank is not one;
// http://localhost is. So the checks run on a one-line page served locally.
const site = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<!doctype html><title>taos audio check</title><body></body>");
}).listen(0);
await new Promise((r) => site.on("listening", r));
const SITE_URL = `http://localhost:${site.address().port}/`;

const PORT = 9333;
const chrome = spawn("google-chrome", [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  "--no-sandbox",
  "--autoplay-policy=no-user-gesture-required",
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
  "--disable-gpu",
  "about:blank"
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error("Chrome never came up");
}

const wsUrl = await targets();
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("cdp open failed")); });

let id = 0;
const pending = new Map();
ws.onmessage = ({ data }) => {
  const msg = JSON.parse(String(data));
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
function send(method, params = {}) {
  const msgId = ++id;
  return new Promise((resolve) => { pending.set(msgId, resolve); ws.send(JSON.stringify({ id: msgId, method, params })); });
}
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  if (r.result?.result?.subtype === "error") throw new Error(r.result.result.description);
  return r.result?.result?.value;
}

await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: SITE_URL });
await sleep(700);

// ── A: how fast does the readout actually go quiet? ────────────────────────
// This is the sequence lib/call/interpreter.ts runs in stopSpokenAudio().
const stopLatency = await evaluate(`(async () => {
  // A one-second 440Hz WAV, as a blob URL — the same shape /api/tts returns.
  const sr = 8000, n = sr;
  const buf = new ArrayBuffer(44 + n * 2), view = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); view.setUint32(4, 36 + n * 2, true); str(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sr, true); view.setUint32(28, sr * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, "data"); view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) view.setInt16(44 + i * 2, Math.sin(i / sr * 440 * 2 * Math.PI) * 16000, true);
  const url = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));

  const el = document.createElement("audio");
  el.autoplay = true; el.src = url;
  document.body.appendChild(el);
  await el.play();
  await new Promise(r => setTimeout(r, 250));
  const playingBefore = !el.paused && el.currentTime > 0;

  // The stopSpokenAudio() sequence.
  const t0 = performance.now();
  el.pause();
  el.onended = null; el.onerror = null;
  el.removeAttribute("src");
  el.load();
  URL.revokeObjectURL(url);
  const ms = performance.now() - t0;

  await new Promise(r => setTimeout(r, 250));
  return { playingBefore, stoppedSynchronouslyInMs: ms, pausedAfter: el.paused, srcAfter: el.getAttribute("src"), timeAfter: el.currentTime };
})()`);

console.log("A · stopping a playing readout");
console.log("   was playing before:      ", stopLatency.playingBefore);
console.log("   teardown took:           ", stopLatency.stoppedSynchronouslyInMs.toFixed(2), "ms");
console.log("   paused 250ms later:      ", stopLatency.pausedAfter);
console.log("   src after:               ", JSON.stringify(stopLatency.srcAfter));
console.log("");

// ── B: does the gain path actually carry and attenuate a live stream? ──────
const gainCheck = await evaluate(`(async () => {
  // A MediaStream with a KNOWN, loud signal in it. Chrome's fake microphone
  // works but peaks at ~9/128, which quantises to the same byte after a gain
  // stage and cannot distinguish "quiet" from "full" — a resolution problem in
  // the instrument, not in the mechanism. An oscillator piped through a
  // MediaStreamDestination produces the same kind of object a remote WebRTC
  // track does, at an amplitude that can actually be measured.
  const ctx = new AudioContext();
  await ctx.resume();
  const osc = ctx.createOscillator();
  osc.frequency.value = 440;
  const dest = ctx.createMediaStreamDestination();
  osc.connect(dest);
  osc.start();
  const stream = dest.stream;
  const source = ctx.createMediaStreamSource(stream);
  const pre = ctx.createAnalyser();      // BEFORE the gain — the probe's position
  const gain = ctx.createGain();
  const post = ctx.createAnalyser();     // AFTER — stands in for the speaker
  gain.gain.value = 0;                   // held silent until the probe proves the graph
  source.connect(pre); pre.connect(gain); gain.connect(post); post.connect(ctx.destination);

  const peak = (node) => { const b = new Uint8Array(node.fftSize); node.getByteTimeDomainData(b);
    return Math.max(...[...b].map(v => Math.abs(v - 128))); };
  const settle = (ms) => new Promise(r => setTimeout(r, ms));

  await settle(600);
  const preSilentGain = peak(pre);    // must be > 0: the probe sees signal at gain 0
  const postSilentGain = peak(post);  // must be ~0: nothing reaches the speaker yet

  gain.gain.value = 1;
  await settle(400);
  const postFullGain = peak(post);

  gain.gain.value = 0.25;
  await settle(400);
  const postQuietGain = peak(post);

  osc.stop();
  ctx.close();
  return { preSilentGain, postSilentGain, postFullGain, postQuietGain, ctxState: "ok" };
})()`);

console.log("B · WebAudio ducking of a live MediaStream");
console.log("   probe sees signal @gain0:", gainCheck.preSilentGain, "(must be > 0)");
console.log("   speaker @gain 0:         ", gainCheck.postSilentGain, "(must be ~0)");
console.log("   speaker @gain 1:         ", gainCheck.postFullGain);
console.log("   speaker @gain 0.25:      ", gainCheck.postQuietGain);

const ok =
  stopLatency.playingBefore === true &&
  stopLatency.pausedAfter === true &&
  stopLatency.stoppedSynchronouslyInMs < 250 &&
  gainCheck.preSilentGain > 0 &&
  gainCheck.postSilentGain <= 1 &&
  gainCheck.postFullGain > 0 &&
  gainCheck.postQuietGain > 0 &&
  gainCheck.postQuietGain < gainCheck.postFullGain;

console.log("\n", ok ? "PASS" : "FAIL");
ws.close();
chrome.kill();
site.close();
process.exit(ok ? 0 : 1);
