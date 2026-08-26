// The curriculum is data, and this is the fence around it.
//
// docs/tutor-curriculum-plan.md lists fourteen modules and Tom approved that
// list as-is, so "there are fourteen, in this order" is a decided behavior and
// not an implementation detail. The rest of this file guards the one property
// the whole design rests on: a module describes an INTENT, never a sentence.
// The day a module says "use the verb querer" is the day the curriculum
// silently stops working in Hindi.
import { describe, expect, it } from "vitest";
import {
  TUTOR_MODULES,
  TUTOR_MODULE_IDS,
  getTutorModule,
  isTutorModuleId,
  tutorModuleNumber
} from "@/lib/tutor/modules";

describe("the fourteen survival modules", () => {
  it("has all fourteen, in the plan's order", () => {
    expect(TUTOR_MODULE_IDS).toEqual([
      "first-contact",
      "who-i-am",
      "numbers-money",
      "needs-wants",
      "where-is",
      "food-drink",
      "market-shopping",
      "getting-around",
      "sleeping",
      "trouble",
      "health",
      "connection",
      "time-plans",
      "reactions"
    ]);
  });

  it("numbers them the way the plan and the picker do", () => {
    expect(tutorModuleNumber("first-contact")).toBe(1);
    expect(tutorModuleNumber("needs-wants")).toBe(4);
    expect(tutorModuleNumber("connection")).toBe(12);
    expect(tutorModuleNumber("reactions")).toBe(14);
  });

  it("has a unique id per module", () => {
    expect(new Set(TUTOR_MODULE_IDS).size).toBe(TUTOR_MODULE_IDS.length);
  });

  it("answers isTutorModuleId honestly", () => {
    expect(isTutorModuleId("needs-wants")).toBe(true);
    expect(isTutorModuleId("day-3")).toBe(false);
    expect(isTutorModuleId(null)).toBe(false);
  });

  it("gives every module the schema the plan specifies", () => {
    // id, competency, situations, core_moves, contrast_hook, roleplay_seed,
    // pronunciation_targets — the yaml block in the plan, as types.
    for (const mod of TUTOR_MODULES) {
      expect(mod.id, mod.id).toMatch(/^[a-z][a-z-]+$/);
      expect(mod.title.length, mod.id).toBeGreaterThan(2);
      expect(mod.titleEs.length, mod.id).toBeGreaterThan(2);
      expect(mod.competency.length, mod.id).toBeGreaterThan(30);
      expect(mod.situations.length, mod.id).toBeGreaterThanOrEqual(2);
      expect(mod.coreMoves.length, mod.id).toBeGreaterThanOrEqual(4);
      expect(new Set(mod.coreMoves).size, mod.id).toBe(mod.coreMoves.length);
      expect(mod.contrastHook, mod.id).toBe(true);
      expect(mod.contrastFocus.length, mod.id).toBeGreaterThan(30);
      expect(mod.roleplaySeed.length, mod.id).toBeGreaterThan(40);
      expect(mod.pronunciationTargets.length, mod.id).toBeGreaterThanOrEqual(1);
      expect(new Set(mod.pronunciationTargets).size, mod.id).toBe(
        mod.pronunciationTargets.length
      );
    }
  });
});

describe("module 12 is Connection, and it carries the Taiwan ask", () => {
  // The plan names this one deliberately: kids in 1980s Taiwan walking up to a
  // foreigner and asking whether they could have a conversation is the origin
  // insight of the whole product. Wifi and SIM cards share the module; the
  // social ask is the part that must never quietly drop out of it.
  const connection = getTutorModule("connection");

  it("is named Connection", () => {
    expect(connection?.title).toBe("Connection");
  });

  it("teaches asking a stranger for a conversation", () => {
    expect(connection?.coreMoves).toContain("ask_for_conversation");
  });

  it("still covers the practical half — wifi and a phone", () => {
    expect(connection?.coreMoves).toContain("ask_wifi");
    expect(connection?.coreMoves).toContain("ask_sim_card");
  });
});

describe("module 4 is the plan's worked example", () => {
  const needs = getTutorModule("needs-wants");

  it("keeps the plan's core moves", () => {
    expect(needs?.coreMoves).toEqual(["request", "quantity", "accept", "decline", "thank"]);
  });

  it("keeps the pharmacist scene, misunderstanding included", () => {
    expect(needs?.roleplaySeed.toLowerCase()).toContain("pharmacist");
    expect(needs?.roleplaySeed.toLowerCase()).toContain("headache");
    expect(needs?.roleplaySeed.toLowerCase()).toMatch(/misunderstand/);
  });

  it("scores the request and the thanks", () => {
    expect(needs?.pronunciationTargets).toEqual(["request_phrase", "thank_phrase"]);
  });
});

describe("no module hardcodes a language", () => {
  // THE design principle (docs/tutor-curriculum-plan.md): "curriculum is
  // written ONCE as language-agnostic intent modules". A competency, a
  // situation, a core move or a roleplay seed that names a language — or worse,
  // quotes a phrase in one — is a sentence skeleton in disguise, and it breaks
  // silently in the 99 languages it was not written for.
  //
  // `contrastFocus` is deliberately EXEMPT and is the only field that is. It
  // names languages precisely because it is a hint about what tends to differ
  // ("Hindi's dative subject, Farsi's verb-final order"), and the generation
  // prompt hands it to the model with an explicit instruction to ignore it
  // when it does not apply to the actual pair. It steers the contrast; it
  // never supplies a phrase.
  const LANGUAGE_WORDS =
    /\b(spanish|english|español|inglés|french|german|hindi|arabic|chinese|mandarin|japanese|italian|portuguese|farsi|persian|korean|turkish)\b/i;

  it("keeps language names out of the teaching fields", () => {
    for (const mod of TUTOR_MODULES) {
      const fields = [
        mod.competency,
        mod.roleplaySeed,
        ...mod.situations,
        ...mod.coreMoves,
        mod.title,
        mod.titleEs
      ];
      for (const field of fields) {
        expect(LANGUAGE_WORDS.test(field), `${mod.id}: "${field}"`).toBe(false);
      }
    }
  });

  it("keeps quoted target-language phrases out of the seeds", () => {
    // A seed is a SCENE ("be natural, misunderstand once"), never a script.
    for (const mod of TUTOR_MODULES) {
      expect(mod.roleplaySeed, mod.id).not.toMatch(/["“”][^"“”]{3,}["“”]/);
    }
  });
});
