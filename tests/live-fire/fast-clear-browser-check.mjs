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
// tests/fast-clear.test.ts pins the shape: the predicate, the setters in the
// handler, and the negative that matters (the handler never touches
// `billedRef`). Three of the four requirements are out of its reach entirely,
// because each is a claim about pixels or about time:
//
//   1. NO LAYOUT SHIFT. The whole reason the slot is reserved rather than
//      faded. A source-reading test can see the wrapper div; only a browser
//      can measure whether the mic actually stayed where it was when the
//      button appeared, which is the thing a thumb on its way down notices.
//   2. FOCUS RETURNS. Pressing a button focuses that button. Whether the caret
//      comes back to the box afterwards is a real event ordering, and calling
//      .click() from JS would fake a pass — so this drives real mouse events.
//   3. THE METER, END TO END. The unit test walks a Set that stands in for
//      `billedRef`. This walks the actual component: type, settle, clear,
//      retype the SAME words — and counts the inserts that really left the
//      page. That is the assertion that costs money when it is wrong, and it
//      is the one that a stand-in cannot honestly make.
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

/** Billed rows: POSTs, because supabase-js sends a preflight to the same URL. */
const posts = (fragment) =>
  events.filter(
    (e) =>
      e.method === "Network.requestWillBeSent" &&
      e.params.request.method === "POST" &&
      e.params.request.url.includes(fragment)
  ).length;
const rows = () => posts("taos_lite_translations");

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
  rows: rows()
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
  rows: rows()
};

// ── 4. Retype the SAME words — this must NOT bill again ──────────────────
await type(FIRST);
await sleep(SETTLED);
const retyped = { rows: rows(), shown: await evaluate(`document.querySelector('section p')?.textContent ?? ''`) };

// ── 5. Clear, then a genuinely NEW quickie — this MUST bill once ─────────
await tapClear();
await type(SECOND);
await sleep(SETTLED);
const fresh = { rows: rows(), shown: await evaluate(`document.querySelector('section p')?.textContent ?? ''`) };

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
console.log(`\n  BILLED ROWS`);
console.log(`  after one settled quickie ......... ${typed.rows}   (want 1)`);
console.log(`  after the clear ................... ${cleared.rows}   (want 1 — a clear is not a purchase)`);
console.log(`  after retyping the SAME words ..... ${retyped.rows}   (want 1 — not billed twice)`);
console.log(`  after clear + a NEW quickie ....... ${fresh.rows}   (want 2 — a fresh settled translation)`);
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
  typed.rows === 1 &&
  cleared.rows === 1 &&
  retyped.rows === 1 && // ── the money claim: no double-count ──
  retyped.shown.includes(FIRST_ES) && // and it still SHOWS, it just does not re-bill
  fresh.rows === 2 && // ── and a new entry still meters as one ──
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
