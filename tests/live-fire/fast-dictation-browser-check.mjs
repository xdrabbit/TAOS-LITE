// The mic on /fast, walked in a real browser with a real MediaRecorder.
//
//   PORT=3025 npm run dev -- --port 3025
//   node tests/live-fire/fast-dictation-browser-check.mjs
//
// Needs google-chrome on PATH. Talks to no provider — /api/fast/listen and
// /api/fast are both fulfilled by the driver — so it costs nothing and is
// safe to re-run. It lives beside the live-fire rig rather than in tests/
// because it drives Chrome over CDP and `npm test` should not.
//
// ── What only a browser can answer ─────────────────────────────────────────
// tests/fast-dictation.test.ts proves the route: the gate, the shared rate
// buckets, transcript-and-stop. What it cannot reach is the claim the feature
// is actually FOR:
//
//   speak → the words appear IN THE INPUT → they are still editable →
//   fixing one runs the ordinary settled-input flow, exactly as typing does.
//
// Every step of that is a MediaRecorder, a React state update and a timer, and
// a source-reading test can see none of it.
//
// What this rig no longer measures is what a dictation COSTS. It used to count
// the Supabase inserts leaving the page, because until #51 the page was what
// billed; the meter is the server's now (lib/fast/meter.ts), so the browser
// cannot see a billing decision and a rig reporting one would be reporting its
// own driver. The negative is still worth having on the real bundle, and it is
// the regression that matters — the page must write NO rows, ever — so that is
// what is asserted. What the resulting requests cost is pinned against the
// route in tests/fast-metering.test.ts.
//
// ── The two traps in writing this ──────────────────────────────────────────
// 1. Count POSTs, not requests. supabase-js sends a CORS preflight OPTIONS to
//    the same URL, so counting by URL double-reports — the trap the typing rig
//    fell into first (see its header). Still true of the /api/fast counts.
// 2. Chrome's fake capture device is a tone generator, not silence, and the
//    recording is real webm. That is the point: the audio path is genuinely
//    exercised up to the moment the upload is intercepted, so a broken mime
//    ladder or a mic that was never released still fails here.
//
// This renders FastShell from a temporary page so the founder gate is out of
// the way: the gate is proved in tests/fast-dictation.test.ts against the
// route, which is where it is load-bearing. Create app/fast-probe/page.tsx as:
//
//   "use client";
//   import { FastShell } from "@/components/FastShell";
//   export default function Probe() { return <FastShell />; }
//
// and delete it afterwards — tests/nav-completeness.test.ts will fail on an
// unclassified route if it is left behind, which is the fence working.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const CDP_PORT = 9335;
const APP_PORT = process.env.PORT ?? "3025";
const APP = `http://localhost:${APP_PORT}/fast-probe`;

const HEARD = "where is the pharmacy";
const TRANSLATED = "dónde está la farmacia";

const chrome = spawn(
  "google-chrome",
  [
    "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    "--no-sandbox",
    "--disable-gpu",
    // A real microphone, granted without a prompt. The capture device is a
    // tone generator, so MediaRecorder produces genuine encoded audio.
    //
    // Both flags, and the SECOND one is easy to get wrong: the fake-device
    // flag is "...-for-media-stream", not "...-for-media-capture". A
    // misspelled Chrome flag is silently ignored, so the first run of this
    // script opened the machine's REAL microphone, got NotReadableError, and
    // looked exactly like a broken mic button.
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--user-data-dir=/tmp/fast-dictation-profile",
    "about:blank"
  ],
  { stdio: "ignore" }
);

async function firstPage() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const list = await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("chrome never came up");
}

const target = await firstPage();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve) => (ws.onopen = resolve));

let id = 0;
const pending = new Map();
const events = [];
/** Every upload the mic actually sent, so its size can be asserted on. */
const uploads = [];

function send(method, params = {}) {
  const n = (id += 1);
  ws.send(JSON.stringify({ id: n, method, params }));
  return new Promise((resolve) => pending.set(n, resolve));
}

function fulfill(requestId, body) {
  return send("Fetch.fulfillRequest", {
    requestId,
    responseCode: 200,
    responseHeaders: [{ name: "Content-Type", value: "application/json" }],
    body: Buffer.from(JSON.stringify(body)).toString("base64")
  });
}

ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
    return;
  }
  if (!msg.method) return;
  events.push(msg);
  if (msg.method !== "Fetch.requestPaused") return;
  const { requestId, request } = msg.params;
  // Order matters: /api/fast/listen also contains "/api/fast".
  if (request.url.includes("/api/fast/listen")) {
    uploads.push(Number(request.headers["Content-Length"] ?? request.postDataEntries?.length ?? 0));
    void fulfill(requestId, { text: HEARD });
  } else if (request.url.includes("/api/fast")) {
    void fulfill(requestId, {
      translation: TRANSLATED,
      detectedSource: "en",
      targetLanguage: "es",
      engine: "azure",
      fallback: null
    });
  } else {
    void send("Fetch.continueRequest", { requestId });
  }
};

await send("Network.enable");
await send("Page.enable");
await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
// Grant the mic without a prompt for this origin as well as via the flag —
// belt and braces, because a permission prompt in headless is a hang.
await send("Browser.grantPermissions", {
  origin: `http://localhost:${APP_PORT}`,
  permissions: ["audioCapture"]
});

const posts = (fragment) =>
  events.filter(
    (e) =>
      e.method === "Network.requestWillBeSent" &&
      e.params.request.method === "POST" &&
      e.params.request.url.includes(fragment)
  ).length;

const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r?.result?.value;
};

await send("Page.navigate", { url: APP });
await sleep(4500);

const micSelector = `document.querySelector('button[aria-label="Dictar · Dictate"]')`;
const box = `document.querySelector('textarea')`;

// Watch every stream the page opens, so "did it let go of the microphone?"
// can be asked of the TRACKS rather than of the UI. An earlier version of this
// check asked whether anything on the page had aria-pressed="true" and failed
// on the selected language pill — which is a check that tests the rig.
await evaluate(`(() => {
  window.__streams = [];
  const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = (c) =>
    real(c).then((s) => { window.__streams.push(s); return s; });
  return true;
})()`);

const micExists = await evaluate(`!!${micSelector}`);
if (!micExists) {
  console.error("no mic button — is app/fast-probe/page.tsx there?");
  ws.close();
  chrome.kill();
  process.exit(1);
}

// ── Hold the mic for a second and a half, then let go ──────────────────────
// Real pointer events, because the button distinguishes a hold from a tap and
// a synthetic click reports neither. The rect is read from the page so the
// press lands on the button and not next to it.
const rect = await evaluate(
  `(() => { const r = ${micSelector}.getBoundingClientRect();
     return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`
);

const mouse = (type, extra = {}) =>
  send("Input.dispatchMouseEvent", {
    type,
    x: rect.x,
    y: rect.y,
    button: "left",
    buttons: type === "mouseReleased" ? 0 : 1,
    clickCount: 1,
    pointerType: "mouse",
    ...extra
  });

await mouse("mousePressed");
await sleep(1500); // past TAP_MS, so this is a hold; past FAST_MIN_DICTATION_MS
const whileRecording = await evaluate(
  `document.body.innerText.includes('Listening')`
);
await mouse("mouseReleased");

// The upload, the transcript, then the debounce and the settle.
await sleep(4000);

const afterDictation = {
  box: await evaluate(`${box}.value`),
  listen: posts("/api/fast/listen"),
  translate: posts("/api/fast") - posts("/api/fast/listen"),
  rows: posts("taos_lite_translations"), // must stay 0: the page never bills
  calls: posts("/api/fast"),
  shown: await evaluate(`document.querySelector('section p')?.textContent ?? ''`),
  // The browser shows a recording indicator until every track is stopped, so
  // a mic left open after a two-second quickie is a phone that looks bugged
  // and a battery that drains. Asked of the tracks, not of the button.
  micStreams: await evaluate(`window.__streams.length`),
  micReleased: await evaluate(
    `window.__streams.every((s) => s.getAudioTracks().every((t) => t.readyState === "ended"))`
  ),
  micButtonIdle: await evaluate(`${micSelector}.getAttribute('aria-pressed')`)
};

// ── The transcript is a DRAFT — fix a word and it re-translates ────────────
// The whole reason /fast dictates into a text field instead of at a
// translator. Typing after a dictation must behave exactly like typing.
await evaluate(`${box}.focus(); true`);
for (const ch of " open") {
  await send("Input.dispatchKeyEvent", { type: "keyDown", text: ch });
  await send("Input.dispatchKeyEvent", { type: "keyUp" });
  await sleep(45);
}
await sleep(4000);

const afterEdit = {
  box: await evaluate(`${box}.value`),
  translate: posts("/api/fast") - posts("/api/fast/listen"),
  rows: posts("taos_lite_translations"),
  calls: posts("/api/fast")
};

// ── The other half of the interaction: a TAP latches ──────────────────────
// A hold is push-to-talk; a quick tap keeps listening until the next tap.
// Both, because both are things people do to a mic button, and a screen for
// somebody walking cannot afford to be right about only one of them. The box
// is emptied first so the transcript this produces is unambiguous.
await evaluate(
  `(() => { const el = ${box};
     const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
     set.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`
);
await sleep(2500); // let the cleared box settle before the tap

await mouse("mousePressed");
await sleep(120); // well inside TAP_MS — a tap, not a hold
await mouse("mouseReleased");
await sleep(900);
const latched = {
  stillListening: await evaluate(`document.body.innerText.includes('Listening')`),
  copy: await evaluate(
    `document.body.innerText.includes('tap to stop') ? 'tap to stop' : 'let go when done'`
  )
};
// The second tap ends it. Past FAST_MIN_DICTATION_MS by now, so this is a
// real recording and not a fumble.
await mouse("mousePressed");
await mouse("mouseReleased");
await sleep(4000);

const afterTap = {
  box: await evaluate(`${box}.value`),
  listen: posts("/api/fast/listen"),
  idle: await evaluate(`!document.body.innerText.includes('Listening')`)
};

console.log("\n── FastShell's mic, real browser, real MediaRecorder ────────");
console.log(`  held the mic 1.5s`);
console.log(`  listening banner shown ....... ${whileRecording}`);
console.log(`  upload(s) to /api/fast/listen  ${afterDictation.listen}`);
console.log(`  transcript landed in the box   ${JSON.stringify(afterDictation.box)}`);
console.log(`  translation on screen ........  ${JSON.stringify(afterDictation.shown)}`);
console.log(`  POST /api/fast ..............   ${afterDictation.translate}`);
console.log(`  rows written by the page ....   ${afterDictation.rows}   (want 0)`);
console.log(`  POST /api/fast ..............   ${afterDictation.calls}`);
console.log(`  mic streams opened ..........   ${afterDictation.micStreams}`);
console.log(`  every track ended afterwards .  ${afterDictation.micReleased}`);
console.log(`  mic button back to idle ......  ${afterDictation.micButtonIdle}`);
console.log(`\n  then " open" typed onto the transcript:`);
console.log(`  box .........................   ${JSON.stringify(afterEdit.box)}`);
console.log(`  POST /api/fast (cumulative) .   ${afterEdit.translate}`);
console.log(`  rows written by the page ....   ${afterEdit.rows}   (want 0)`);
console.log(`  POST /api/fast (cumulative) .   ${afterEdit.calls}`);
console.log(`\n  then a TAP instead of a hold:`);
console.log(`  still listening after release   ${latched.stillListening}`);
console.log(`  what it says ................   ${JSON.stringify(latched.copy)}`);
console.log(`  box after the second tap ....   ${JSON.stringify(afterTap.box)}`);
console.log(`  uploads (cumulative) ........   ${afterTap.listen}`);
console.log(`  back to idle ................   ${afterTap.idle}`);

const ok =
  whileRecording === true &&
  afterDictation.listen === 1 &&
  afterDictation.box === HEARD &&
  afterDictation.shown.includes(TRANSLATED) &&
  afterDictation.translate >= 1 &&
  afterDictation.rows === 0 &&
  afterDictation.micStreams === 1 &&
  afterDictation.micReleased === true &&
  afterDictation.micButtonIdle === "false" &&
  afterEdit.box === `${HEARD} open` &&
  afterEdit.rows === 0 && // the page bills nothing, however the words arrived
  afterEdit.calls > afterDictation.calls && // the edit really does reach the route
  latched.stillListening === true && // a tap does not end the recording
  latched.copy === "tap to stop" && // and the screen says which mode it is in
  afterTap.listen === 2 &&
  afterTap.box === HEARD &&
  afterTap.idle === true;

console.log(`\n  ${ok ? "PASS" : "FAIL"}`);
ws.close();
chrome.kill();
process.exit(ok ? 0 : 1);
