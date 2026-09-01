// Where the captions actually LAND on a phone.
//
//   node tests/live-fire/call-captions-layout-check.mjs
//
// Needs google-chrome on PATH. Costs nothing and talks to no provider, so it
// is safe to re-run; it lives beside the live-fire rig rather than in tests/
// because it drives Chrome over CDP and `npm test` should not.
//
// ── The failure this exists for ────────────────────────────────────────────
// 2026-08-31, Tom and Liz, two phones: the relay preflight passed, the call
// connected, audio and video were good, and there were NO CAPTIONS. The
// production logs said the interpreter had run fine —
//
//   [taos-call-cost] room=AMOR mode=clone pair=en->es seconds=125 responses=7
//     speech_s=20.5 text_out_tok=96 tts_chars=244 usd=0.0251
//
// — seven responses, and 244 characters sent to ElevenLabs, which is reached
// only from `onTranslationDone`. The captions existed in React state. They
// were 591px down a 1055px column poured into a 659px phone, and the button
// that toggles them was at 811px. tests/call-captions.test.ts renders the
// same screen in jsdom and passes, because jsdom has no layout: a caption in
// the DOM and a caption on the screen are different claims, and only a real
// engine can tell them apart.
//
// So this measures. It renders the REAL CallShell (through the vitest dump
// below, so the markup is the component's own output rather than a copy),
// compiles the REAL Tailwind, and asks Chrome where things are at three phone
// sizes.
//   measured 2026-08-31 after the fix: nothing overflows at any size, and the
//   captions, both toggles and Hang up are above the fold on all three.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "taos-caption-layout-"));
const HTML = path.join(tmp, "callshell.html");
const CSS = path.join(tmp, "taos.css");

// The dump test and its config have to live inside the repo — a file in /tmp
// cannot resolve `vitest` or `@testing-library/react`. Both are removed on the
// way out, including on a throw.
const DUMP = path.join(process.cwd(), ".call-layout-dump.test.ts");
const DUMP_CONFIG = path.join(process.cwd(), ".call-layout-dump.config.mjs");
const cleanup = () => {
  for (const f of [DUMP, DUMP_CONFIG]) fs.rmSync(f, { force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
};
process.on("exit", cleanup);

// ── 1. The component's own markup, in a connected call with a caption up ──
// Written as a one-off vitest file so the render goes through the same mocks
// tests/call-captions.test.ts uses; anything else would be a second opinion
// about what CallShell renders.
const base = fs.readFileSync("tests/call-captions.test.ts", "utf8");
const marker = base.indexOf('describe("/call captions"');
if (marker < 0) throw new Error("tests/call-captions.test.ts changed shape — update this rig");
fs.writeFileSync(
  DUMP,
  base.slice(0, marker) +
    `describe("dump", () => {
  it("writes the rendered call screen to disk", async () => {
    render(createElement(CallShell));
    (HTMLMediaElement.prototype as unknown as { play: () => Promise<void> }).play = async () => {};
    await joinAndConnect();
    await act(async () => { callEvents?.onRemoteStream?.({ getVideoTracks: () => [{}] } as never); });
    await act(async () => { interpreterEvents?.onHearing?.(true); });
    await translate("Hola mi amor, ya llegué a la casa.", "Hi my love, I just got home.");
    const fsx = await import("node:fs");
    fsx.writeFileSync(${JSON.stringify(HTML)}, document.body.innerHTML);
    expect(true).toBe(true);
  });
});
`
);
// A config of its own, pointing at the temp file: the repo's vitest include
// is `tests/**/*.test.ts`, and a dump file living there would be picked up by
// `npm test` — this rig must stay invisible to CI.
fs.writeFileSync(
  DUMP_CONFIG,
  `import { defineConfig } from "vitest/config";
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  resolve: { alias: { "@": ${JSON.stringify(process.cwd())} } },
  test: { root: ${JSON.stringify(process.cwd())}, include: [${JSON.stringify(DUMP)}] }
});
`
);
const dumped = spawnSync("npx", ["vitest", "run", "--config", DUMP_CONFIG], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"]
});
if (!fs.existsSync(HTML)) {
  console.error(dumped.stdout, dumped.stderr);
  throw new Error("could not render CallShell");
}

// ── 2. The real stylesheet ──
const built = spawnSync(
  "npx",
  ["tailwindcss", "-c", "tailwind.config.ts", "-i", "app/globals.css", "-o", CSS],
  { encoding: "utf8" }
);
if (!fs.existsSync(CSS)) {
  console.error(built.stdout, built.stderr);
  throw new Error("could not compile Tailwind");
}

const sheet = fs.readFileSync(CSS, "utf8");
const markup = fs.readFileSync(HTML, "utf8");
const build = (css) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${css}</style><style>body{margin:0;background:#0c0a09}</style></head>
<body class="bg-stone-950">${markup}</body></html>`;

// Two pages. The second stands in for the app INSTALLED to a home screen,
// where env(safe-area-inset-*) stops being zero — 47px of notch and 34px of
// home indicator, which is ~81px of controls back off the bottom of the
// screen if the height math subtracts a guessed constant instead of letting
// border-box do it. Chrome cannot be told to report insets, so they are
// substituted into the stylesheet, which is the same thing the phone does.
const PAGES = {
  "/": build(sheet),
  "/pwa": build(
    sheet
      .replace(/env\(safe-area-inset-top\)/g, "47px")
      .replace(/env\(safe-area-inset-bottom\)/g, "34px")
  )
};

const site = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(PAGES[req.url] ?? PAGES["/"]);
}).listen(0);
await new Promise((r) => site.on("listening", r));
const SITE_URL = `http://localhost:${site.address().port}/`;

const PORT = 9371;
const chrome = spawn(
  "google-chrome",
  ["--headless=new", `--remote-debugging-port=${PORT}`, "--no-sandbox", "--disable-gpu", "about:blank"],
  { stdio: "ignore" }
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error("Chrome never came up");
}
const ws = new WebSocket(await targets());
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error("cdp open failed"));
});
let id = 0;
const pending = new Map();
ws.onmessage = ({ data }) => {
  const m = JSON.parse(String(data));
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) =>
  new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 900));
  return r.result?.result?.value;
}
await send("Runtime.enable");
await send("Page.enable");

// Visible viewport heights, not device heights: Safari's address bar and
// toolbar are the reason a 844pt iPhone shows 659px of page.
const PHONES = [
  ["iPhone SE", 375, 553, "/"],
  ["iPhone 13/14", 390, 659, "/"],
  ["iPhone 15 Pro Max", 430, 745, "/"],
  ["iPhone 13/14, installed PWA", 390, 659, "/pwa"],
  ["iPhone 15 Pro Max, installed PWA", 430, 745, "/pwa"]
];

let ok = true;
for (const [name, width, height, path] of PHONES) {
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 3, mobile: true });
  await send("Page.navigate", { url: SITE_URL.replace(/\/$/, "") + path });
  await sleep(500);
  const m = await evaluate(`(() => {
    const fold = window.innerHeight;
    const btn = (t) => [...document.querySelectorAll('button')].find(b => b.textContent.includes(t));
    const caption = [...document.querySelectorAll('div')].find(e => e.textContent.trim() === "Hi my love, I just got home.");
    const status = [...document.querySelectorAll('span')].filter(e => e.textContent.includes('rprete')).pop();
    const box = (el) => el ? { top: Math.round(el.getBoundingClientRect().top), bottom: Math.round(el.getBoundingClientRect().bottom) } : null;
    return {
      fold,
      docHeight: document.documentElement.scrollHeight,
      caption: box(caption),
      status: box(status),
      captionsToggle: box(btn('Captions on') || btn('Captions off')),
      voiceToggle: box(btn('Voice on') || btn('Voice off')),
      hangUp: box(btn('Hang up'))
    };
  })()`);

  const visible = (r) => Boolean(r) && r.bottom <= m.fold && r.top >= 0;
  const checks = {
    "page does not overflow": m.docHeight <= m.fold,
    "caption text visible": visible(m.caption),
    "interpreter status visible": visible(m.status),
    "captions toggle visible": visible(m.captionsToggle),
    "voice toggle visible": visible(m.voiceToggle),
    "hang up visible": visible(m.hangUp)
  };
  console.log(`\n── ${name} (${width}×${height}) — page ${m.docHeight}px, fold ${m.fold}px`);
  for (const [label, pass] of Object.entries(checks)) {
    console.log(`   ${pass ? "✓" : "✗"} ${label}`);
    if (!pass) ok = false;
  }
}

console.log("\n" + (ok ? "PASS" : "FAIL"));
ws.close();
chrome.kill();
site.close();
process.exit(ok ? 0 : 1);
