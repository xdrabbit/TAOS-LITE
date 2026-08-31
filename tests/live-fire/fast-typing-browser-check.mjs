// The two /fast clocks, measured on the real component in a real browser.
//
//   npm run dev            # port 3017
//   node tests/live-fire/fast-typing-browser-check.mjs
//
// Needs google-chrome on PATH. Talks to no provider — POST /api/fast is
// fulfilled by the driver — so it costs nothing and is safe to re-run. It
// lives beside the live-fire rig rather than in tests/ because it drives
// Chrome over CDP and `npm test` should not.
//
// What only a browser can answer: FastShell's two timers are the whole design
// of the screen (lib/fast/settle.ts), and neither is visible to a unit test.
//
//   DEBOUNCE (300ms) — how often typing turns into a provider call. This is
//                      the cost of the screen working.
//   SETTLE (1500ms)  — how often typing turns into a taos_lite_translations
//                      row, which IS the free monthly allowance
//                      (lib/supabase.ts, getMonthlyUsage). This is the cost
//                      to the person using it.
//
// Measured 2026-08-30, 21 characters typed in two bursts around a 700ms think:
//   POST /api/fast .............. 2
//   taos_lite_translations POST . 1     <- one settled thought, one bill
//   a call (and a bill) per keystroke would have been 21 of each.
//
// ── The trap in writing this check ─────────────────────────────────────────
// Count POSTs, not requests. supabase-js sends a CORS preflight OPTIONS to the
// same URL as the insert, so counting `Network.requestWillBeSent` by URL
// reports one billed row as two — which is exactly what the first run of this
// script did, and it looked like a double-billing bug in the shell.
//
// This renders FastShell from a temporary page so the founder gate is out of
// the way: the gate is proved in tests/fast-gating.test.ts against the route,
// which is where it is load-bearing. Create app/fast-probe/page.tsx as:
//
//   "use client";
//   import { FastShell } from "@/components/FastShell";
//   export default function Probe() { return <FastShell />; }
//
// and delete it afterwards — tests/nav-completeness.test.ts will fail on an
// unclassified route if it is left behind, which is the fence working.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9334;
const APP = "http://localhost:3017/fast-probe";

const chrome = spawn(
  "google-chrome",
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    "--no-sandbox",
    "--disable-gpu",
    "--user-data-dir=/tmp/fast-probe-profile",
    "about:blank"
  ],
  { stdio: "ignore" }
);

async function firstPage() {
  for (let i = 0; i < 40; i += 1) {
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
const events = [];

function send(method, params = {}) {
  const n = (id += 1);
  ws.send(JSON.stringify({ id: n, method, params }));
  return new Promise((resolve) => pending.set(n, resolve));
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
  // Canned answer: what is measured here is the client's timing, not the
  // provider's. A real provider would only add noise to a timing measurement.
  if (msg.params.request.url.includes("/api/fast")) {
    const body = JSON.stringify({
      translation: "dónde está la farmacia",
      detectedSource: "en",
      targetLanguage: "es",
      engine: "azure",
      fallback: null
    });
    void send("Fetch.fulfillRequest", {
      requestId: msg.params.requestId,
      responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
      body: Buffer.from(body).toString("base64")
    });
  } else {
    void send("Fetch.continueRequest", { requestId: msg.params.requestId });
  }
};

await send("Network.enable");
await send("Page.enable");
await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });

/** POSTs only — see the preflight note in the header. */
const posts = (fragment) =>
  events.filter(
    (e) =>
      e.method === "Network.requestWillBeSent" &&
      e.params.request.method === "POST" &&
      e.params.request.url.includes(fragment)
  ).length;

await send("Page.navigate", { url: APP });
await sleep(4500);
await send("Runtime.evaluate", { expression: `document.querySelector('textarea').focus(); true` });

async function type(text, perChar = 45) {
  for (const ch of text) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", text: ch });
    await send("Input.dispatchKeyEvent", { type: "keyUp" });
    await sleep(perChar);
  }
}

// A burst, a think, a burst, then done — how anybody actually types a phrase.
await type("where is the ");
await sleep(700); // long enough to debounce and fetch, short of settling
const midway = { api: posts("/api/fast"), rows: posts("taos_lite_translations") };
await type("pharmacy");
await sleep(3500); // 300ms debounce + 1500ms settle, with room to spare
const settled = { api: posts("/api/fast"), rows: posts("taos_lite_translations") };

const shown = await send("Runtime.evaluate", {
  expression: `document.querySelector('section p')?.textContent ?? ''`,
  returnByValue: true
});

console.log("\n── FastShell, real browser ─────────────────────────");
console.log("  21 characters, two bursts around a 700ms think");
console.log(`  mid-think:  ${midway.api} POST /api/fast   ${midway.rows} billed rows`);
console.log(`  settled:    ${settled.api} POST /api/fast   ${settled.rows} billed rows`);
console.log(`  on screen:  ${JSON.stringify(shown.result.value)}`);
console.log("  per-keystroke would have been 21 of each.");

ws.close();
chrome.kill();
process.exit(settled.rows === 1 ? 0 : 1);
