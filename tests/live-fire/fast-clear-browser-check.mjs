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
//      can measure whether the BOX actually stayed the size it was when the
//      button appeared — and that anchor changed on 8/31. The slot used to
//      take its width from the 56px mic under it, so the number to watch was
//      where the mic sat. With the mic removed (PR #49) an empty wrapper would
//      collapse to zero width and hand it back to the textarea, resizing the
//      box under the caret on the first keystroke. So this now measures the
//      textarea's own width and left edge, empty → typed → cleared.
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
//      taos_lite_translations, ever. Not on settle, not on clear. That is the
//      regression the old shape would reintroduce, and it is
//      checked below against a live page rather than against source text.
//      What the requests then COST is pinned in tests/fast-clear.test.ts,
//      against the route that decides it.
//
// This renders FastShell from a temporary page so the founder gate is out of
// the way — the gate is proved against the route in
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
  // /api/fast/listen is parked and 404s in production now, so nothing on this
  // page should ever reach it. It is still matched first — the substring would
  // otherwise fall into the branch below — and counted, as a negative.
  if (request.url.includes("/api/fast/listen")) {
    void fulfill(requestId, { text: "should never be asked for" });
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

/**
 * The box's geometry — the numbers the layout-shift claim is about now.
 *
 * Width AND left edge: the Clear slot sits to the RIGHT of the textarea in a
 * flex row, so a slot that collapses when the button goes away gives its width
 * back to the box rather than moving it. Watching only `top` would have missed
 * exactly the regression the reserved slot exists to prevent.
 */
const boxBox = () =>
  evaluate(
    `(() => { const r = ${BOX}.getBoundingClientRect();
       return { w: Math.round(r.width), x: Math.round(r.x), y: Math.round(r.y) }; })()`
  );

const sameBox = (a, b) => a && b && a.w === b.w && a.x === b.x && a.y === b.y;

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

if (!(await evaluate(`!!${BOX}`))) {
  console.error("no textarea — is app/fast-probe/page.tsx there?");
  ws.close();
  chrome.kill();
  process.exit(1);
}

// ── 1. An empty box has no Clear, and no mic at all ──────────────────────
const empty = {
  clear: await evaluate(`!!${CLEAR}`),
  // The removal, on the real bundle rather than in source text. If a mic
  // button renders here, the flag leaked or the dock got mounted unguarded.
  mic: await evaluate(`!!${MIC}`),
  // No apostrophe in the English half: the source writes `&rsquo;`, so what
  // renders is U+2019 and an ASCII `'` never matches. Same trap as grepping a
  // deployed bundle for a bilingual label — assert on a marker that survives
  // the encoding, in both directions.
  tip: await evaluate(
    `document.body.innerText.includes("mic works here") &&
     document.body.innerText.includes("micrófono de tu teclado")`
  ),
  box: await boxBox()
};

// ── 2. Type one quickie and let it settle ────────────────────────────────
await type(FIRST);
await sleep(SETTLED);

const typed = {
  clear: await evaluate(`!!${CLEAR}`),
  box: await boxBox(),
  clearRect: await rectOf(CLEAR),
  shown: await evaluate(`document.querySelector('section p')?.textContent ?? ''`),
  engineLine: await evaluate(`document.body.innerText.includes('Azure Translator')`),
  rows: rows(),
  calls: fastCalls()
};

// ── 3. Tap it ────────────────────────────────────────────────────────────
await tapClear();

const cleared = {
  value: await evaluate(`${BOX}.value`),
  clear: await evaluate(`!!${CLEAR}`),
  box: await boxBox(),
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

console.log("\n── /fast Clear, real browser ───────────────────────────────");
console.log(`  empty box: clear button present .... ${empty.clear}   (want false)`);
console.log(`  after typing: clear present ........ ${typed.clear}`);
console.log(`  clear button size .................. ${typed.clearRect?.w}x${typed.clearRect?.h}`);
console.log(`\n  THE MIC IS GONE`);
console.log(`  dictate button on the page ........ ${empty.mic}   (want false)`);
console.log(`  keyboard-mic tip, both languages .. ${empty.tip}`);
console.log(`  /api/fast/listen ever called ...... ${posts("/api/fast/listen")}   (want 0)`);
console.log(`\n  BOX  empty ${JSON.stringify(empty.box)}`);
console.log(`       typed ${JSON.stringify(typed.box)}`);
console.log(`     cleared ${JSON.stringify(cleared.box)}`);
console.log(`  no layout shift ................... ${sameBox(empty.box, typed.box) && sameBox(typed.box, cleared.box)}`);
console.log(`\n  after the tap:`);
console.log(`  box ............................... ${JSON.stringify(cleared.value)}`);
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

const ok =
  empty.clear === false &&
  // ── the removal, on the real bundle ──
  empty.mic === false &&
  empty.tip === true &&
  posts("/api/fast/listen") === 0 &&
  typed.clear === true &&
  typed.clearRect.h === 32 && // still the quiet one it shipped as
  typed.shown.includes(FIRST_ES) &&
  // ── the no-layout-shift claim, re-anchored on the box itself ──
  sameBox(empty.box, typed.box) &&
  sameBox(typed.box, cleared.box) &&
  cleared.value === "" &&
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
  fresh.shown.includes(SECOND_ES);

console.log(`\n  ${ok ? "PASS" : "FAIL"}`);
ws.close();
chrome.kill();
process.exit(ok ? 0 : 1);
