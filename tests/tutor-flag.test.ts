// A disabled feature must cost nothing.
//
// Tutor is gated to EVERYONE, founders included (lib/release.ts): the screen
// redirects home and every tutor API answers 404 rather than spending on
// OpenAI realtime, an OpenAI completion, or Azure. Phase 1 adds routes, and a
// new tutor route that forgets this line is a live billing endpoint sitting
// behind a flag that everyone believes is off.
//
// tests/release.test.ts pins the flag's default. This file pins that every
// route under app/api/tutor honours it — including the ones that do not exist
// yet, because the check enumerates the directory rather than a list someone
// has to remember to update.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { progressKey, markPhaseDone, nextPhase, completedPhases, recordScore, parseStoredProgress } from "@/lib/tutor/progress";

const API_DIR = new URL("../app/api/tutor/", import.meta.url);
const METER = new URL("../lib/tutor/meter.ts", import.meta.url);

function routeFiles(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(API_DIR, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(`${entry.name}/route.ts`);
  }
  return out;
}

describe("every tutor route is behind the flag", () => {
  it("finds the routes at all (a rename must fail loudly, not vacuously pass)", () => {
    const files = routeFiles();
    expect(files).toContain("realtime/route.ts");
    expect(files).toContain("assess/route.ts");
    expect(files).toContain("lesson/route.ts");
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  it("checks tutorEnabled() before doing anything expensive", () => {
    for (const file of routeFiles()) {
      const src = readFileSync(new URL(file, API_DIR), "utf8");
      expect(src, file).toContain("tutorEnabled");
      expect(src, file).toContain('{ status: 404 }');
    }
  });

  it("guards the spending routes with a session too", () => {
    // The 404 is the flag; the guard is what stands there once the flag is on.
    // Realtime asks for the user directly because the meter needs a user id to
    // charge, not just permission to proceed.
    const lesson = readFileSync(new URL("lesson/route.ts", API_DIR), "utf8");
    const assess = readFileSync(new URL("assess/route.ts", API_DIR), "utf8");
    const realtime = readFileSync(new URL("realtime/route.ts", API_DIR), "utf8");
    expect(lesson).toContain("guardSpend");
    expect(assess).toContain("guardSpend");
    expect(realtime).toContain("getUserFromRequest");
    expect(realtime).toContain('{ status: 401 }');
  });
});

// ── The metering seam, phase 2 ─────────────────────────────────────────────
// Phase 1 promised two things and delivered the first: a start line and an end
// line sharing one id, with the debit to follow. Both halves are pinned now —
// the log lines (still the only way a production cost question has ever been
// answered) AND the money, which is the part the log cannot prove.
describe("the metering seam", () => {
  it("emits a start line when a session is minted, and an end line when it stops", () => {
    const realtime = readFileSync(new URL("realtime/route.ts", API_DIR), "utf8");
    const session = readFileSync(new URL("session/route.ts", API_DIR), "utf8");
    const meter = readFileSync(METER, "utf8");
    // The lines moved INTO the meter in phase 2 — one place that knows a
    // session started, one that knows it ended, which is what the seam was
    // for. The routes reach it through beginTutorSession / settleTutorSession.
    expect(meter).toContain("logTutorSessionEvent");
    expect(meter).toContain('event: "start"');
    expect(meter).toContain('event: "end"');
    expect(realtime).toContain("beginTutorSession");
    expect(session).toContain("settleTutorSession");
  });

  it("ties the two lines together with one id", () => {
    const meter = readFileSync(METER, "utf8");
    const realtime = readFileSync(new URL("realtime/route.ts", API_DIR), "utf8");
    expect(meter).toContain("newTutorSessionId");
    expect(realtime).toContain("sessionId");
  });

  it("keeps the allowance rule in one place", () => {
    // Phase 1 carried `checkTutorAllowance` inline in the realtime route with
    // a note saying phase 2 would move it behind the meter, so Walk, Run and
    // Partner could not grow three copies of the rule between them. Four
    // routes spend tutor minutes now; none of them may re-derive what is left.
    for (const file of ["realtime/route.ts", "assess/route.ts", "session/route.ts"]) {
      const src = readFileSync(new URL(file, API_DIR), "utf8");
      expect(src, file).not.toContain("TUTOR_SECONDS_BY_TIER");
      expect(src, file).not.toContain("checkTutorAllowance");
    }
  });

  it("never bills the number the browser sent", () => {
    // The end route takes `seconds` from a client that has an interest in it
    // being small. It is recorded as client_seconds and reconciled against the
    // server's own clock; it is never the figure that is debited.
    const session = readFileSync(new URL("session/route.ts", API_DIR), "utf8");
    expect(session).toContain("clientSeconds");
    expect(session).not.toMatch(/p_billed_seconds|serverSeconds:\s*clientSeconds/);
  });
});

// ── Progress (phase 1: localStorage) ──────────────────────────────────────
// Server-side progress is phase 2+. What phase 1 owes it is a shape that
// separates the same module in two different languages, because "I need /
// I want" in Spanish and in Hindi are not the same work.
describe("module progress", () => {
  it("is per module, per target, per learner", () => {
    expect(progressKey("needs-wants", "es", "en")).not.toBe(
      progressKey("needs-wants", "hi", "en")
    );
  });

  it("walks crawl → walk → run and then says done", () => {
    const key = progressKey("needs-wants", "es", "en");
    let p = {};
    expect(nextPhase(p[key as keyof typeof p])).toBe("crawl");
    p = markPhaseDone(p, key, "crawl", "2026-08-25T00:00:00Z");
    expect(nextPhase((p as Record<string, never>)[key])).toBe("walk");
    p = markPhaseDone(p, key, "walk", "2026-08-25T00:00:00Z");
    p = markPhaseDone(p, key, "run", "2026-08-25T00:00:00Z");
    expect(nextPhase((p as Record<string, never>)[key])).toBeNull();
    expect(completedPhases((p as Record<string, never>)[key])).toBe(3);
  });

  it("keeps the best score and never lowers it", () => {
    const key = progressKey("needs-wants", "es", "en");
    let p = recordScore({}, key, 71.4);
    expect(p[key].bestScore).toBe(71);
    p = recordScore(p, key, 40);
    expect(p[key].bestScore).toBe(71);
    p = recordScore(p, key, 88);
    expect(p[key].bestScore).toBe(88);
  });

  it("survives whatever is actually in localStorage", () => {
    expect(parseStoredProgress(null)).toEqual({});
    expect(parseStoredProgress("not json")).toEqual({});
    expect(parseStoredProgress("[1,2]")).toEqual({});
    expect(parseStoredProgress('{"a":{"crawl":"x","bestScore":300}}')).toEqual({
      a: { crawl: "x", bestScore: 100 }
    });
  });
});
