// /live two-way Auto and "Save this conversation", on the REAL screen, in a
// real browser — against a scripted fake provider. No phone, nobody's
// account, no OpenAI, no database: it spends nothing and touches nothing.
//
//   node tests/live-fire/live-auto-browser-check.mjs
//   SHOTS=/some/dir node …      ← where the screenshots go (default: a tmp dir)
//
// Needs google-chrome on PATH.
//
// What is real: the Next dev server, the /live page and its shell, the WebRTC
// client (lib/live/ambient.ts), the tag reader, both echo fences, the
// /api/live/saved/* routes and their store code, and /live/saved.
// What is scripted:
//   · the provider — a fake RTCPeerConnection whose data channel this script
//     drives: two languages alternating, one detect MISS, one ECHO injection;
//   · the mint and /api/tts — answered in the page (a silent one-second WAV
//     stands in for the voice, so "while it plays" is a real second);
//   · Supabase — a tiny in-memory PostgREST on localhost, which is also how
//     "the migration has not been applied" is staged (TABLES=missing).
//
// What only this can answer (vitest has no layout and no audio element):
//   - is the Auto row there at 375 px, in English and Spanish, without making
//     the page pannable (#53)?
//   - does a line card show both halves, each under its language, in a real
//     layout — the screenshot the PR proposes?
//   - is the real mic track actually disabled while a real <audio> plays, and
//     back 300 ms after it ends?
//   - does the Save chip sit disabled with its hint when the tables are
//     missing, and write rows (text only) when they are not?

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const APP_DIR = process.env.APP_DIR?.trim() || process.cwd();
const APP_PORT = Number(process.env.APP_PORT ?? 3093);
const FAKE_PORT = Number(process.env.FAKE_PORT ?? 54411);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9361);
const SHOTS = resolve(process.env.SHOTS?.trim() || join(tmpdir(), "taos-live-auto-shots"));
const FOUNDER = "live-auto-probe@example.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(SHOTS, { recursive: true });

// ── a tiny PostgREST: just enough for lib/live/savedStore.ts ────────────────
const fakeUser = { id: "00000000-0000-4000-8000-000000000003", aud: "authenticated", role: "authenticated", email: FOUNDER };
const store = { missing: true, sessions: [], lines: [], requests: [] };
const SESSIONS = "taos_lite_live_sessions";
const LINES = "taos_lite_live_lines";
const fake = createServer((req, res) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "*",
    "Content-Type": "application/json"
  };
  if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname.startsWith("/auth/v1/user")) return res.writeHead(200, cors).end(JSON.stringify(fakeUser));
    const table = url.pathname.replace("/rest/v1/", "");
    if (table !== SESSIONS && table !== LINES) return res.writeHead(200, cors).end("[]");
    store.requests.push(`${req.method} ${table}`);
    if (store.missing) {
      return res
        .writeHead(404, cors)
        .end(JSON.stringify({ code: "PGRST205", message: `Could not find the table 'public.${table}' in the schema cache` }));
    }
    const eq = (key) => (url.searchParams.get(key) ?? "").replace(/^eq\./, "");
    const rows = table === SESSIONS ? store.sessions : store.lines;
    const match = (r) =>
      [...url.searchParams.keys()]
        .filter((k) => (url.searchParams.get(k) ?? "").startsWith("eq."))
        .every((k) => String(r[k]) === eq(k));
    if (req.method === "POST") {
      const body = JSON.parse(raw || "{}");
      for (const row of Array.isArray(body) ? body : [body]) {
        const dup =
          table === SESSIONS
            ? rows.some((r) => r.id === row.id)
            : rows.some((r) => r.session_id === row.session_id && r.seq === row.seq);
        if (!dup) rows.push({ created_at: new Date().toISOString(), ...row });
      }
      return res.writeHead(201, cors).end("");
    }
    if (req.method === "PATCH") {
      const hit = rows.filter(match);
      hit.forEach((r) => Object.assign(r, JSON.parse(raw || "{}")));
      return res.writeHead(200, cors).end(JSON.stringify(hit.map((r) => ({ id: r.id }))));
    }
    if (req.method === "DELETE") {
      const gone = rows.filter(match);
      store.sessions = store.sessions.filter((r) => !gone.includes(r));
      store.lines = store.lines.filter((l) => !gone.some((g) => g.id === l.session_id));
      return res.writeHead(200, cors).end(JSON.stringify(gone.map((r) => ({ id: r.id }))));
    }
    const found = rows
      .filter(match)
      .map((r) =>
        table === SESSIONS ? { ...r, [LINES]: [{ count: store.lines.filter((l) => l.session_id === r.id).length }] } : r
      )
      .sort((a, b) => (table === LINES ? a.seq - b.seq : 0));
    if ((req.headers.accept ?? "").includes("vnd.pgrst.object")) {
      return found[0]
        ? res.writeHead(200, cors).end(JSON.stringify(found[0]))
        : res.writeHead(406, cors).end(JSON.stringify({ code: "PGRST116", message: "0 rows" }));
    }
    res.writeHead(200, cors).end(JSON.stringify(found));
  });
}).listen(FAKE_PORT, "127.0.0.1");

// ── the app ─────────────────────────────────────────────────────────────────
const serverLog = [];
const app = spawn("node", ["node_modules/next/dist/bin/next", "dev", "--port", String(APP_PORT)], {
  cwd: APP_DIR,
  env: {
    ...process.env,
    OPENAI_API_KEY: "sk-not-used-the-mint-is-answered-in-the-page",
    NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${FAKE_PORT}`,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "fake-anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "fake-service-role-key",
    NEXT_PUBLIC_FOUNDER_EMAILS: FOUNDER,
    TAOS_LIVE_SAVE: "",
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
    for (const line of String(d).split("\n")) if (line.includes("[taos-live")) serverLog.push(line.trim());
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

const dir = mkdtempSync(join(tmpdir(), "taos-live-auto-"));
chrome = spawn("google-chrome", [
  "--headless=new",
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${join(dir, "profile")}`,
  "--no-sandbox",
  "--disable-gpu",
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
  "--window-size=375,812",
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
  new Promise((resolveCall) => {
    const id = ++seq;
    pending.set(id, resolveCall);
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
const shot = async (name) => {
  const r = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  const file = join(SHOTS, name);
  writeFileSync(file, Buffer.from(r.result.data, "base64"));
  return file;
};

await cdp("Page.enable");
await cdp("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });

// ── the scripted provider, installed before any page script ─────────────────
await cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `(() => {
    window.__sent = [];      // every client event, parsed
    window.__mints = [];     // every mint body
    window.__tts = [];       // every /api/tts body
    window.__pc = null;
    function silentWav(ms) {
      const rate = 8000, n = Math.round(rate * ms / 1000), buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
      const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
      w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVEfmt "); v.setUint32(16, 16, true);
      v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
      v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 2, true);
      return new Blob([buf], { type: "audio/wav" });
    }
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = String(typeof input === "string" ? input : input.url);
      if (url.includes("/api/live/realtime")) {
        window.__mints.push(JSON.parse(init.body));
        return Promise.resolve(new Response(JSON.stringify({ clientSecret: "ek_fake", callUrl: "https://fake.invalid/v1/realtime/calls", styles: {} }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      if (url.includes("/v1/realtime/calls")) return Promise.resolve(new Response("v=0\\r\\n", { status: 200 }));
      if (url.includes("/api/tts")) {
        window.__tts.push(JSON.parse(init.body));
        return Promise.resolve(new Response(silentWav(1000), { status: 200, headers: { "Content-Type": "audio/wav" } }));
      }
      return origFetch.apply(this, arguments);
    };
    class FakeDC extends EventTarget {
      constructor() { super(); this.readyState = "open"; this.onmessage = null; this.onerror = null; this.onopen = null; }
      send(data) { window.__sent.push(JSON.parse(data)); }
      close() { this.readyState = "closed"; }
      emit(ev) { if (this.readyState === "open" && this.onmessage) this.onmessage({ data: JSON.stringify(ev) }); }
    }
    class FakePC extends EventTarget {
      constructor() { super(); this.connectionState = "new"; this.onconnectionstatechange = null; this.ontrack = null; this.track = null; this.dc = null; window.__pc = this; }
      addTrack(track) { this.track = track; }
      getSenders() { return []; }
      createDataChannel() { this.dc = new FakeDC(); return this.dc; }
      async createOffer() { return { type: "offer", sdp: "v=0\\r\\n" }; }
      async setLocalDescription() {}
      async setRemoteDescription() {
        this.connectionState = "connected";
        setTimeout(() => { if (this.onconnectionstatechange) this.onconnectionstatechange(); }, 0);
      }
      close() { this.connectionState = "closed"; }
    }
    window.RTCPeerConnection = FakePC;
    // The script's two verbs. hear(): VAD committed a segment and the
    // transcriber read it. answer(): the model's TEXT, streamed in pieces.
    let n = 0;
    window.__hear = (transcript) => {
      const id = "item_" + (++n), dc = window.__pc.dc;
      dc.emit({ type: "input_audio_buffer.speech_started" });
      dc.emit({ type: "input_audio_buffer.speech_stopped" });
      dc.emit({ type: "input_audio_buffer.committed", item_id: id });
      dc.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript });
      return id;
    };
    window.__answer = (deltas) => {
      const dc = window.__pc.dc;
      for (const delta of deltas) dc.emit({ type: "response.output_text.delta", delta });
      dc.emit({ type: "response.output_text.done", text: deltas.join("") });
      dc.emit({ type: "response.done", response: { status: "completed" } });
    };
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

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok });
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  — ${detail}` : ""}`);
};
const click = (selector) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
const clickText = (re) => evaluate(`(() => { const el = Array.from(document.querySelectorAll("button")).find((b) => ${re}.test(b.textContent)); if (!el) return false; el.click(); return true; })()`);
const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
const overflow = () => evaluate(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
const responseCreates = () => evaluate(`window.__sent.filter((e) => e.type === "response.create").length`);
const micEnabled = () => evaluate(`window.__pc.track.enabled`);
const cards = () =>
  evaluate(`Array.from(document.querySelectorAll("[data-live-line]")).map((card) => ({
    detect: card.getAttribute("data-detect"),
    heard: [card.querySelector("[data-live-heard] span")?.textContent ?? "", card.querySelector("[data-live-heard] p")?.textContent ?? ""],
    rendered: [card.querySelector("[data-live-rendered] span")?.textContent ?? "", card.querySelector("[data-live-rendered] p")?.textContent ?? ""]
  }))`);
async function openLive(pair) {
  await evaluate(`localStorage.setItem("taos.translate.languages", ${JSON.stringify(JSON.stringify(pair))}); true`);
  await cdp("Page.navigate", { url: `${APP}/live` });
  return waitFor(`!!document.querySelector("[data-live-auto-chip]")`, 180_000);
}
async function exchange(heard, deltas) {
  const before = await responseCreates();
  await evaluate(`window.__hear(${JSON.stringify(heard)}); true`);
  await waitFor(`window.__sent.filter((e) => e.type === "response.create").length > ${before}`, 3000);
  await evaluate(`window.__answer(${JSON.stringify(deltas)}); true`);
  await sleep(250);
}

// ── 1. before the migration: the default screen, and the Save chip's hint ───
console.log("\n── 1. default screen, tables missing ──");
store.missing = true;
if (!(await openLive(["en", "es"]))) {
  console.log("FAILED — /live never rendered");
  process.exit(1);
}
await waitFor(`!!document.querySelector("[data-live-save-chip]")`, 15_000);
check("Auto chip is there and OFF", (await evaluate(`document.querySelector("[data-live-auto-chip]").getAttribute("aria-pressed")`)) === "false");
check("style row untouched: Summary on, both chips enabled",
  (await evaluate(`Array.from(document.querySelectorAll("[data-live-style] button")).map((b) => b.getAttribute("aria-pressed") + ":" + b.disabled).join(",")`)) === "true:false,false:false");
check("Save chip shown DISABLED with a hint while the tables are missing",
  (await evaluate(`document.querySelector("[data-live-save-chip]")?.disabled === true`)) && /set up/.test((await text("[data-live-save-hint]")) ?? ""),
  (await text("[data-live-save-hint]")) ?? "no hint");
check("no page error from the missing tables", !(await evaluate(`/error|failed/i.test(document.querySelector("[role=status]")?.textContent ?? "")`)));
check("375 px: page is not pannable (EN)", (await overflow()) <= 0, `overflow ${await overflow()} px`);
await shot("live-auto-1-default-tables-missing.png");

// ── 2. tables there: Auto on, two people alternating, a miss ────────────────
console.log("\n── 2. Auto on: two languages alternating, one miss ──");
store.missing = false;
// The store remembers a "no" for 30 s per instance (lib/live/savedStore.ts).
await sleep(31_000);
await openLive(["en", "es"]);
await waitFor(`document.querySelector("[data-live-save-chip]")?.disabled === false`, 15_000);
check("Save chip enabled and OFF once the tables exist",
  (await evaluate(`(() => { const b = document.querySelector("[data-live-save-chip]"); return !!b && !b.disabled && b.getAttribute("aria-pressed") === "false"; })()`)));
await click("[data-live-auto-chip]");
await sleep(200);
check("Auto on: Summary disabled, Word for word shown on, and the screen says why",
  (await evaluate(`Array.from(document.querySelectorAll("[data-live-style] button")).map((b) => b.getAttribute("aria-pressed") + ":" + b.disabled).join(",")`)) === "false:true,true:true" &&
    /word for word only/.test(await evaluate(`document.querySelector("[data-live-style]").textContent`)));
check("Auto on: voice shows OFF", /Voice off/.test(await evaluate(`document.body.innerText`)));
check("375 px: page is not pannable with the Auto hints showing (EN)", (await overflow()) <= 0, `overflow ${await overflow()} px`);
await click("[data-live-controls] button");
await waitFor(`!!window.__pc && !!window.__pc.dc && /live ·/.test(document.body.innerText)`, 20_000);
check("the mint asked for an Auto session", JSON.stringify(await evaluate(`window.__mints`)) === JSON.stringify([{ target: "en", source: "es", style: "verbatim", auto: true }]),
  JSON.stringify(await evaluate(`window.__mints`)));

await exchange("Oye, ¿al final vamos a la playa el sábado o lo dejamos para el domingo?", ["[e", "n] Hey, in the end are we going to the beach", " on Saturday or are we leaving it for Sunday?"]);
check("nothing saved while the toggle is off", store.lines.length === 0 && store.sessions.length === 0);
await click("[data-live-save-chip]");
await exchange("Saturday is going to be really crowded, and they said it's going to rain in the afternoon.", ["[es]", " El sábado va a estar muy concurrido", " y dijeron que va a llover por la tarde."]);
await exchange("Entonces el domingo. Salimos a las ocho.", ["[en] So, Sunday. We leave at eight."]);
// The miss: the model forgot its tag.
await exchange("No se te olvide el protector solar.", ["Don't forget", " the sunscreen."]);
await sleep(600);

let feed = await cards();
check("four cards, newest first, each half under its language",
  feed.length === 4 &&
    feed[3].heard[0] === "Español" && feed[3].rendered[0] === "English" &&
    feed[2].heard[0] === "English" && feed[2].rendered[0] === "Español" &&
    feed[1].heard[0] === "Español" && feed[1].rendered[0] === "English",
  feed.map((c) => `${c.heard[0]}→${c.rendered[0]}`).join(" | "));
check("the miss keeps its words, names no language, and is counted",
  feed[0].detect === "miss" && feed[0].heard[0] === "?" && /not detected/.test(feed[0].rendered[0]) && feed[0].rendered[1] === "Don't forget the sunscreen." &&
    /Language not detected: 1/.test((await text("[data-live-auto-counts]")) ?? ""),
  (await text("[data-live-auto-counts]")) ?? "no counter");
check("no tag ever reached the screen", !(await evaluate(`/\\[e(n|s)?\\]?\\s/.test(document.querySelector("ol").innerText) || /\\[(en|es)\\]/.test(document.body.innerText)`)));
check("one response asked per heard segment, each by reference",
  (await evaluate(`window.__sent.filter((e) => e.type === "response.create").every((e) => e.response?.input?.[0]?.type === "item_reference")`)) && (await responseCreates()) === 4);
check("voice off: /api/tts never called, mic never touched", (await evaluate(`window.__tts.length`)) === 0 && (await micEnabled()) === true);
check("375 px: page is not pannable with a feed of line cards", (await overflow()) <= 0, `overflow ${await overflow()} px`);
await shot("live-auto-2-feed.png");
// The same feed as a phone shows it: one viewport, scrolled to the cards.
await evaluate(`(() => { const ol = document.querySelector("ol"); window.scrollTo(0, ol.getBoundingClientRect().top + window.scrollY - 12); return true; })()`);
await sleep(300);
writeFileSync(join(SHOTS, "live-auto-2-feed-viewport.png"), Buffer.from((await cdp("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
await evaluate(`window.scrollTo(0, 0); true`);

// ── 3. voice on: the mic is shut while it speaks; the echo is dropped ───────
console.log("\n── 3. voice on: half-duplex, then the echo injection ──");
await clickText("/Voice off/");
await sleep(150);
const heardBefore = await responseCreates();
await evaluate(`window.__hear("¿Tú sabes cuánto cuesta el estacionamiento allá?"); true`);
await waitFor(`window.__sent.filter((e) => e.type === "response.create").length > ${heardBefore}`, 3000);
await evaluate(`window.__answer(["[en] Do you know how much the parking costs over there?"]); true`);
const sawPlaying = await waitFor(`window.__pc.track.enabled === false`, 5000);
check("while the readout plays, the real mic track is disabled", sawPlaying);
check("it was read through /api/tts in the direction the tag gave",
  JSON.stringify(await evaluate(`window.__tts`)) === JSON.stringify([{ text: "Do you know how much the parking costs over there?", latency: "flash", sourceLanguage: "es", targetLanguage: "en" }]),
  JSON.stringify(await evaluate(`window.__tts`)));
const reopened = await waitFor(`window.__pc.track.enabled === true`, 5000);
check("the mic comes back after the readout and its tail", reopened);

// THE ECHO INJECTION: the provider reports hearing this phone's own sentence.
const askedBeforeEcho = await responseCreates();
const cardsBeforeEcho = (await cards()).length;
await evaluate(`window.__hear("Do you know how much the parking costs over there"); true`);
await sleep(800);
check("echo: no response is asked for the phone's own voice", (await responseCreates()) === askedBeforeEcho);
check("echo: no card, and the screen counts it",
  (await cards()).length === cardsBeforeEcho && /Own voice ignored: 1/.test((await text("[data-live-auto-counts]")) ?? ""),
  (await text("[data-live-auto-counts]")) ?? "no counter");
// …and the real answer is still heard.
await evaluate(`window.__hear("I think it was twelve dollars, but I'm not sure."); true`);
await waitFor(`window.__sent.filter((e) => e.type === "response.create").length > ${askedBeforeEcho}`, 3000);
check("the reply that follows the echo IS asked for", (await responseCreates()) === askedBeforeEcho + 1);
await evaluate(`window.__answer(["[es] Creo que eran doce dólares, pero no estoy seguro."]); true`);
await waitFor(`window.__pc.track.enabled === false`, 5000);
await waitFor(`window.__pc.track.enabled === true`, 5000);
await sleep(300);
await shot("live-auto-3-voice-echo.png");

// ── 4. what was saved ───────────────────────────────────────────────────────
console.log("\n── 4. what reached the database (the fake one) ──");
await waitFor(`true`, 100);
await sleep(800);
check("one session row, created with the first SAVED line", store.sessions.length === 1 && store.sessions[0].user_id === fakeUser.id && store.sessions[0].auto === true,
  JSON.stringify(store.sessions.map((s) => ({ auto: s.auto, style: s.style, pair: `${s.lang_mine}/${s.lang_theirs}` }))));
check("only lines produced while Save was ON, in order (the first exchange is absent)",
  store.lines.map((l) => l.seq).join(",") === "1,2,3,4,5" && !store.lines.some((l) => /playa/.test(l.heard_text)),
  `seqs ${store.lines.map((l) => l.seq).join(",")}`);
check("each row is text + languages + hit/miss; the miss has no language",
  store.lines[0].heard_lang === "en" && store.lines[0].translation_lang === "es" && store.lines[0].detect === "hit" &&
    store.lines[2].detect === "miss" && store.lines[2].heard_lang === null && store.lines[2].translation_lang === null);
check("no column anywhere carries audio",
  store.lines.every((l) => Object.keys(l).every((k) => ["created_at", "session_id", "user_id", "seq", "heard_text", "heard_lang", "translation", "translation_lang", "detect"].includes(k))));
check("the server logged ids and counts, never the words",
  serverLog.some((l) => /\[taos-live-save\] line session=[0-9a-f-]{36} seq=1 heard_chars=\d+ text_chars=\d+ detect=hit auto=1/.test(l)) &&
    !serverLog.some((l) => /sábado|Saturday|parking|estacionamiento|sunscreen|dólares/i.test(l)));

// ── 5. /live/saved: list, read, export, delete ──────────────────────────────
console.log("\n── 5. /live/saved ──");
await click("[data-live-controls] button"); // STOP
await sleep(300);
await cdp("Page.navigate", { url: `${APP}/live/saved` });
const listed = await waitFor(`!!document.querySelector("[data-saved-list] button")`, 180_000);
check("the list shows the conversation with its line count", listed && /5 lines/.test((await text("[data-saved-list]")) ?? ""), (await text("[data-saved-list]")) ?? "");
await shot("live-saved-1-list.png");
await click("[data-saved-list] button");
await waitFor(`document.querySelectorAll("[data-saved-line]").length === 5`, 10_000);
check("opening it shows every line in order", (await evaluate(`document.querySelectorAll("[data-saved-line]").length`)) === 5 &&
  /concurrido/.test(await evaluate(`document.querySelector("[data-saved-line]").textContent`)));
check("375 px: the saved page is not pannable", (await overflow()) <= 0, `overflow ${await overflow()} px`);
await shot("live-saved-2-read.png");
const exported = await evaluate(`(async () => {
  const token = JSON.parse(localStorage.getItem("sb-127-auth-token")).access_token;
  const id = ${JSON.stringify(store.sessions[0]?.id ?? "")};
  const res = await fetch("/api/live/saved/" + id + "?format=text", { headers: { Authorization: "Bearer " + token } });
  return { status: res.status, type: res.headers.get("Content-Type"), disposition: res.headers.get("Content-Disposition"), body: await res.text() };
})()`);
check("export is a .txt with both halves of every line, labelled",
  exported.status === 200 && /text\/plain/.test(exported.type) && /attachment; filename="taos-live-.*\.txt"/.test(exported.disposition) &&
    /\[English\] Saturday is going to be really crowded/.test(exported.body) && /\[Español\] El sábado va a estar muy concurrido/.test(exported.body) &&
    /3\. \(language not detected\)\n\[\?\?\]/.test(exported.body));
await evaluate(`window.confirm = () => true; true`);
await clickText("/^Delete$/");
await waitFor(`!document.querySelector("[data-saved-open]")`, 10_000);
await sleep(300);
check("delete removes the session AND its lines, and the list is empty", store.sessions.length === 0 && store.lines.length === 0 && /Nothing saved yet/.test(await evaluate(`document.body.innerText`)));

// ── 6. the same row in Spanish, at 375 ──────────────────────────────────────
console.log("\n── 6. the owner reads Spanish ──");
await openLive(["es", "en"]);
await sleep(500);
check("the Auto and Save chips are in Spanish for a Spanish owner",
  /Detección automática/.test((await text("[data-live-auto-chip]")) ?? "") && /Guardar esta conversación/.test((await text("[data-live-save-chip]")) ?? ""),
  `${await text("[data-live-auto-chip]")} / ${await text("[data-live-save-chip]")}`);
check("375 px: page is not pannable (ES, the wider labels)", (await overflow()) <= 0, `overflow ${await overflow()} px`);
await shot("live-auto-4-spanish.png");

console.log("\n── server log (ids and counts only) ──");
for (const line of serverLog.slice(0, 12)) console.log(`  ${line}`);
console.log(`\nscreenshots in ${SHOTS}`);

ws.close();
const failed = checks.filter((c) => !c.ok);
console.log(`\n${failed.length === 0 ? `ALL PASSED (${checks.length} checks)` : `FAILED: ${failed.length} of ${checks.length}`}`);
process.exit(failed.length === 0 ? 0 : 1);
