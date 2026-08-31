// /fast's mic is PARKED — the fence around a drawer that is meant to reopen.
//
// Tom's decision, 2026-08-31: the custom mic comes off /fast and the platform
// keyboard's dictation button replaces it. It worked on Android and was dead
// on iPhone through three rounds of fixes (PRs #49, #50), and every phone TAOS
// ships to already carries a mic that works, on the keyboard, landing its words
// in the same box.
//
// "Parked" is a stronger claim than "the button is gone", and this file pins
// all of it:
//
//   1. the flag is OFF by default, like every other release flag;
//   2. /fast draws no mic — no dictate control, no recording banner, no
//      streaming partials, no hold-to-talk;
//   3. and it says where the mic went, in both languages;
//   4. the three mic ROUTES are shut too. This is the half that is easy to
//      forget: /api/fast/listen buys a Whisper transcription and
//      /api/fast/speech-token hands out ten minutes of unrevokable Azure
//      recognition authority. A paid endpoint left open with nothing calling
//      it is not parked, it is unwatched;
//   5. nothing was DELETED. Every piece of the streaming stack is still in the
//      repo with its tests, because an Android-only revival is the case this
//      was parked for;
//   6. the dock is reached by a lazy import behind the flag, so with it unset
//      the Speech SDK is not in what a phone downloads.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import { fastMicEnabled, fastMicVisibleTo, fastVisibleTo } from "@/lib/release";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/**
 * The same file with its line comments stripped.
 *
 * FastShell EXPLAINS the removal at length, and the explanation names every
 * module that went into the drawer — in line comments, in a JSDoc block over
 * the lazy import, and in JSX comments. An assertion that an import is gone has
 * to look at the code and not at the paragraphs describing why it went.
 */
const code = (path: string) =>
  source(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const FOUNDER = "xdrabbit@gmail.com";
const STRANGER = "stranger@example.com";

let caller: { id: string; email: string } | null = null;

vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async (req: Request) => {
    const header = req.headers.get("authorization") ?? "";
    return header.startsWith("Bearer ") && caller ? caller : null;
  }
}));

/** Any provider call at all is a leak: a parked route must refuse for free. */
const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL = {
  fast: process.env.NEXT_PUBLIC_ENABLE_FAST,
  mic: process.env.NEXT_PUBLIC_ENABLE_FAST_MIC
};

beforeEach(async () => {
  caller = null;
  fetchSpy.mockClear();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.AZURE_SPEECH_KEY = "speech-key";
  process.env.AZURE_SPEECH_REGION = "eastus";
  delete process.env.NEXT_PUBLIC_ENABLE_FAST;
  delete process.env.NEXT_PUBLIC_ENABLE_FAST_MIC;
  const { resetFastRateLimits } = await import("@/lib/fast/rateLimit");
  resetFastRateLimits();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  delete process.env.AZURE_SPEECH_KEY;
  delete process.env.AZURE_SPEECH_REGION;
  for (const [name, value] of [
    ["NEXT_PUBLIC_ENABLE_FAST", ORIGINAL.fast],
    ["NEXT_PUBLIC_ENABLE_FAST_MIC", ORIGINAL.mic]
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.resetModules();
});

// ───────────────────────────────────────────────────────────────────────────
// 1. The flag
// ───────────────────────────────────────────────────────────────────────────

describe("fastMicEnabled — off unless somebody says otherwise", () => {
  it("is off when the flag is unset — the default, and what production ships", () => {
    expect(fastMicEnabled()).toBe(false);
  });

  it("is off for every value that is not an explicit opt-in", () => {
    for (const value of ["", " ", "0", "no", "false", "yes please", "on"]) {
      process.env.NEXT_PUBLIC_ENABLE_FAST_MIC = value;
      expect(fastMicEnabled()).toBe(false);
    }
  });

  it("turns on with 1 or true, tolerating case and stray whitespace", () => {
    for (const value of ["1", "true", " TRUE ", "True"]) {
      process.env.NEXT_PUBLIC_ENABLE_FAST_MIC = value;
      expect(fastMicEnabled()).toBe(true);
    }
  });

  it("reads the literal process.env expression, so Next can inline it client-side", () => {
    // The whole bundle argument rests on this. A computed key
    // (process.env[name]) is opaque to the compiler, the value never gets
    // inlined into the browser bundle, and `fastMicEnabled()` would answer
    // false on every phone whatever Vercel is set to.
    expect(source("lib/release.ts")).toContain("process.env.NEXT_PUBLIC_ENABLE_FAST_MIC");
  });
});

describe("fastMicVisibleTo — both halves, and neither is enough", () => {
  it("shuts the mic to a FOUNDER while it is parked", () => {
    // The point of the decision. /call and /video are held back FROM
    // customers; the mic is held back from everyone, tutor-style, because it
    // is not waiting on a wave of field testing — it was taken off.
    expect(fastVisibleTo(FOUNDER)).toBe(true);
    expect(fastMicVisibleTo(FOUNDER)).toBe(false);
  });

  it("opens to a founder when the flag is set", () => {
    process.env.NEXT_PUBLIC_ENABLE_FAST_MIC = "1";
    expect(fastMicVisibleTo(FOUNDER)).toBe(true);
  });

  it("does not promote /fast past the founders gate on its way back", () => {
    // Reviving the mic must not also hand /fast to strangers. Two flags, and
    // this one is ANDed with the screen's own.
    process.env.NEXT_PUBLIC_ENABLE_FAST_MIC = "1";
    expect(fastMicVisibleTo(STRANGER)).toBe(false);
    expect(fastMicVisibleTo(null)).toBe(false);
    process.env.NEXT_PUBLIC_ENABLE_FAST = "1";
    expect(fastMicVisibleTo(STRANGER)).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. The screen
// ───────────────────────────────────────────────────────────────────────────

describe("/fast draws no mic", () => {
  const shell = source("components/FastShell.tsx");

  it("has no dictate button and no hold-to-talk affordance", () => {
    expect(shell).not.toContain('aria-label="Dictar · Dictate"');
    expect(shell).not.toContain("onPointerDown");
    expect(shell).not.toContain("touch-none");
    expect(shell).not.toContain("dictation.press()");
  });

  it("has no recording indicator and no streaming partials display", () => {
    expect(shell).not.toContain("Listening — let go when done");
    expect(shell).not.toContain("Escuchando");
    expect(shell).not.toContain("Writing it down");
    expect(shell).not.toContain("dictation.partial");
    expect(shell).not.toContain("BOX_BASE");
  });

  it("does not import the streaming stack at all", () => {
    // The import list is the bundle. One `import { useLiveDictation }` here
    // and the Speech SDK is in the chunk every /fast visit downloads,
    // whatever the flag says. Comments stripped: the header above names all of
    // these while explaining where they went.
    const body = code("components/FastShell.tsx");
    for (const parked of [
      "useLiveDictation",
      "useDictation",
      "micCapture",
      "speechLocale",
      "liveTranscript",
      "microsoft-cognitiveservices-speech-sdk"
    ]) {
      expect(body).not.toContain(parked);
    }
  });

  it("keeps the box a plain textarea, always", () => {
    // There is no live view to swap in any more, which is what makes the
    // caret, the placeholder and `autoFocus` true for every second the screen
    // is open — and it is why Clear can simply focus `inputRef`.
    expect(shell).toContain("<textarea");
    expect(shell.match(/<textarea/g)).toHaveLength(1);
    expect(shell).toContain("autoFocus");
  });
});

describe("Clear survived the removal — Tom asked for it explicitly", () => {
  const shell = source("components/FastShell.tsx");

  it("is still on the screen, still bilingual, still beside the box", () => {
    expect(shell).toContain('aria-label="Borrar · Clear"');
    expect(shell).toContain("hasSomethingToClear(input, micPartial)");
  });
});

describe("the screen says where the mic went", () => {
  const shell = source("components/FastShell.tsx");

  it("carries one quiet bilingual line under the input", () => {
    // Bilingual for the same reason every other piece of /fast copy is: the
    // storefront is handed to strangers and half of them read the Spanish
    // side first. Subtle rather than dismissible — a screen this bare cannot
    // afford a second control whose whole job is to remove the first.
    expect(shell).toContain("Your keyboard&rsquo;s mic works here");
    expect(shell).toContain("El micrófono de tu teclado funciona aquí");
    expect(shell).toContain("💡");
  });

  it("sits under the input rather than under the answer", () => {
    const tip = shell.indexOf("El micrófono de tu teclado");
    const box = shell.indexOf("<textarea");
    const answer = shell.indexOf("Start typing — the translation appears here.");
    expect(box).toBeGreaterThan(-1);
    expect(tip).toBeGreaterThan(box);
    expect(tip).toBeLessThan(answer);
  });

  it("records the keyboard-language limitation rather than pretending it away", () => {
    // iOS keyboard dictation transcribes in the KEYBOARD's language, not in
    // whatever is being spoken, where our own mic auto-detected between the
    // two pills. That was the best thing it did, and losing it is the price of
    // this decision. Documented and accepted (Tom, 8/31) — not discovered
    // again in six months by somebody reading a blank line.
    expect(shell).toMatch(/KNOWN LIMITATION[\s\S]{0,400}keyboard/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. The lazy door
// ───────────────────────────────────────────────────────────────────────────

describe("the dock is loaded, not linked", () => {
  const shell = source("components/FastShell.tsx");

  it("reaches the dock through a dynamic import behind the flag", () => {
    // `dynamic()` only registers a loader; the chunk is fetched on the first
    // RENDER, and that render is guarded. So with the flag unset the request
    // is never made and useLiveDictation + micCapture + the Speech SDK stay
    // off the phone entirely — which is the difference between parking a
    // feature and merely hiding its button.
    expect(shell).toContain('dynamic(() => import("./fast/FastMicDock"), { ssr: false })');
    expect(shell).toMatch(/\{fastMicEnabled\(\) \? \(\s*<FastMicDock/);
  });

  it("renders it nowhere else, so there is exactly one guarded mount", () => {
    expect(shell.match(/<FastMicDock/g)).toHaveLength(1);
  });

  it("is the only thing in the app that mounts the dock", () => {
    // A second mount somewhere unguarded would put the chunk back in play.
    expect(source("app/fast/page.tsx")).not.toContain("FastMicDock");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. The routes are shut too
// ───────────────────────────────────────────────────────────────────────────

describe("the three mic routes refuse a founder while the mic is parked", () => {
  beforeEach(() => {
    caller = { id: "founder-1", email: FOUNDER };
  });

  async function listen() {
    const form = new FormData();
    form.append("audio", new File([new Uint8Array(4096)], "quickie.webm", { type: "audio/webm" }));
    form.append("pairA", "en");
    form.append("pairB", "es");
    const { POST } = await import("@/app/api/fast/listen/route");
    return POST(
      new NextRequest("https://taoslite.com/api/fast/listen", {
        method: "POST",
        headers: { Authorization: "Bearer t" },
        body: form
      })
    );
  }

  async function mint() {
    const { POST } = await import("@/app/api/fast/speech-token/route");
    return POST(
      new NextRequest("https://taoslite.com/api/fast/speech-token", {
        method: "POST",
        headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
        body: "{}"
      })
    );
  }

  async function settle() {
    const { POST } = await import("@/app/api/fast/speech-settle/route");
    return POST(
      new NextRequest("https://taoslite.com/api/fast/speech-settle", {
        method: "POST",
        headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "s1", seconds: 3 })
      })
    );
  }

  it("404s /api/fast/listen without buying a transcription", async () => {
    expect((await listen()).status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("404s /api/fast/speech-token without minting ten minutes of Azure", async () => {
    // The expensive refusal. A JWT that reaches a browser cannot be revoked —
    // Azure's TTL is fixed at ten minutes — so the only place to stop one is
    // before it is issued.
    expect((await mint()).status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("404s /api/fast/speech-settle", async () => {
    expect((await settle()).status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("404s a signed-out stranger too, which is the pre-existing fence", async () => {
    caller = null;
    expect((await listen()).status).toBe(404);
    expect((await mint()).status).toBe(404);
    expect((await settle()).status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("gates on the mic flag and not only on the screen's", async () => {
    // The regression this guards: somebody promotes /fast with
    // NEXT_PUBLIC_ENABLE_FAST=1 and the parked mic's routes come back with it.
    process.env.NEXT_PUBLIC_ENABLE_FAST = "1";
    expect((await listen()).status).toBe(404);
    expect((await mint()).status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("opens again on the mic flag, so this really is a park", async () => {
    // Past the gate, into the route proper — which is all this needs to show.
    // What it then does with the audio is tests/fast-dictation.test.ts's job;
    // here the only claim is that the door opens.
    process.env.NEXT_PUBLIC_ENABLE_FAST_MIC = "1";
    expect((await listen()).status).not.toBe(404);
    expect(fetchSpy).toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 5. Nothing was deleted
// ───────────────────────────────────────────────────────────────────────────

describe("the streaming stack is in the drawer, not in the bin", () => {
  it.each([
    ["components/fast/FastMicDock.tsx", "the UI, lifted out of FastShell"],
    ["lib/fast/useLiveDictation.ts", "the streaming hook and its four watchdogs"],
    ["lib/fast/useDictation.ts", "the batch mic it falls back to"],
    ["lib/fast/micCapture.ts", "the hand-built audio graph iOS needed"],
    ["lib/fast/speechLocale.ts", "the catalog → Azure locale map"],
    ["lib/fast/liveTranscript.ts", "partials in, finals out"],
    ["lib/fast/speechMeter.ts", "the audio-seconds ledger"],
    ["app/api/fast/speech-token/route.ts", "the credential mint"],
    ["app/api/fast/speech-settle/route.ts", "the other end of its reservation"],
    ["app/api/fast/listen/route.ts", "the batch transcriber"]
  ])("keeps %s — %s", (path) => {
    expect(existsSync(new URL(`../${path}`, import.meta.url))).toBe(true);
  });

  it("names the flag and the reason where the next person will look", () => {
    // lib/release.ts is where every other gate explains itself, so it is where
    // this one does too — including the list above, so a revival does not have
    // to be archaeology.
    const release = source("lib/release.ts");
    expect(release).toContain("NEXT_PUBLIC_ENABLE_FAST_MIC");
    expect(release).toContain("useLiveDictation");
    expect(release).toMatch(/PARKED|park/);
  });

  it("leaves the forensic file findable from the backlog", () => {
    // "Worked on Android, killed by iOS WebKit audio stack after 3 fix rounds;
    // candidate for Android-only revival." The bug was invisible to every
    // engine CI can reach, so the write-up IS the evidence.
    const backlog = source("ENHANCEMENTS.md");
    expect(backlog).toContain("NEXT_PUBLIC_ENABLE_FAST_MIC");
    expect(backlog).toMatch(/Android/);
  });
});
