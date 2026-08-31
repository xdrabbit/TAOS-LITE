// The lobby has to say whether the relay is alive BEFORE anybody dials.
//
// ── What it replaces ───────────────────────────────────────────────────────
// Every test of the relay since PR #52 shipped it has been the same
// procedure: Tom and Liz, two phones, two rooms, dial and see. The relay has
// never once been observed working that way, and the reason is that a call
// answers five questions at once with one word. The keys, the allocation, the
// NAT, the signaling and the media are all folded into "it didn't connect".
//
// So: the server's verdict on the keys goes on the lobby automatically, and
// the client's verdict on the path is one tap away. Neither requires a second
// human, a second phone, or a second room.
//
// This file is a source fence rather than a render test, and deliberately: it
// is asserting that the WIRING exists — that the status is fetched before the
// call rather than during it, that the button is in the lobby and not buried
// in the in-call panel, and that failure states are not quietly dropped on
// the floor. The behaviour underneath is covered by running code in
// tests/call-relay-status.test.ts and tests/call-relay-probe.test.ts.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { relayCopy } from "@/lib/call/relay";

const shell = readFileSync(new URL("../components/CallShell.tsx", import.meta.url), "utf8");

/** Source minus commentary — this file's own rationale is quoted up there. */
const code = shell
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !/^\s*(\/\/|\*)/.test(line))
  .join("\n");

/** The lobby half of the screen: `phase === "lobby" ?` up to its `) : (`. */
const lobby = (() => {
  const start = code.indexOf('{phase === "lobby" ? (');
  expect(start).toBeGreaterThan(-1);
  const end = code.indexOf("        ) : (", start);
  expect(end).toBeGreaterThan(start);
  return code.slice(start, end);
})();

describe("the indicator is on the lobby, not in the call", () => {
  it("asks the server for a verdict when the lobby renders", async () => {
    // Automatic, not a tap. The point is that a founder cannot MISS it: the
    // failure this closes is discovering a credential problem mid-call with
    // your wife.
    expect(code).toContain("fetchRelayStatus()");
    expect(code).toMatch(/if \(phase !== "lobby"\) return;/);
  });

  it("draws the status and the test button in the lobby half", async () => {
    expect(lobby).toContain("relayCopy(");
    expect(lobby).toContain("Test connection · Probar conexión");
    expect(lobby).toContain("Before you dial · Antes de llamar");
  });

  it("re-asks on every return to the lobby", async () => {
    // The interesting moment is Tom fixing a key in Vercel, redeploying, and
    // coming back to find out whether it took. A status fetched once per page
    // load would answer with the old verdict.
    expect(code).toMatch(/\}, \[phase\]\);/);
  });

  it("puts the failure's meaning on screen, not just its name", async () => {
    // `relay: false` was already on the screen before today and told nobody
    // anything. The hint is the half that says what to DO.
    expect(lobby).toContain("copy.hint");
    expect(lobby).toContain("relayReport.detail");
    expect(lobby).toContain("relayReport.httpStatus");
  });

  it("shows the probe's own failure detail, not a bare verdict", async () => {
    expect(lobby).toContain("probeCopy(");
    expect(lobby).toContain("probe.detail");
  });
});

describe("the words a founder reads", () => {
  it("names the four states bilingually, on one line each", async () => {
    // Same rule as every other status on this screen (lib/call/session.ts):
    // the two people on a call read different languages and are looking at
    // their own phones. A status only one of them can read is a status that
    // gets read aloud over a call that is not working yet.
    for (const status of ["ready", "not_configured", "rejected", "error"] as const) {
      const copy = relayCopy(status);
      expect(copy.label).toContain("·");
      expect(copy.hint.length).toBeGreaterThan(0);
    }
  });

  it("tells the founder to go look at Cloudflare when the keys are rejected", async () => {
    // The one state that needs a human, and the only one where the next move
    // is not "wait" or "try again". If this hint ever loses the variable
    // names, the fix stops being two minutes long.
    const copy = relayCopy("rejected");
    expect(copy.tone).toBe("bad");
    expect(copy.hint).toContain("CLOUDFLARE_TURN_KEY_ID");
    expect(copy.hint).toContain("CLOUDFLARE_TURN_API_TOKEN");
    expect(copy.label).toContain("rechazado");
  });

  it("does not call an unconfigured relay an error", async () => {
    // It was production for a day and /call still placed every call it could
    // place. Red here would send Tom hunting a bug that is a to-do item.
    expect(relayCopy("not_configured").tone).toBe("warn");
    expect(relayCopy("ready").tone).toBe("ok");
  });

  it("says `checking` rather than a verdict before the answer lands", async () => {
    // The first paint has no report. Defaulting to any of the four would put
    // a claim on screen that nothing has established.
    const copy = relayCopy(null);
    expect(copy.label).toContain("comprobando");
    expect(copy.label).not.toContain("✓");
    expect(copy.label).not.toContain("✗");
  });
});
