// The /fast microphone, opened in a real browser under a real gesture policy.
//
//   node tests/live-fire/fast-mic-capture-browser-check.mjs
//
// Needs google-chrome on PATH. Starts its own Next dev server and its own
// throwaway probe page, talks to no provider, and costs nothing.
//
// ── Why this exists next to the unit tests ─────────────────────────────────
// tests/fast-mic-capture.test.ts drives lib/fast/micCapture.ts against a FAKE
// Web Audio. That proves the one thing that matters most — the AudioContext is
// built, resumed and handed getUserMedia synchronously inside the tap — but it
// proves it against a class this file wrote. A fake AudioContext will produce
// whatever samples the fake is told to produce, and "the rig did what the rig
// was told" is not the same claim as "a browser produced 16 kHz PCM".
//
// So this runs the SHIPPED module in Chrome, against Chrome's fake capture
// device, and asserts on the bytes that come out.
//
// ── What this canNOT prove, measured rather than assumed ───────────────────
// The first draft of this file tried to reproduce the BUG here as well, by
// running Chrome with --autoplay-policy=user-gesture-required and opening the
// mic from a timer instead of a click. It does not work, and the reason is
// worth writing down because it is the answer to "how did this ship":
//
//   Chrome reports a fresh AudioContext as "running" at birth, with or
//   without that flag, with or without microphone permission. It was
//   measured both ways. The flag gates media playback, not the capture
//   graph, and headless is permissive besides.
//
// So NO desktop engine reachable from here can see this failure. Chrome and
// Firefox have no gesture rule for the capture graph at all; Playwright's
// WebKit is a desktop build that does not enforce the phone's audio-session
// rules and, on this machine, will not launch without root-installed system
// libraries. That is precisely why every desktop walkthrough of the mic passed
// while the phone sat silent — the bug is invisible to the only engines CI
// has.
//
// What this file therefore proves is the POSITIVE half, which is the half that
// was never measured either: the shipped module, in a real browser, opened
// from a real click, produces real 16 kHz mono PCM and a real WAV. The
// negative half — a suspended graph delivering zero frames, and micVerdict
// calling it dead — is pinned deterministically in
// tests/fast-mic-capture.test.ts against a context that refuses to start, and
// both halves of that are mutation-checked. The last leg is Tom's phone, and
// docs/fast-engine.md carries the checklist for it.
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const APP_PORT = process.env.PORT ?? "3031";
const CDP_PORT = 9337;
const PROBE_DIR = new URL("../../app/fast-mic-probe/", import.meta.url);
const TYPES_DIR = new URL("../../.next/types/app/fast-mic-probe/", import.meta.url);
const APP = `http://localhost:${APP_PORT}/fast-mic-probe`;

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

// ── The probe page ─────────────────────────────────────────────────────────
// A button, because the point of the exercise is a REAL user gesture: CDP
// dispatches a genuine mouse event at it and the handler runs inside that
// event's task, exactly as FastShell's mic button does.
mkdirSync(PROBE_DIR, { recursive: true });
writeFileSync(
  new URL("page.tsx", PROBE_DIR),
  `"use client";
import { useCallback, useRef, useState } from "react";
import { openMicCapture, micVerdict } from "@/lib/fast/micCapture";

export default function MicProbe() {
  const capture = useRef<ReturnType<typeof openMicCapture> | null>(null);
  const [note, setNote] = useState("idle");
  const open = useCallback(() => {
    try {
      capture.current = openMicCapture({ onPcm: () => undefined, retain: true });
      setNote("opened");
    } catch (e) {
      setNote("threw: " + String(e));
    }
  }, []);
  (globalThis as Record<string, unknown>).__probe = {
    open,
    read: () => {
      const c = capture.current;
      if (!c) return null;
      const wav = c.toWav();
      return {
        frames: c.frames(),
        voicedMs: c.voicedMs(),
        wavBytes: wav ? wav.size : 0,
        wavType: wav ? wav.type : null,
        verdict: micVerdict({
          frames: c.frames(),
          voicedMs: c.voicedMs(),
          sinceStartMs: 9999,
          heard: false
        })
      };
    },
    close: () => capture.current?.close()
  };
  return (
    <button id="open" onClick={open} style={{ width: 300, height: 200, fontSize: 24 }}>
      {note}
    </button>
  );
}
`
);

const cleanup = () => {
  // The page AND the types the dev server generated for it. Next writes
  // .next/types/app/<route>/page.ts on compile and does not remove it when the
  // route goes, so a run that only deleted the page left `npm run typecheck`
  // failing on a module that no longer exists — a phantom red in a file nobody
  // had touched.
  for (const dir of [PROBE_DIR, TYPES_DIR]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  }
};

const dev = spawn(
  "node",
  ["node_modules/next/dist/bin/next", "dev", "--port", APP_PORT],
  // Detached, so shutdown can take the whole process GROUP down. `next dev`
  // forks a worker that survives killing the parent, and an orphan holding the
  // port makes the next run look like a failure it is not.
  { cwd: new URL("../../", import.meta.url).pathname, stdio: "ignore", detached: true }
);

const chrome = spawn(
  "google-chrome",
  [
    "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    "--no-sandbox",
    "--disable-gpu",
    // A microphone, granted without a prompt. The fake device is a tone
    // generator, so the graph carries genuine non-silent audio.
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    // THE flag this file is about. It makes Chrome apply the rule WebKit
    // applies by default, which is what turns the iPhone bug into something a
    // desktop engine can reproduce.
    "--autoplay-policy=user-gesture-required",
    "about:blank"
  ],
  { stdio: "ignore" }
);

const shutdown = () => {
  chrome.kill("SIGKILL");
  try {
    process.kill(-dev.pid, "SIGKILL");
  } catch {
    dev.kill("SIGKILL");
  }
  cleanup();
};
process.on("exit", shutdown);

async function cdp() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://localhost:${CDP_PORT}/json/list`);
      const [page] = (await res.json()).filter((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error("Chrome never came up");
}

async function serverReady() {
  let last = "no response";
  for (let i = 0; i < 90; i++) {
    try {
      const res = await fetch(APP);
      // The probe page is OURS. A stale server on this port would answer 404
      // here rather than faking a pass (see the note in CLAUDE.md's sibling
      // rigs: a port that stays bound after a kill is the classic false red).
      if (res.ok) return;
      last = `HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`;
    } catch (e) {
      last = String(e);
    }
    await sleep(1000);
  }
  throw new Error(`Nothing served ${APP} after 90s — ${last}`);
}

async function main() {
  await serverReady();
  const wsUrl = await cdp();
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => (ws.onopen = r));

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  const evaluate = async (expression) => {
    const res = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    return res.result?.result?.value;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: APP });
  await sleep(6000); // first compile

  // ── A. opened from a real click ─────────────────────────────────────────
  const box = await evaluate(
    `(() => { const b = document.getElementById("open"); const r = b.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`
  );
  const { x, y } = JSON.parse(box);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: "left",
      clickCount: 1,
      buttons: type === "mousePressed" ? 1 : 0
    });
  }
  await sleep(2500);
  const clicked = await evaluate(`JSON.stringify(globalThis.__probe.read())`);
  const gesture = JSON.parse(clicked ?? "null");

  check(
    "a mic opened inside a real click actually captures audio",
    !!gesture && gesture.frames > 0,
    `frames=${gesture?.frames}`
  );
  check(
    "and the watchdog is satisfied with it",
    gesture?.verdict === "streaming",
    `verdict=${gesture?.verdict}`
  );
  check(
    "Chrome's tone generator registers as voiced audio",
    (gesture?.voicedMs ?? 0) > 0,
    `voicedMs=${Math.round(gesture?.voicedMs ?? 0)}`
  );
  check(
    "the retained copy is a real WAV of that audio",
    gesture?.wavType === "audio/wav" && gesture.wavBytes > 44,
    `${gesture?.wavBytes} bytes`
  );
  // 16 kHz, 16-bit mono: every second of audio is 32000 bytes, whatever rate
  // the device actually ran at. This is the resampler, measured.
  const seconds = (gesture.wavBytes - 44) / (16000 * 2);
  check(
    "the PCM is 16 kHz mono — one second of audio is 32000 bytes",
    seconds > 0.5 && seconds < 4,
    `${seconds.toFixed(2)}s of PCM for ~2.5s of wall clock`
  );

  await evaluate(`globalThis.__probe.close()`);

  // ── B. what the engine says about the rule itself ───────────────────────
  // Reported, not asserted. This is the line that explains why desktop never
  // caught the bug, and if Chrome ever starts suspending these contexts it
  // will show up here as a changed reading rather than a mystery.
  await send("Page.navigate", { url: APP });
  await sleep(4000);
  const policy = await evaluate(
    `(async () => { const c = new AudioContext(); const born = c.state;
      try { await c.resume(); } catch {}
      const after = c.state; await c.close();
      return JSON.stringify({ born, after }); })()`
  );
  console.log("");
  console.log(`  note  this engine builds an AudioContext outside a gesture as ${policy}`);
  console.log("        — which is why the iPhone bug is invisible to it. See the header.");

  console.log("");
  if (failures.length) {
    console.log(`${failures.length} FAILED: ${failures.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("all checks passed");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(shutdown);
