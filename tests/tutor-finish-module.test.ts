// "Finish this module →" has to finish the module.
//
// Tom's field report: Module 1, all three phases ticked, the screen saying
// "You covered the whole topic · Cubriste todo el tema" — and the button did
// nothing. It was not a broken handler. Run marks itself done the moment the
// scene reaches its last beat, so by the time the button appeared the only
// thing it did (markPhaseDone("run")) was a write of a value already there:
// no state change, no render, no way out of the screen.
//
// So finishing is its own act now. These are the fences on it:
//
//   1. the press writes something — a stamp, not a re-write
//   2. the press leaves the screen — back to the picker
//   3. the picker shows the module as done, and says so in both languages
//   4. a finished module is still a button. Review is a feature.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  completedPhases,
  finishModule,
  isModuleComplete,
  markPhaseDone,
  nextModuleId,
  nextPhase,
  parseStoredProgress,
  progressKey,
  recordScore,
  type TutorProgress
} from "@/lib/tutor/progress";
import { TUTOR_MODULE_IDS } from "@/lib/tutor/modules";

const KEY = progressKey("first-contact", "es", "en");
const AT = "2026-08-28T17:00:00.000Z";

function shell(): string {
  return readFileSync(new URL("../components/tutor/ModulesShell.tsx", import.meta.url), "utf8");
}

describe("finishing a module", () => {
  it("writes a stamp even when Run was already ticked — the exact dead-button case", () => {
    // The state from Tom's screenshot: three phases done, nothing left for
    // markPhaseDone to change.
    let p: TutorProgress = {};
    p = markPhaseDone(p, KEY, "crawl", AT);
    p = markPhaseDone(p, KEY, "walk", AT);
    p = markPhaseDone(p, KEY, "run", AT);
    expect(markPhaseDone(p, KEY, "run", AT)[KEY]).toEqual(p[KEY]);

    const finished = finishModule(p, KEY, AT);
    expect(finished).not.toBe(p);
    expect(finished[KEY].completedAt).toBe(AT);
  });

  it("ticks Run too, because the button is reachable before the last beat", () => {
    const p = finishModule({}, KEY, AT);
    expect(p[KEY].run).toBe(AT);
    expect(completedPhases(p[KEY])).toBeGreaterThanOrEqual(1);
    expect(isModuleComplete(p[KEY])).toBe(true);
  });

  it("keeps everything else the module earned", () => {
    let p = recordScore({}, KEY, 82);
    p = markPhaseDone(p, KEY, "crawl", AT);
    p = finishModule(p, KEY, AT);
    expect(p[KEY].bestScore).toBe(82);
    expect(p[KEY].crawl).toBe(AT);
  });

  it("touches only this module, target and learner", () => {
    const other = progressKey("first-contact", "hi", "en");
    const p = finishModule({ [other]: { crawl: AT } }, KEY, AT);
    expect(isModuleComplete(p[other])).toBe(false);
    expect(isModuleComplete(p[KEY])).toBe(true);
  });

  it("survives a reload", () => {
    const stored = JSON.stringify(finishModule({}, KEY, AT));
    expect(parseStoredProgress(stored)[KEY].completedAt).toBe(AT);
  });
});

describe("what counts as complete", () => {
  it("is nothing, on a module never opened", () => {
    expect(isModuleComplete(undefined)).toBe(false);
    expect(isModuleComplete({})).toBe(false);
    expect(isModuleComplete({ crawl: AT, walk: AT })).toBe(false);
  });

  it("counts three walked phases, so work done before the stamp existed still counts", () => {
    // Tom's phone already holds exactly this record. It is a finished module
    // and the picker says so without asking him to press anything.
    expect(isModuleComplete({ crawl: AT, walk: AT, run: AT })).toBe(true);
  });

  it("counts the stamp", () => {
    expect(isModuleComplete({ run: AT, completedAt: AT })).toBe(true);
  });
});

describe("what to do next", () => {
  it("points at the first module not yet finished, in curriculum order", () => {
    expect(nextModuleId({}, TUTOR_MODULE_IDS, "es", "en")).toBe("first-contact");
    const p = finishModule({}, KEY, AT);
    expect(nextModuleId(p, TUTOR_MODULE_IDS, "es", "en")).toBe("who-i-am");
  });

  it("points back at the gap when a learner skipped ahead", () => {
    const p = finishModule({}, progressKey("trouble", "es", "en"), AT);
    expect(nextModuleId(p, TUTOR_MODULE_IDS, "es", "en")).toBe("first-contact");
  });

  it("is per language: finishing it in Spanish leaves Hindi at the start", () => {
    const p = finishModule({}, KEY, AT);
    expect(nextModuleId(p, TUTOR_MODULE_IDS, "hi", "en")).toBe("first-contact");
  });

  it("has nothing left to point at once all fourteen are done", () => {
    let p: TutorProgress = {};
    for (const id of TUTOR_MODULE_IDS) p = finishModule(p, progressKey(id, "es", "en"), AT);
    expect(nextModuleId(p, TUTOR_MODULE_IDS, "es", "en")).toBeNull();
  });
});

describe("re-entering a finished module", () => {
  it("opens at Crawl rather than refusing", () => {
    // nextPhase says null — "nothing owed" — and the loop reads that as
    // "start at the beginning", which is what reviewing a module is.
    const p = finishModule({ [KEY]: { crawl: AT, walk: AT } }, KEY, AT);
    expect(nextPhase(p[KEY])).toBeNull();
    expect(shell()).toContain('nextPhase(progress[key]) ?? "crawl"');
  });

  it("leaves the row a button, with nothing gating the tap", () => {
    const src = shell();
    const row = src.slice(src.indexOf("TUTOR_MODULES.map"), src.indexOf("</ul>"));
    expect(row).toContain("setModuleId(m.id)");
    expect(row).not.toMatch(/disabled=\{[^}]*complete/);
  });
});

describe("the Run button, wired", () => {
  it("finishes and navigates instead of re-marking a phase", () => {
    const src = shell();
    const handler = src.slice(src.indexOf('if (phase !== "run")'), src.indexOf("onFinish();") + 12);
    expect(handler).toContain("finishModule(progress, key");
    expect(handler).toContain("onFinish()");
    // The regression that would bring the dead button back: dropping the
    // navigation and going back to marking the phase and nothing else.
    expect(src).not.toMatch(/onDone=\{\(\) => \{\s*markDone\(phase\);\s*if \(phase === "walk"\)/);
  });

  it("still says the two different things it says", () => {
    const src = shell();
    expect(src).toContain("Finish this module →");
    expect(src).toContain("Mark Run done →");
  });

  it("sends the learner back to the picker, with the note set", () => {
    const src = shell();
    const wiring = src.slice(src.indexOf("onFinish={() => {"), src.indexOf("onBalance={onBalance}\n      />"));
    expect(wiring).toContain("setFinished(mod.id)");
    expect(wiring).toContain("setModuleId(null)");
  });
});

describe("the picker after a finish", () => {
  it("says it in both languages and names what is next", () => {
    const src = shell();
    expect(src).toContain("complete · Módulo");
    expect(src).toContain("completado");
    expect(src).toContain("Next: ${upNextModule.title} · Sigue: ${upNextModule.titleEs}");
  });

  it("takes the note down on its own, and on the next tap", () => {
    const src = shell();
    expect(src).toMatch(/setTimeout\(\(\) => setFinished\(null\), FINISHED_NOTE_MS\)/);
    expect(src).toContain("setFinished(null);\n                    setModuleId(m.id);");
  });

  it("marks the finished rows and emphasises the next one", () => {
    const src = shell();
    const row = src.slice(src.indexOf("TUTOR_MODULES.map"), src.indexOf("</ul>"));
    expect(row).toContain("isModuleComplete(entry)");
    expect(row).toContain("!complete && m.id === upNext");
    expect(row).toContain('complete ? "✓" : tutorModuleNumber(m.id)');
    // The Spanish title is not what gets displaced by a checkmark: it is the
    // line Liz reads to find the module again.
    expect(row).toContain("{m.titleEs}");
  });
});
