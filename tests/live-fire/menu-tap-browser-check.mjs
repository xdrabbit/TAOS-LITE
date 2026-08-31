// The three-tier nav, walked with real touch events at real phone widths.
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
// touches, every time. Every source-reading test passed, both menus closed on
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
// width.
//
// ── What it is checking now ────────────────────────────────────────────────
// The nav is three tiers as of the IA restructure, and this walks all three:
//
//   PILLS    Translate · Live · Table · Chat (+ Call for founders). No
//            dropdown anywhere in the row — every pill is ONE touch to a
//            screen. "Together ▾" is gone; it held two items behind a
//            disclosure and existed only because the row was once too wide.
//   LAUNCHER The nine-dot grid: every surface TAOS has, as a 2-column icon
//            grid, current screen included. TWO touches to any of them.
//   AVATAR   Identity only — History, the guide, About, Sign out.
//
// The row now carries five pills and three icon buttons where it once carried
// four and two, so the wrap is load-bearing in a way it was not before: check
// 1 below is the one that would catch it growing back off the glass. And the
// launcher is tall as well as wide, which is the same mistake rotated ninety
// degrees — check 6 is that it cannot cover the pills.
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

// BY POSITION, not by label. Both triggers relabel themselves to "Close menu ·
// Cerrar menú" while their menu is open — which is right for a screen reader
// and silently broke this rig's "swap back the other way" check, because the
// selector stopped matching the moment the thing it selected was open. There
// are exactly two menu buttons in the header: the launcher, then the avatar.
const GRID = `document.querySelectorAll('header button[aria-haspopup="menu"]')[0]`;
const AVATAR = `document.querySelectorAll('header button[aria-haspopup="menu"]')[1]`;
const GRID_CLOSED = `document.querySelector('header button[aria-label*="All screens"]')`;
const AVATAR_CLOSED = `document.querySelector('header button[aria-label*="Account"]')`;
const SHARE = `document.querySelector('button[aria-label*="Share"]')`;
const pill = (href) => `document.querySelector('header nav a[href="${href}"]')`;
const CALL_PILL = pill("/call");
const item = (text) =>
  `[...document.querySelectorAll('[role="menuitem"]')].find(a => a.textContent.includes(${JSON.stringify(text)}))`;
const GRID_MENU = `document.querySelector('[role="menu"][aria-label="All screens · Pantallas"]')`;
const ACCOUNT_MENU = `document.querySelector('[role="menu"][aria-label="Account · Cuenta"]')`;

// ── 1. The page can never be panned, and nothing sits off the glass ────────
// 44 for everything, 8/31. The pills used to be passed `min: 0` while the icon
// triggers were held to 44 — so this rig printed ALL CHECKS PASSED over a pill
// row that measured 48x30. A floor that is only applied to the controls
// somebody remembered is not a floor. Width is deliberately part of it too:
// 44x44 is the whole target, and a pill tall enough but 30 px wide is still a
// miss waiting to happen.
for (const width of WIDTHS) {
  console.log(`\n== founder header at ${width} px ==`);
  await open(FOUNDER, width);
  const geo = await evaluate(`({
    layout: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    headerHeight: +document.querySelector('header').getBoundingClientRect().height.toFixed(0),
    navRows: new Set([...document.querySelectorAll('header nav > a')]
      .map(a => Math.round(a.getBoundingClientRect().top))).size
  })`);
  check(
    geo.scrollWidth <= geo.layout,
    "the page cannot be panned sideways",
    `scrollWidth ${geo.scrollWidth} vs layout ${geo.layout}`
  );
  for (const [label, sel] of [
    ["Translate", pill("/translate")],
    ["Live", pill("/live")],
    ["Table", pill("/tabletop")],
    ["Chat", pill("/chat")],
    ["Call pill", CALL_PILL],
    ["Share", SHARE],
    ["All screens", GRID_CLOSED],
    ["Account", AVATAR_CLOSED]
  ]) {
    const c = await control(sel);
    if (!c) {
      check(false, `${label} exists`);
      continue;
    }
    check(c.offscreen === 0 && c.reaches, `${label} is on-screen and hit-testable at its centre`,
      `${c.w}x${c.h}${c.offscreen ? `, ${c.offscreen}px off-screen` : ""}`);
    check(c.w >= 44 && c.h >= 44, `${label} is at least 44x44`, `${c.w}x${c.h}`);
  }
  console.log(`  (header is ${geo.headerHeight}px tall, pills on ${geo.navRows} row(s))`);
}

// ── 2. A drifting thumb never slides the header out from under itself ─────
// Note what is and is not being asserted. Past Chrome's touch slop (~8-20 px)
// a drag stops being a tap and no click fires — that is true of every button
// on every website and is not something a header can fix. What WAS broken is
// the line below it: the drag used to SCROLL THE PAGE, so the row moved, and
// the next touch had to be re-aimed at a target that was no longer where the
// user last saw it. Before the fix, 20 px of drift scrolled the page 7 px and
// 40 px scrolled it 31 px. Nothing to pan now, so scrollX must stay 0 at any
// drift, and a normal tap (0-12 px) still opens the launcher.
console.log(`\n== a drifting thumb never slides the header (390 px) ==`);
for (const drift of [0, 12, 20, 40]) {
  await open(FOUNDER, 390);
  const g = await control(GRID);
  await tap(g.cx, g.cy, -drift);
  const opened = await evaluate(`!!${GRID_MENU}`);
  const scrolled = await evaluate(`window.scrollX`);
  check(scrolled === 0, `${String(drift).padStart(2)}px of drift does not scroll the page`,
    `scrollX=${scrolled}, menu ${opened ? "opened" : "did not open"}`);
  if (drift <= 12) check(opened, `${String(drift).padStart(2)}px of drift still counts as a tap`);
}

// ── 3. ONE touch to any daily screen. No disclosure in the pill row. ──────
// The restructure's headline, and the thing the old header could not do:
// /chat and /tabletop were behind Together ▾ and cost two touches each.
//
// WHAT "LANDED" MEANS HERE. The probe page hands TranslatorShell a founder
// email as a PROP; it does not create a Supabase session. So the gated pages
// re-ask the question for real, find nobody signed in, and bounce home — a tap
// on Call leaves the probe and arrives at "/", not "/call". That is the page
// gate working, not the pill failing, and it is why the assertion below is
// "left the probe, and arrived at the screen OR at the bounce" rather than a
// flat path match. An ungated screen must land exactly.
const BOUNCES_WITHOUT_A_SESSION = ["/call", "/fast", "/tutor"];
console.log(`\n== one touch per pill (390 px) ==`);
for (const [label, href] of [
  ["Translate", "/translate"],
  ["Live", "/live"],
  ["Table", "/tabletop"],
  ["Chat", "/chat"],
  ["Call", "/call"]
]) {
  await open(FOUNDER, 390);
  const c = await control(pill(href));
  if (!c) {
    check(false, `${label} pill exists`);
    continue;
  }
  await tap(c.cx, c.cy);
  await sleep(700);
  const path = await evaluate(`location.pathname`);
  const arrived = path === href || (BOUNCES_WITHOUT_A_SESSION.includes(href) && path === "/");
  check(arrived && path !== "/menu-probe", `${label} in ONE touch`, `landed on ${path}`);
}
await open(FOUNDER, 390);
check(
  !(await evaluate(`!!document.querySelector('header nav [aria-haspopup]')`)) &&
    !(await evaluate(`!!document.querySelector('header nav button')`)),
  "there is no dropdown anywhere in the pill row"
);

// ── 4. Two touches to anything in the launcher, and to anything in the
//      account menu. One to open, one to select. ────────────────────────────
const JOURNEYS = [
  ["launcher → Photo translator", FOUNDER, GRID, item("Photo"), "/vision"],
  ["launcher → Table", FOUNDER, GRID, item("Table"), "/tabletop"],
  ["launcher → Quick translate", FOUNDER, GRID, item("Quick translate"), "/fast"],
  ["launcher → Video captions", FOUNDER, GRID, item("Video captions"), "/video"],
  ["avatar → How to use", FOUNDER, AVATAR, item("How to use"), "/guide"],
  ["avatar → About", FOUNDER, AVATAR, item("About TAOS"), "/about"],
  ["launcher → Photo (customer)", CUSTOMER, GRID, item("Photo"), "/vision"],
  ["avatar → About (customer)", CUSTOMER, AVATAR, item("About TAOS"), "/about"]
];
console.log(`\n== two touches: one to open, one to select (390 px) ==`);
for (const [label, url, opener, menuItem, expected] of JOURNEYS) {
  await open(url, 390);
  let touches = 0;
  const o = await control(opener);
  await tap(o.cx, o.cy);
  touches += 1;
  const isOpen = await evaluate(`!!document.querySelector('[role="menu"]')`);
  const t = isOpen ? await control(menuItem) : null;
  if (!t) {
    check(false, label, isOpen ? "menu item missing" : `did not open on touch ${touches}`);
    continue;
  }
  check(t.offscreen === 0 && t.reaches && t.h >= 44 && t.w >= 44,
    `${label}: the item is on-screen and >=44x44`, `${t.w}x${t.h}`);
  await tap(t.cx, t.cy);
  touches += 1;
  await sleep(600);
  const path = await evaluate(`location.pathname`);
  const arrived =
    path === expected || (BOUNCES_WITHOUT_A_SESSION.includes(expected) && path === "/");
  check(touches === 2 && arrived && path !== "/menu-probe",
    `${label} in ${touches} touches`, `landed on ${path}`);
}

// ── 5. The launcher really is the whole catalog, and it respects the gates ─
console.log(`\n== the launcher holds every screen (390 px) ==`);
await open(FOUNDER, 390);
const fg = await control(GRID);
await tap(fg.cx, fg.cy);
const founderTiles = await evaluate(
  `[...${GRID_MENU}.querySelectorAll('[role="menuitem"]')].map(a => a.getAttribute('href'))`
);
check(
  ["/", "/translate", "/live", "/tabletop", "/chat", "/call", "/fast", "/vision", "/video"]
    .every((h) => founderTiles.includes(h)),
  "a founder's launcher holds every screen the founder gates open",
  founderTiles.join(" ")
);
check(founderTiles.includes("/"), "including the screen you are standing on");
// The current-page mark cannot be positively demonstrated from a probe route:
// /menu-probe is not one of the tiles, so nothing should be marked, and that
// is exactly what is asserted. tests/nav-tap-targets.test.ts pins that all ten
// tiles derive aria-current from usePathname(); this is the half a browser can
// see, which is that nothing claims to be current when nothing is.
check(
  !(await evaluate(`!!${GRID_MENU}.querySelector('[aria-current="page"]')`)),
  "and marks nothing as current while standing somewhere that is not a tile"
);
await open(CUSTOMER, 390);
const cg = await control(GRID);
await tap(cg.cx, cg.cy);
const customerTiles = await evaluate(
  `[...${GRID_MENU}.querySelectorAll('[role="menuitem"]')].map(a => a.getAttribute('href'))`
);
check(
  ["/call", "/fast", "/video"].every((h) => !customerTiles.includes(h)),
  "a stranger's launcher holds no FOUNDER-gated screen",
  customerTiles.join(" ")
);
check(
  ["/", "/translate", "/live", "/tabletop", "/chat", "/vision"].every((h) => customerTiles.includes(h)),
  "and every screen a stranger IS allowed"
);
// /tutor is gated differently from the other three and this rig has caught the
// difference more than once: tutorEnabled() is a plain flag with NO founder
// bypass (lib/release.ts), so it is on for EVERYONE or off for everyone. If a
// founder sees Tutor and a stranger does not, the tile has grown a founder
// check nobody asked for.
check(
  founderTiles.includes("/tutor") === customerTiles.includes("/tutor"),
  `Tutor is all-or-nothing, not founders-only (flag is ${founderTiles.includes("/tutor") ? "ON" : "off"} in this build)`
);

// ── 6. An OPEN launcher does not cover the pills ──────────────────────────
// The trap this header walked into the first time it was split into two rows:
// a dropdown anchored to its own trigger lands on whatever is beneath that
// trigger, and beneath the icon row is the pill row. A touch aimed at a pill
// then hits a menu item — not a dead tap, a WRONG one. The launcher is bigger
// than the old menu in both directions, so this matters more, not less.
console.log(`\n== an open launcher does not eat the pill row (390 px) ==`);
await open(FOUNDER, 390);
const og = await control(GRID);
await tap(og.cx, og.cy);
check(await evaluate(`!!${GRID_MENU}`), "launcher is open");
for (const [label, href] of [["Translate", "/translate"], ["Live", "/live"], ["Chat", "/chat"]]) {
  const c = await control(pill(href));
  check(c && c.reaches, `${label} is still the thing under its own centre`, c ? `${c.w}x${c.h}` : "missing");
}

// ── 7. Call is ONE touch for a founder, and absent everywhere for a stranger ─
console.log(`\n== Call ==`);
await open(CUSTOMER, 390);
check(!(await evaluate(`!!${CALL_PILL}`)), "a stranger sees no Call pill");
const sg = await control(GRID);
await tap(sg.cx, sg.cy);
check(
  !(await evaluate(`!!${item("Call")}`)) &&
    !(await evaluate(`!!document.querySelector('[href="/call"]')`)),
  "and no Call tile in the launcher either"
);

// ── 8. An outside touch still closes, and does not eat the touch under it ─
console.log(`\n== outside touch, and swapping menus ==`);
await open(FOUNDER, 390);
const g = await control(GRID);
await tap(g.cx, g.cy);
check(await evaluate(`!!${GRID_MENU}`), "launcher opens");
await tap(200, 780); // somewhere in the page body
check(!(await evaluate(`!!${GRID_MENU}`)), "an outside touch closes it");
await open(FOUNDER, 390);
const g2 = await control(GRID);
await tap(g2.cx, g2.cy);
const a2 = await control(AVATAR);
await tap(a2.cx, a2.cy);
check(
  !(await evaluate(`!!${GRID_MENU}`)) && (await evaluate(`!!${ACCOUNT_MENU}`)),
  "one touch swaps from the launcher to the avatar — the close does not eat it"
);
const a3 = await control(AVATAR);
await tap(a3.cx, a3.cy);
const g3 = await control(GRID);
await tap(g3.cx, g3.cy);
check(
  !(await evaluate(`!!${ACCOUNT_MENU}`)) && (await evaluate(`!!${GRID_MENU}`)),
  "and one touch back the other way"
);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
ws.close();
chrome.kill();
process.exit(failures === 0 ? 0 : 1);
