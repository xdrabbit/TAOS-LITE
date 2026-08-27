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
    // Realtime does it with its own tutor-minute allowance check, which needs
    // the user id anyway.
    const lesson = readFileSync(new URL("lesson/route.ts", API_DIR), "utf8");
    const assess = readFileSync(new URL("assess/route.ts", API_DIR), "utf8");
    const realtime = readFileSync(new URL("realtime/route.ts", API_DIR), "utf8");
    expect(lesson).toContain("guardSpend");
    expect(assess).toContain("guardSpend");
    expect(realtime).toContain("checkTutorAllowance");
  });
});

describe("the metering seam phase 2 hooks into", () => {
  it("emits a start line when a session is minted, and an end line when it stops", () => {
    const realtime = readFileSync(new URL("realtime/route.ts", API_DIR), "utf8");
    const session = readFileSync(new URL("session/route.ts", API_DIR), "utf8");
    expect(realtime).toContain("logTutorSessionEvent");
    expect(realtime).toContain('event: "start"');
    expect(session).toContain('event: "end"');
  });

  it("ties the two lines together with one id", () => {
    const realtime = readFileSync(new URL("realtime/route.ts", API_DIR), "utf8");
    expect(realtime).toContain("newTutorSessionId");
    expect(realtime).toContain("sessionId");
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
