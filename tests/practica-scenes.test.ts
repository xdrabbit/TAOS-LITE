import { describe, expect, it } from "vitest";
import { PRACTICA_TRIPS } from "@/lib/practica/scenes";

describe("Practica trip data", () => {
  it("ships one five-scene Arrival in Utah trip", () => {
    expect(PRACTICA_TRIPS).toHaveLength(1);
    expect(PRACTICA_TRIPS[0]?.id).toBe("llegada-a-utah");
    expect(PRACTICA_TRIPS[0]?.scenes).toHaveLength(5);
  });

  it("keeps learner and target languages explicit on the trip", () => {
    const trip = PRACTICA_TRIPS[0]!;
    expect(trip.learnerLanguage).toBe("es");
    expect(trip.targetLanguage).toBe("en");
    expect(trip.learnerLanguage).not.toBe(trip.targetLanguage);
  });

  it("gives every scene the required practice fields", () => {
    for (const scene of PRACTICA_TRIPS[0]!.scenes) {
      expect(scene.id).toMatch(/^[a-z0-9-]+$/);
      expect(scene.title.learner.trim()).not.toBe("");
      expect(scene.title.target.trim()).not.toBe("");
      expect(scene.setup.length).toBeGreaterThanOrEqual(2);
      expect(scene.setup.length).toBeLessThanOrEqual(3);
      expect(scene.npc.role.trim()).not.toBe("");
      expect(scene.npc.wants.trim()).not.toBe("");
      expect(scene.targetPhrases.length).toBeGreaterThanOrEqual(3);
      expect(scene.targetPhrases.length).toBeLessThanOrEqual(5);
      expect(scene.doneCondition.trim()).not.toBe("");
      expect(scene.debrief.trim()).not.toBe("");
      expect(scene).toHaveProperty("backgroundUrl");
    }
  });
});
