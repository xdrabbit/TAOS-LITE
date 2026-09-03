// Two things /call's screen said that its screen could not do.
//
// 1. "tap Rejoin." The interpreter stops itself after two minutes of quiet and
//    again at the one-hour cap, and both notices have told the person to tap
//    Rejoin since the timers landed. There has never been a Rejoin. The only
//    button on the screen was Hang up, which ends the CALL — so the cheapest
//    way out of two minutes of quiet was to drop a working connection and dial
//    again, paying the whole handshake over.
//
// 2. Which pill was which. The lobby row is captioned "They speak · Ellos
//    hablan"; the in-call row was not captioned at all, so mid-call the only
//    thing separating the solid pill from the outlined one was a `title`
//    tooltip — and a phone has no hover. That is what put Tom's thumb on his
//    own pill on 9/3.
//
// The tap behaviour itself is driven for real in tests/call-pill-lock.test.ts.
// This file reads the shell, which is where the WIRING lives: a correct pill
// component handed the wrong props is still a wrong screen.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SHELL = "components/CallShell.tsx";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

/** Source minus commentary — the rationale above is repeated in the shell,
 *  and a comment describing a prop is not a prop. */
function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\s*\}/g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

/** Every `<LanguagePillRow ... />` in the shell: the lobby's and the call's. */
function pillRows(): string[] {
  return code(SHELL).match(/<LanguagePillRow[\s\S]*?\/>/g) ?? [];
}

describe("the in-call row is captioned like the lobby's", () => {
  it("draws two rows, and BOTH of them say what the pills mean", () => {
    const rows = pillRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toContain('caption="They speak · Ellos hablan"');
      expect(row).toContain('pairedTitle="You hear this · Tú escuchas esto"');
    }
  });

  it("says which language you hear in words, not in a pill colour", () => {
    // The tooltip was the whole of it mid-call, and a tooltip on a phone is
    // nothing at all. Both rows are followed by a sentence naming the side.
    const src = code(SHELL);
    expect(src.match(/You hear <span className="text-amber-200">\{languageLabel\(mine\)\}<\/span>/g))
      .toHaveLength(2);
  });
});

describe("your own side is inert for the duration of a call", () => {
  it("locks the pair only while the call is up", () => {
    // The lobby keeps the flip: nothing is listening yet, the pair is a local
    // preference, and one tap undoes it. In a call it re-points a live
    // session and moves the PARTNER's phone too.
    const src = code(SHELL);
    expect(src).toContain('useLanguagePair({ lockMine: phase === "call" })');
  });

  it("hands that same flag to every surface that can tap your own side", () => {
    // Three of them: the lobby row, the in-call row, and the sheet behind
    // "+ More · Más" — where your own language is one row among a hundred.
    // One flag, so they cannot drift apart.
    expect((code(SHELL).match(/pairedLocked=\{mineLocked\}/g) ?? [])).toHaveLength(3);
  });
});

describe("Rejoin exists, and only where it does something", () => {
  it("draws the button the notice has been promising", () => {
    const src = code(SHELL);
    expect(src).toContain("↻ Rejoin · Reanudar");
    expect(src).toContain("onClick={rejoinInterpreter}");
    // A fingertip, like everything else added since #54.
    const button = src.slice(src.indexOf("onClick={rejoinInterpreter}"));
    expect(button.slice(0, button.indexOf("</button>"))).toContain("min-h-[44px]");
  });

  it("shows it only after the interpreter stopped itself", () => {
    // Not a control that is always there: it does nothing during a healthy
    // call, and it is not what you want after Hang up. `autoEnded` carries
    // the reason and is cleared by both a restart and the end of the call.
    const src = code(SHELL);
    expect(src).toContain("{autoEnded ? (");
    expect(src).toContain("setAutoEnded(reason)");
    expect((src.match(/setAutoEnded\(null\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("restarts the INTERPRETER, not the call", () => {
    // The peer connection, the remote track and the wake lock all survive an
    // auto-end. Rejoin re-mints one realtime session on the audio that is
    // already arriving; it must never reach for join() or endCall().
    const src = code(SHELL);
    const fn = src.slice(src.indexOf("const rejoinInterpreter"));
    const body = fn.slice(0, fn.indexOf("}, [startInterpreterFor]);"));
    expect(body).toContain("startInterpreterFor(track)");
    expect(body).not.toContain("endCall");
    expect(body).not.toMatch(/\bjoin\(/);
  });

  it("refuses to mint a session against a track that is not live", () => {
    // A rejoin on dead audio is a paid realtime session listening to nothing
    // — the same shape as the doubled-pair guard above it.
    const src = code(SHELL);
    const fn = src.slice(src.indexOf("const rejoinInterpreter"));
    const body = fn.slice(0, fn.indexOf("}, [startInterpreterFor]);"));
    expect(body).toContain('track.readyState !== "live"');
    expect(body).toContain("inCallRef.current");
  });

  it("stops telling people they are off the call when they are not", () => {
    // Both auto-end notices now say so, because "the interpreter stopped" and
    // "the call dropped" looked identical from the chair.
    const src = code(SHELL);
    expect((src.match(/You are still on the call\./g) ?? [])).toHaveLength(2);
  });
});
