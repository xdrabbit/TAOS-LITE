// The Clear button on /fast, walked in a real browser.
//
//   PORT=3125 npm run dev -- --port 3125
//   node tests/live-fire/fast-clear-browser-check.mjs
//
// Needs google-chrome on PATH. Talks to no provider — /api/fast, its listen
// route and the Supabase insert are all fulfilled by the driver — so it costs
// nothing and is safe to re-run.
//
// ── What only a browser can answer ─────────────────────────────────────────
// tests/fast-clear.test.ts pins the behaviour, including the money one — it
// drives POST /api/fast, which is where billing actually lives since #51.
// Three of the four requirements are out of ANY unit test's reach, because
// each is a claim about pixels or about time:
//
//   1. NO LAYOUT SHIFT. The whole reason the slot is reserved rather than
//      faded. A source-reading test can see the wrapper div; only a browser
//      can measure whether the mic actually stayed where it was when the
//      button appeared, which is the thing a thumb on its way down notices.
//   2. FOCUS RETURNS. Pressing a button focuses that button. Whether the caret
//      comes back to the box afterwards is a real event ordering, and calling
//      .click() from JS would fake a pass — so this drives real mouse events.
//   3. THE BROWSER DOES NOT BILL. This one changed shape in #51 and the rig
//      changed with it, rather than pretending to measure what it no longer
//      can. The row used to be written HERE, by FastShell, so counting inserts
//      that left the page was the money assertion. It is written by the server
//      now — off the gaps between requests — so the browser cannot see a
//      billing decision at all, and a rig that reported one would be reporting
//      its own driver.
//
//      What the browser can still answer is the negative, and it is the one
//      worth having on the real bundle: NOTHING on this page writes to
//      taos_lite_translations, ever. Not on settle, not on clear, not on the
//      mic. That is the regression the old shape would reintroduce, and it is
//      checked below against a live page rather than against source text.
//      What the requests then COST is pinned in tests/fast-clear.test.ts,
//      against the route that decides it.
//
// Like the mic rig beside it, this renders FastShell from a temporary page so
// the founder gate is out of the way — the gate is proved against the route in
// tests/fast-gating.test.ts, which is where it is load-bearing. Create
// app/fast-probe/page.tsx as:
//
//   "use client";
//   import { FastShell } from "@/components/FastShell";
//   export default function Probe() { return <FastShell />; }
//
// and delete it afterwards — tests/nav-completeness.test.ts fails on an
// unclassified route if it is left behind, which is the fence working.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const CDP_PORT = 9337;
const APP_PORT = process.env.PORT ?? "3125";
const APP = `http://localhost:${APP_PORT}/fast-probe`;

const FIRST = "where is the pharmacy";
const FIRST_ES = "dónde está la farmacia";
const SECOND = "how much is this";
const SECOND_ES = "cuánto cuesta esto";
const HEARD = "the check please";

// Long enough for the 300ms debounce, the reply, and the 1500ms settle on top.
const SETTLED = 3400;

const chrome = spawn(
  "google-chrome",
  [
    "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    "--no-sandbox",
    "--disable-gpu",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--user-data-dir=/tmp/fast-clear-profile",
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

/** The driver answers /api/fast with whatever the box currently holds. */
function answerFor(text) {
  const t = (text ?? "").toLowerCase();
  if (t.includes("pharmacy")) return FIRST_ES;
  if (t.includes("how much")) return SECOND_ES;
  if (t.includes("check")) return "la cuenta por favor";
  return "…";
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
    void fulfill(requestId, { text: HEARD });
  } else if (request.url.includes("/api/fast")) {
    let sent = "";
    try {
      sent = JSON.parse(request.postData ?? "{}").text ?? "";
    } catch {
      /* not the shape we expected — the fallback answer is fine */
    }
    void fulfill(requestId, {
      translation: answerFor(sent),
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
await send("Fetch.enable", { patterns: [{ urlPattern: "*" }], handleAuthRequests: false });
await send("Browser.grantPermissions", {
  origin: `http://localhost:${APP_PORT}`,
  permissions: ["audioCapture"]
});

/** POSTs only, because supabase-js sends a preflight to the same URL. */
const posts = (fragment) =>
  events.filter(
    (e) =>
      e.method === "Network.requestWillBeSent" &&
      e.params.request.method === "POST" &&
      e.params.request.url.includes(fragment)
  ).length;
/**
 * Writes to the billing table from the PAGE. Must stay 0 forever: the meter is
 * the server's (lib/fast/meter.ts), and a browser that writes a row is a
 * browser that can decline to.
 */
const rows = () => posts("taos_lite_translations");

/** Requests the server's burst rule actually consumes. */
const fastCalls = () => posts("/api/fast");

const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r?.result?.value;
};

const CLEAR = `document.querySelector('button[aria-label="Borrar · Clear"]')`;
const MIC = `document.querySelector('button[aria-label="Dictar · Dictate"]')`;
const BOX = `document.querySelector('textarea')`;

/** Where the mic is right now — the number the layout-shift claim is about. */
const micTop = () =>
  evaluate(`(() => { const r = ${MIC}.getBoundingClientRect(); return Math.round(r.top); })()`);

const rectOf = (selector) =>
  evaluate(
    `(() => { const el = ${selector}; if (!el) return null; const r = el.getBoundingClientRect();
       return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
                w: Math.round(r.width), h: Math.round(r.height) }; })()`
  );

const mouse = (type, at) =>
  send("Input.dispatchMouseEvent", {
    type,
    x: at.x,
    y: at.y,
    button: "left",
    buttons: type === "mouseReleased" ? 0 : 1,
    clickCount: 1,
    pointerType: "mouse"
  });

/** Real key events, so React sees a person typing rather than a value assignment. */
async function type(text) {
  await evaluate(`${BOX}.focus(); true`);
  for (const ch of text) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", text: ch });
    await send("Input.dispatchKeyEvent", { type: "keyUp" });
    await sleep(30);
  }
}

async function tapClear() {
  const at = await rectOf(CLEAR);
  if (!at) throw new Error("no clear button to tap");
  // mousePressed focuses the button, which is exactly the state the focus
  // claim has to recover from.
  await mouse("mousePressed", at);
  await mouse("mouseReleased", at);
  await sleep(400);
}

await send("Page.navigate", { url: APP });
await sleep(4500);

if (!(await evaluate(`!!${MIC}`))) {
  console.error("no mic button — is app/fast-probe/page.tsx there?");
  ws.close();
  chrome.kill();
  process.exit(1);
}

// ── 1. An empty box has no Clear, and the mic sits where it sits ──────────
const empty = {
  clear: await evaluate(`!!${CLEAR}`),
  micTop: await micTop()
};

// ── 2. Type one quickie and let it settle ────────────────────────────────
await type(FIRST);
await sleep(SETTLED);

const typed = {
  clear: await evaluate(`!!${CLEAR}`),
  micTop: await micTop(),
  clearRect: await rectOf(CLEAR),
  micRect: await rectOf(MIC),
  shown: await evaluate(`document.querySelector('section p')?.textContent ?? ''`),
  engineLine: await evaluate(`document.body.innerText.includes('Azure Translator')`),
  rows: rows(),
  calls: fastCalls()
};

// ── 3. Tap it ────────────────────────────────────────────────────────────
await tapClear();

const cleared = {
  box: await evaluate(`${BOX}.value`),
  clear: await evaluate(`!!${CLEAR}`),
  micTop: await micTop(),
  translationGone: await evaluate(
    `!document.body.innerText.includes(${JSON.stringify(FIRST_ES)})`
  ),
  placeholderBack: await evaluate(
    `document.body.innerText.includes('Start typing')`
  ),
  engineLineGone: await evaluate(`!document.body.innerText.includes('Azure Translator')`),
  // The claim that .click() would have faked.
  focused: await evaluate(`document.activeElement === ${BOX}`),
  rows: rows(),
  calls: fastCalls()
};

// ── 4. Retype the SAME words — this must NOT bill again ──────────────────
await type(FIRST);
await sleep(SETTLED);
const retyped = { rows: rows(), calls: fastCalls(), shown: await evaluate(`document.querySelector('section p')?.textContent ?? ''`) };

// ── 5. Clear, then a genuinely NEW quickie — this MUST bill once ─────────
await tapClear();
await type(SECOND);
await sleep(SETTLED);
const fresh = { rows: rows(), calls: fastCalls(), shown: await evaluate(`document.querySelector('section p')?.textContent ?? ''`) };

// ── 6. Clear, then speak — the flow Tom described ────────────────────────
await tapClear();
const micAt = await rectOf(MIC);
await mouse("mousePressed", micAt);
await sleep(1500); // a hold, not a tap
await mouse("mouseReleased", micAt);
await sleep(4000);

const spoke = {
  box: await evaluate(`${BOX}?.value ?? ''`),
  clear: await evaluate(`!!${CLEAR}`),
  micTop: await micTop()
};

// ── 7. And Clear takes the dictated words away too ───────────────────────
await tapClear();
const afterSpokenClear = {
  box: await evaluate(`${BOX}.value`),
  clear: await evaluate(`!!${CLEAR}`),
  focused: await evaluate(`document.activeElement === ${BOX}`)
};

console.log("\n── /fast Clear, real browser ───────────────────────────────");
console.log(`  empty box: clear button present .... ${empty.clear}   (want false)`);
console.log(`  after typing: clear present ........ ${typed.clear}`);
console.log(`  clear button size .................. ${typed.clearRect?.w}x${typed.clearRect?.h}`);
console.log(`  mic button size ................... ${typed.micRect?.w}x${typed.micRect?.h}`);
console.log(`  clear sits ABOVE the mic .......... ${typed.clearRect?.y < typed.micRect?.y}`);
console.log(`  translation on screen ............. ${JSON.stringify(typed.shown)}`);
console.log(`\n  MIC TOP  empty ${empty.micTop} → typed ${typed.micTop} → cleared ${cleared.micTop}`);
console.log(`  no layout shift ................... ${empty.micTop === typed.micTop && typed.micTop === cleared.micTop}`);
console.log(`\n  after the tap:`);
console.log(`  box ............................... ${JSON.stringify(cleared.box)}`);
console.log(`  translation gone .................. ${cleared.translationGone}`);
console.log(`  empty-state prompt back ........... ${cleared.placeholderBack}`);
console.log(`  engine caption gone ............... ${cleared.engineLineGone}`);
console.log(`  clear button gone ................. ${!cleared.clear}`);
console.log(`  focus returned to the box ......... ${cleared.focused}`);
console.log(`\n  THE PAGE NEVER BILLS  (rows written from the browser)`);
console.log(`  after one settled quickie ......... ${typed.rows}   (want 0)`);
console.log(`  after the clear ................... ${cleared.rows}   (want 0)`);
console.log(`  after retyping the SAME words ..... ${retyped.rows}   (want 0)`);
console.log(`  after clear + a NEW quickie ....... ${fresh.rows}   (want 0)`);
console.log(`\n  what the server DOES see  (POST /api/fast)`);
console.log(`  after one settled quickie ......... ${typed.calls}`);
console.log(`  after retyping the SAME words ..... ${retyped.calls}`);
console.log(`  after clear + a NEW quickie ....... ${fresh.calls}`);
console.log(`  (what those cost is pinned in tests/fast-clear.test.ts,`);
console.log(`   against the route that decides it)`);
console.log(`\n  then the mic, held 1.5s:`);
console.log(`  transcript in the box ............. ${JSON.stringify(spoke.box)}`);
console.log(`  clear offered on it ............... ${spoke.clear}`);
console.log(`  mic still un-moved ................ ${spoke.micTop === empty.micTop}`);
console.log(`  clear takes the spoken words too .. ${afterSpokenClear.box === ""}`);
console.log(`  and hands the caret back .......... ${afterSpokenClear.focused}`);

const ok =
  empty.clear === false &&
  typed.clear === true &&
  typed.clearRect.h < typed.micRect.h && // visibly subordinate
  typed.clearRect.y < typed.micRect.y && // and directly above it
  typed.shown.includes(FIRST_ES) &&
  empty.micTop === typed.micTop && // ── the no-layout-shift claim ──
  typed.micTop === cleared.micTop &&
  cleared.box === "" &&
  cleared.clear === false &&
  cleared.translationGone === true &&
  cleared.placeholderBack === true &&
  cleared.engineLineGone === true &&
  cleared.focused === true &&
  // ── the money claim, in the only form a browser can still make it ──
  typed.rows === 0 &&
  cleared.rows === 0 &&
  retyped.rows === 0 &&
  fresh.rows === 0 &&
  // and the screen still WORKS: a retyped phrase shows its answer again, it
  // simply is not the page's business whether that costs anything.
  retyped.shown.includes(FIRST_ES) &&
  fresh.calls > retyped.calls && // a new phrase really does reach the route
  fresh.shown.includes(SECOND_ES) &&
  spoke.box === HEARD &&
  spoke.clear === true &&
  spoke.micTop === empty.micTop &&
  afterSpokenClear.box === "" &&
  afterSpokenClear.clear === false &&
  afterSpokenClear.focused === true;

console.log(`\n  ${ok ? "PASS" : "FAIL"}`);
ws.close();
chrome.kill();
process.exit(ok ? 0 : 1);
