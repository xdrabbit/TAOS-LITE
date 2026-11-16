// A long home turn on the REAL home screen, in a real browser, with a fake mic.
//
//   node tests/live-fire/home-long-turn-browser-check.mjs
//   TIER=free node tests/live-fire/home-long-turn-browser-check.mjs
//
// Needs google-chrome on PATH. Starts its own Next dev server and its own
// throwaway probe page; /api/translate, /api/tts and Supabase are answered
// by the page itself, so it talks to no provider and costs nothing.
//
// ── Why this exists next to the unit tests ─────────────────────────────────
// tests/home-long-turn.test.ts pins the recorder against a fake
// MediaRecorder, the route against mocked providers, and the screen by
// reading its source. None of that is the screen RUNNING: a real
// MediaRecorder rolling on a real stream, the one-second check actually
// firing, the cap actually stopping a turn nobody stopped, and the final
// request actually carrying what the earlier chunks said. This mounts the
// shipped components/TranslatorShell.tsx and lets it do all of that:
//
//   * cap 17 s (the `maxTurnMs` prop — what TAOS_HOME_MAX_TURN_MS feeds),
//     chunks of 5 s and the 2nd chunk forced to fail (the founder knobs,
//     /?chunk=5&failchunk=2);
//   * the page taps the record button once and never taps it again.
//
// Expected, and asserted: parts 0 and 2 go up WHILE the turn is still
// recording, part 1 never does, the turn stops itself at the cap, and one
// final request carries [text, lost, text] plus the last chunk's audio and
// the whole turn's rec_ms.
//
// ── TIER=free: the cap is tiered ───────────────────────────────────────────
// The ten-minute turn is a paid benefit (Tom and Liz, 2026-11-15). The same
// screen is mounted with the same two caps — paid 17 s, free 8 s — but for a
// FREE profile on an address that is not a founder's. Expected, and
// asserted: the turn stops itself at 8 s, not 17; the wrap-up line appears a
// third of the free cap before it; and, the founder knobs being nobody
// else's, the turn is ONE ordinary request with no chunk fields at all.
// The default (paid) run asserts the other side: 17 s, wrap-up before THAT.
//
// ── What it cannot say ─────────────────────────────────────────────────────
// Desktop Chrome. Android Chrome is the same engine; iOS Safari is not.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const APP_PORT = process.env.PORT ?? "3053";
const FREE = process.env.TIER === "free";
const PAID_CAP_MS = 17000;
const FREE_CAP_MS = 8000;
const CAP_MS = FREE ? FREE_CAP_MS : PAID_CAP_MS;
// lib/translate/recorder.ts: a cap under 90 s glows from a third of it out.
const WRAP_AT_MS = CAP_MS - Math.round(CAP_MS / 3);
const CHUNK_S = 5;
const FOUNDER = "long-turn-probe@example.com";
const ROOT = new URL("../../", import.meta.url);
const PROBE_DIR = new URL("app/long-turn-probe/", ROOT);
const API_DIR = new URL("app/api/long-turn-probe/", ROOT);
const TYPES = [new URL(".next/types/app/long-turn-probe/", ROOT), new URL(".next/types/app/api/long-turn-probe/", ROOT)];
const APP = `http://localhost:${APP_PORT}/long-turn-probe?chunk=${CHUNK_S}&failchunk=2`;
const work = mkdtempSync(join(tmpdir(), "taos-long-turn-ui-"));
const reportPath = join(work, "report.json");

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

mkdirSync(PROBE_DIR, { recursive: true });
mkdirSync(API_DIR, { recursive: true });
writeFileSync(
  new URL("route.ts", API_DIR),
  `import { writeFileSync } from "node:fs";
export const runtime = "nodejs";
export async function POST(req: Request): Promise<Response> {
  writeFileSync(${JSON.stringify(reportPath)}, await req.text());
  return new Response(null, { status: 204 });
}
`
);
writeFileSync(
  new URL("page.tsx", PROBE_DIR),
  `"use client";
import { useEffect } from "react";
import { TranslatorShell } from "@/components/TranslatorShell";
import type { Profile } from "@/lib/supabase";

const calls: Array<Record<string, unknown>> = [];
let tappedAt = 0;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Installed at module load, before the shell mounts: the providers are this page.
if (typeof window !== "undefined") {
  const real = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/api/translate")) {
      const fields: Record<string, unknown> = {};
      (init?.body as FormData).forEach((v, k) => {
        fields[k] = v instanceof Blob ? { bytes: v.size, type: v.type } : String(v);
      });
      const recording = document.querySelector("button.h-20")?.textContent ?? "";
      calls.push({ sinceTapMs: Math.round(performance.now() - tappedAt), button: recording, fields });
      if (fields.chunk_part === "1") return json({ chunk: { index: Number(fields.chunk_index), text: "words of chunk " + fields.chunk_index } });
      setTimeout(() => {
        void real("/api/long-turn-probe", {
          method: "POST",
          body: JSON.stringify({ calls, wrapAtMs, heard: document.body.innerText.includes("stitched transcript") })
        });
      }, 500);
      return json({ original: "the stitched transcript", translation: "la traducción", sourceLanguage: "en", targetLanguage: "es" });
    }
    if (url.includes("/api/tts") || url.includes("supabase.co")) return json({ error: "probe" }, 401);
    return real(input, init);
  };
}

const EMAIL = ${JSON.stringify(FREE ? "free-probe@example.com" : FOUNDER)};
const profile = ${
    FREE
      ? '{ id: "probe", email: EMAIL, plan: "free", subscription_status: "free", tier: null }'
      : '{ id: "probe", email: EMAIL, plan: "comp", subscription_status: "comp", tier: null }'
  } as unknown as Profile;
let wrapAtMs: number | null = null;

export default function LongTurnProbe() {
  useEffect(() => {
    // One tap on the record button, and never another: the cap must stop it.
    const t = setTimeout(() => {
      tappedAt = performance.now();
      (document.querySelector("button.h-20") as HTMLButtonElement | null)?.click();
    }, 1500);
    // When the wrap-up line first shows, measured from the tap.
    const w = setInterval(() => {
      if (wrapAtMs === null && tappedAt && document.body.innerText.includes("Wrapping up")) {
        wrapAtMs = Math.round(performance.now() - tappedAt);
      }
    }, 50);
    return () => {
      clearTimeout(t);
      clearInterval(w);
    };
  }, []);
  return (
    <TranslatorShell
      email={EMAIL}
      profile={profile}
      onSignOut={() => {}}
      maxTurnMs={${PAID_CAP_MS}}
      maxTurnFreeMs={${FREE_CAP_MS}}
    />
  );
}
`
);

const cleanup = () => {
  // The pages AND the types the dev server generated for them (Next leaves
  // .next/types/app/<route> behind, and typecheck then fails on a module
  // that no longer exists).
  for (const dir of [PROBE_DIR, API_DIR, ...TYPES]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  }
  rmSync(work, { recursive: true, force: true });
};

const dev = spawn("node", ["node_modules/next/dist/bin/next", "dev", "--port", APP_PORT], {
  cwd: ROOT.pathname,
  stdio: "ignore",
  // Detached, so shutdown can take the whole process GROUP down: `next dev`
  // forks a worker that survives killing the parent.
  detached: true,
  env: { ...process.env, NEXT_PUBLIC_FOUNDER_EMAILS: FOUNDER }
});
let chrome = null;
const shutdown = () => {
  chrome?.kill("SIGKILL");
  try {
    process.kill(-dev.pid, "SIGKILL");
  } catch {
    dev.kill("SIGKILL");
  }
  cleanup();
};
process.on("exit", shutdown);

async function serverReady() {
  let last = "no response";
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(APP);
      // The probe page is OURS: a stale server on this port answers 404 here
      // rather than faking a pass.
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = String(e);
    }
    await sleep(1000);
  }
  throw new Error(`Nothing served ${APP} after 120s — ${last}`);
}

await serverReady();
chrome = spawn(
  "google-chrome",
  [
    "--headless=new",
    "--no-first-run",
    "--no-sandbox",
    "--disable-gpu",
    `--user-data-dir=${join(work, "profile")}`,
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--remote-debugging-port=0",
    APP
  ],
  { stdio: "ignore" }
);

for (let i = 0; i < 90 && !existsSync(reportPath); i++) await sleep(1000);
if (!existsSync(reportPath)) {
  console.error("FAIL  the screen never sent a final request — the turn did not stop itself, or never started");
  process.exit(1);
}
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const parts = report.calls.filter((c) => c.fields.chunk_part === "1");
const finals = report.calls.filter((c) => c.fields.chunk_part !== "1");
const final = finals[0];
const prior = final?.fields.prior ? JSON.parse(final.fields.prior) : null;

for (const c of report.calls) {
  const f = c.fields;
  console.log(
    `  t+${String(c.sinceTapMs).padStart(5)} ms  ${f.chunk_part === "1" ? "part " : "FINAL"} index=${f.chunk_index} chunk_ms=${f.chunk_ms}` +
      ` audio=${f.audio?.bytes ?? 0}B rec_ms=${f.rec_ms ?? "-"}${f.prior ? ` prior=${f.prior}` : ""}`
  );
}

check(
  `the wrap-up line appeared for THIS tier's cap (${FREE ? "free" : "paid"}: about ${WRAP_AT_MS} ms in)`,
  typeof report.wrapAtMs === "number" && report.wrapAtMs >= WRAP_AT_MS - 500 && report.wrapAtMs < WRAP_AT_MS + 1500,
  `first seen at ${report.wrapAtMs} ms`
);
if (FREE) {
  check(
    "a free turn stopped itself at the FREE cap, long before the paid one",
    !!final && final.sinceTapMs >= FREE_CAP_MS - 500 && final.sinceTapMs < FREE_CAP_MS + 3000 && final.sinceTapMs < PAID_CAP_MS - 3000,
    `final at ${final?.sinceTapMs} ms, free cap ${FREE_CAP_MS} ms, paid cap ${PAID_CAP_MS} ms`
  );
  check("it is ONE ordinary request: no parts, no prior, no chunk fields", report.calls.length === 1 && parts.length === 0 && !("prior" in (final?.fields ?? {})) && !("chunk_index" in (final?.fields ?? {})), Object.keys(final?.fields ?? {}).join(","));
  check("the founder knobs in the address did nothing for a non-founder", parts.length === 0);
  check("it carried the whole turn's audio", final?.fields.audio?.bytes > 5000 && Math.abs(Number(final?.fields.rec_ms) - FREE_CAP_MS) < 2500, `audio=${final?.fields.audio?.bytes}B rec_ms=${final?.fields.rec_ms}`);
} else {
  check("parts 0 and 2 were sent; the forced-fail part 1 never left the phone", parts.map((p) => p.fields.chunk_index).join(",") === "0,2");
  check(
    "each part went up while the turn was still recording (the button still said Stop)",
    parts.length === 2 && parts.every((p) => /stop/i.test(p.button) && p.sinceTapMs < CAP_MS),
    parts.map((p) => `${p.sinceTapMs} ms "${p.button.trim()}"`).join(", ")
  );
  check("each part carried real audio of about one chunk", parts.every((p) => p.fields.audio?.bytes > 5000 && Math.abs(Number(p.fields.chunk_ms) - CHUNK_S * 1000) < 1500));
  check("exactly one final request", finals.length === 1);
  check(
    "nobody tapped Stop: the cap stopped the turn, and at the cap — not a chunk late",
    !!final && final.sinceTapMs >= CAP_MS - 500 && final.sinceTapMs < CAP_MS + 3000,
    `final at ${final?.sinceTapMs} ms, cap ${CAP_MS} ms`
  );
  check("the final carries [text, lost, text] in order", !!prior && prior.length === 3 && prior[0].text === "words of chunk 0" && prior[1].lost === true && prior[2].text === "words of chunk 2", JSON.stringify(prior));
  check("the lost chunk reports its own length for the marker", !!prior && Math.abs(prior[1].ms - CHUNK_S * 1000) < 1500);
  check("the final carries the last chunk's own audio and index", final?.fields.chunk_index === "3" && final?.fields.audio?.bytes > 1000);
  check(
    "rec_ms is the WHOLE turn, chunk_ms the last chunk",
    Math.abs(Number(final?.fields.rec_ms) - CAP_MS) < 2500 && Number(final?.fields.chunk_ms) < CHUNK_S * 1000,
    `rec_ms=${final?.fields.rec_ms} chunk_ms=${final?.fields.chunk_ms}`
  );
  check("one turn id across every request", new Set(report.calls.map((c) => c.fields.turn_id)).size === 1 && /^[0-9a-f-]{36}$/.test(final?.fields.turn_id ?? ""));
}
check("the result reached the screen", report.heard === true);

console.log(failures.length === 0 ? "\nall checks passed" : `\n${failures.length} check(s) failed`);
process.exit(failures.length === 0 ? 0 : 1);
