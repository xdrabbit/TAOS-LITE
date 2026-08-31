// The nested menus, walked with real touch events at real phone widths.
//
//   npm run dev            # port 3017
//   node tests/live-fire/menu-tap-browser-check.mjs
//
// Needs google-chrome on PATH. Talks to no provider and spends nothing — it
// only taps a header — but it drives Chrome over CDP, so it lives here rather
// than in tests/ and `npm test` never runs it.
//
// ── What only a browser can answer ─────────────────────────────────────────
// Tom, 8/31, on the Droid: reaching Call through Together ▾ took two or three
// touches, every time. Every source-reading test passed, both menus close on
// an outside pointerdown with a proper containment check, and the handlers
// were not the problem. The problem was geometry, and geometry needs layout —
// a jsdom has none, and neither does reading the file.
//
// What this rig found on the broken header (2026-08-31):
//
//   viewport   nav content   "More · Más" trigger    elementFromPoint
//                 ends at      off-screen by          at its centre
//     390 px      405.9 px        15.9 px               NOTHING
//     360 px      405.9 px        45.9 px               NOTHING
//     320 px      405.9 px        85.9 px               NOTHING
//
// Two tap-eaters out of that one number:
//
//   1. The grid trigger was laid out PAST THE RIGHT EDGE of the phone. Not
//      clipped — off-screen. Only a sliver of it was ever touchable.
//   2. document.scrollWidth (406) exceeded the viewport, so the page could be
//      panned sideways; the meta viewport sets initial-scale=1 with no
//      maximum-scale, so nothing pins it. On a pannable page a touch that
//      drifts is a PAN and the browser dispatches NO CLICK AT ALL. Measured
//      on the Together pill: 12 px of drift still clicks, 20 px of drift
//      scrolls the page 7 px and fires nothing. A thumb reaching across a
//      phone drifts further than 20 px.
//
// That is the whole "2-3 touches": the row ate the first touch, slid out from
// under the second, and landed the third. It read as an event race and was a
// width. tests/nav-tap-targets.test.ts pins the fix in a form CI can run;
// this is the rig that measured it and the one to re-run when the header
// grows again — it has grown back once already (the Together menu was created
// on 8/19 to fix this same overflow, and by 8/30 the row measured 406 px).
//
// ── Running it ─────────────────────────────────────────────────────────────
// The signed-in header only renders for a signed-in user, so this mounts
// TranslatorShell from a temporary page rather than fighting Supabase. Create
// app/menu-probe/page.tsx as:
//
//   "use client";
//   import { TranslatorShell } from "@/components/TranslatorShell";
//   export default function Probe() {
//     return <TranslatorShell email="xdrabbit@gmail.com" profile={null} onSignOut={() => {}} />;
//   }
//
// (and a second one with a non-founder address to walk a customer's header)
// then DELETE THEM — tests/nav-completeness.test.ts fails on an unclassified
// route if one is left behind, which is that fence working.
//
// ── The trap in writing this check, and the correction ─────────────────────
// This ran `mobile: false` for its first day, on the grounds that emulating
// with `mobile: true` grew the viewport to the CONTENT width and hid the
// overflow being measured: innerWidth came back 406 on a 390 px override.
//
// That observation was right and the conclusion drawn from it was wrong. It
// is `window.innerWidth` that mobile emulation reports as the wider number;
// `document.documentElement.clientWidth` — which is what every check below
// actually reads — stays at the width asked for. Measured 8/31 against a page
// holding one deliberately 406 px-wide row inside a 390 px viewport:
//
//                  innerWidth   clientWidth   scrollWidth   pannable?
//   mobile: false      390          390           406        yes, seen
//   mobile: true       406          390           406        yes, seen
//
// So the overflow is visible either way, and `mobile: true` is the profile a
// phone actually has: no classic scrollbar eating 15 px of layout (under
// `mobile: false` the fixed header measured `clientWidth` 375 on a 390 px
// device — every width below was quietly 15 px pessimistic), a mobile user
// agent, and the mobile compositor's own touch handling. It is what this rig
// runs now.
//
// The one thing NOT to do is assert on `window.innerWidth`. Nothing here
// does, and this note is why.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9353;
const BASE = process.env.BASE ?? "http://localhost:3017";
const FOUNDER = `${BASE}/menu-probe`;
const CUSTOMER = `${BASE}/menu-probe-cust`;
const WIDTHS = [390, 360, 320];

const chrome = spawn(
  "google-chrome",
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    "--no-sandbox",
    "--disable-gpu",
    "--user-data-dir=/tmp/menu-tap-check-profile",
    "about:blank"
  ],
  { stdio: "ignore" }
);

async function firstPage() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json();
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
function send(method, params = {}) {
  const n = (id += 1);
  ws.send(JSON.stringify({ id: n, method, params }));
  return new Promise((res, rej) => pending.set(n, { res, rej }));
}
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
  }
};

async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
}

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });

let failures = 0;
function check(ok, label, detail = "") {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

/** One finger: down, optional sideways drift, up. `drift` in CSS px. */
async function tap(x, y, drift = 0) {
  await send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y, radiusX: 12, radiusY: 12 }]
  });
  for (let i = 1; i <= (drift ? 6 : 0); i += 1) {
    await sleep(16);
    await send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x + (drift * i) / 6, y, radiusX: 12, radiusY: 12 }]
    });
  }
  await sleep(40);
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(400);
}

async function open(url, width) {
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height: 844,
    deviceScaleFactor: 3,
    // A real phone profile: see the header note. clientWidth stays honest.
    mobile: true
  });
  await send("Page.navigate", { url });
  for (let i = 0; i < 40; i += 1) {
    await sleep(250);
    const ready = await evaluate(
      `(() => { const h = document.querySelector('header');
        return !!h && Object.keys(h).some(k => k.startsWith('__react')); })()`
    );
    if (ready) return;
  }
  throw new Error(`${url} never hydrated — is \`npm run dev\` up, and does the probe page exist?`);
}

/** Centre of a thing, plus whether that centre is actually touchable. */
async function control(selector) {
  return evaluate(`(() => {
    const el = ${selector};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    return {
      cx, cy,
      w: +r.width.toFixed(1), h: +r.height.toFixed(1),
      offscreen: +Math.max(0, r.right - document.documentElement.clientWidth).toFixed(1),
      reaches: !!hit && (hit === el || el.contains(hit))
    };
  })()`);
}

const TOGETHER = `[...document.querySelectorAll('button')].find(b => b.textContent.includes('Together'))`;
const GRID = `document.querySelector('button[aria-haspopup="menu"][aria-label*="More"]')`;
const SHARE = `document.querySelector('button[aria-label*="Share"]')`;
const CALL_PILL = `document.querySelector('header a[href="/call"]')`;
const item = (text) =>
  `[...document.querySelectorAll('[role="menuitem"]')].find(a => a.textContent.includes(${JSON.stringify(text)}))`;

// ── 1. The page can never be panned, and nothing sits off the glass ────────
for (const width of WIDTHS) {
  console.log(`\n== founder header at ${width} px ==`);
  await open(FOUNDER, width);
  const geo = await evaluate(`({
    layout: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    headerHeight: +document.querySelector('header').getBoundingClientRect().height.toFixed(0)
  })`);
  check(
    geo.scrollWidth <= geo.layout,
    "the page cannot be panned sideways",
    `scrollWidth ${geo.scrollWidth} vs layout ${geo.layout}`
  );
  // 44 for everything, 8/31. The four pills used to be passed `min: 0` while
  // the two icon triggers were held to 44 — so this rig reported "ALL CHECKS
  // PASSED" over a pill row that measured 48x30, and #53's description went
  // out claiming every control was ≥44 px. A floor that is only applied to
  // the controls somebody remembered is not a floor. The pills are the row a
  // thumb reaches for most; they are 48x44 now.
  //
  // Width is deliberately part of it too: 44x44 is the whole target, and a
  // pill that is tall enough and 30 px wide is still a miss waiting to happen.
  for (const [label, sel, min] of [
    ["Live", `document.querySelector('header a[href="/live"]')`, 44],
    ["Call pill", CALL_PILL, 44],
    ["Together ▾", TOGETHER, 44],
    ["Translate", `document.querySelector('header a[href="/translate"]')`, 44],
    ["Share", SHARE, 44],
    ["More · Más", GRID, 44]
  ]) {
    const c = await control(sel);
    if (!c) {
      check(false, `${label} exists`);
      continue;
    }
    check(c.offscreen === 0 && c.reaches, `${label} is on-screen and hit-testable at its centre`,
      `${c.w}x${c.h}${c.offscreen ? `, ${c.offscreen}px off-screen` : ""}`);
    if (min) check(c.w >= min && c.h >= min, `${label} is at least ${min}x${min}`, `${c.w}x${c.h}`);
  }
  console.log(`  (header is ${geo.headerHeight}px tall)`);
}

// ── 2. A drifting thumb never slides the header out from under itself ─────
// Note what is and is not being asserted. Past Chrome's touch slop (~8-20 px)
// a drag stops being a tap and no click fires — that is true of every button
// on every website and is not something a header can fix. What WAS broken is
// the line below it: the drag used to SCROLL THE PAGE, so the row moved, and
// the next touch had to be re-aimed at a target that was no longer where the
// user last saw it. Before the fix, 20 px of drift scrolled the page 7 px and
// 40 px scrolled it 31 px. Nothing to pan now, so scrollX must stay 0 at any
// drift, and a normal tap (0-12 px) still opens the menu.
console.log(`\n== a drifting thumb never slides the header (390 px) ==`);
for (const drift of [0, 12, 20, 40]) {
  await open(FOUNDER, 390);
  const t = await control(TOGETHER);
  await tap(t.cx, t.cy, -drift);
  const opened = await evaluate(`!!document.querySelector('[role="menu"][aria-label="Together"]')`);
  const scrolled = await evaluate(`window.scrollX`);
  check(scrolled === 0, `${String(drift).padStart(2)}px of drift does not scroll the page`,
    `scrollX=${scrolled}, menu ${opened ? "opened" : "did not open"}`);
  if (drift <= 12) check(opened, `${String(drift).padStart(2)}px of drift still counts as a tap`);
}

// ── 3. Two touches to any nested screen. One to Call. ─────────────────────
const JOURNEYS = [
  ["Together ▾ → Chat", FOUNDER, TOGETHER, item("Chat"), "/chat"],
  ["Together ▾ → Table", FOUNDER, TOGETHER, item("Table"), "/tabletop"],
  ["grid → Photo translator", FOUNDER, GRID, item("Photo"), "/vision"],
  ["grid → How to use", FOUNDER, GRID, item("How to use"), "/guide"],
  ["Together ▾ → Chat (customer)", CUSTOMER, TOGETHER, item("Chat"), "/chat"],
  ["grid → Photo (customer)", CUSTOMER, GRID, item("Photo"), "/vision"]
];
console.log(`\n== two touches: one to open, one to select (390 px) ==`);
for (const [label, url, opener, menuItem, expected] of JOURNEYS) {
  await open(url, 390);
  let touches = 0;
  const o = await control(opener);
  await tap(o.cx, o.cy);
  touches += 1;
  const isOpen = await evaluate(`!!document.querySelector('[role="menu"]')`);
  const target = isOpen ? await control(menuItem) : null;
  if (!target) {
    check(false, label, isOpen ? "menu item missing" : `did not open on touch ${touches}`);
    continue;
  }
  check(target.offscreen === 0 && target.reaches && target.h >= 44,
    `${label}: the item is on-screen and ≥44px`, `${target.w}x${target.h}`);
  await tap(target.cx, target.cy);
  touches += 1;
  await sleep(600);
  const path = await evaluate(`location.pathname`);
  check(touches === 2 && path === expected, `${label} in ${touches} touches`, `landed on ${path}`);
}

// ── 4. Call is ONE touch for a founder, and absent for a stranger ─────────
console.log(`\n== Call ==`);
await open(FOUNDER, 390);
const call = await control(CALL_PILL);
check(!!call, "a founder gets a top-level Call pill");
if (call) {
  await tap(call.cx, call.cy);
  await sleep(700);
  const path = await evaluate(`location.pathname`);
  check(path !== "/menu-probe", "one touch leaves the home screen for /call", `landed on ${path}`);
}
await open(CUSTOMER, 390);
check(
  !(await evaluate(`!!${CALL_PILL}`)) && !(await evaluate(`!!document.querySelector('header a[href="/call"]')`)),
  "a stranger sees no Call pill"
);
await open(CUSTOMER, 390);
const ct = await control(TOGETHER);
await tap(ct.cx, ct.cy);
check(
  !(await evaluate(`!!${item("Call")}`)),
  "and no Call entry inside Together ▾ either"
);

// ── 5. An outside touch still closes, and does not eat the touch under it ─
console.log(`\n== outside touch ==`);
await open(FOUNDER, 390);
const g = await control(GRID);
await tap(g.cx, g.cy);
check(await evaluate(`!!document.querySelector('[role="menu"][aria-label="More · Más"]')`),
  "grid menu opens");
await tap(200, 700); // somewhere in the page body
check(!(await evaluate(`!!document.querySelector('[role="menu"][aria-label="More · Más"]')`)),
  "an outside touch closes it");
await open(FOUNDER, 390);
const g2 = await control(GRID);
await tap(g2.cx, g2.cy);
const t2 = await control(TOGETHER);
await tap(t2.cx, t2.cy);
check(
  !(await evaluate(`!!document.querySelector('[role="menu"][aria-label="More · Más"]')`)) &&
    (await evaluate(`!!document.querySelector('[role="menu"][aria-label="Together"]')`)),
  "one touch swaps from the grid menu to Together ▾ — the close does not eat it"
);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
ws.close();
chrome.kill();
process.exit(failures === 0 ? 0 : 1);
