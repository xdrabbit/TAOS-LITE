// Fences in the two predict-model bugs that lived undetected for weeks:
// 1. A NUL byte in the trigram key separator made Postgres reject the nightly
//    upsert with 22P05 every night from 7/07 to 7/22.
// 2. The builder's trigram keys didn't match the client engine's space-
//    separated lookups, so trigram predictions never fired at all.
import { describe, expect, it } from "vitest";
import { buildAllModels } from "@/lib/predict/model.mjs";
import { predict } from "@/lib/predict/engine";

const NOW = 1_784_900_000_000; // fixed "now" so recency weights are stable

function rows(texts: string[]): Array<{ original_text: string; created_at: string }> {
  return texts.map((t) => ({ original_text: t, created_at: new Date(NOW).toISOString() }));
}

const SAMPLE = rows([
  "I love you so much my love, see you at home tonight",
  "I love you so much, we are going home",
  "te juro que te quiero mucho mi vida, nos vemos en casa",
  "te juro que todo está bien mi amor, gracias por todo"
]);

describe("predict model artifact", () => {
  it("contains no NUL characters anywhere (Postgres jsonb rejects \\u0000)", () => {
    const models = buildAllModels(SAMPLE, NOW);
    const json = JSON.stringify(models);
    expect(json.includes("\\u0000")).toBe(false);
    expect(json.includes("\u0000")).toBe(false);
  });

  it("keys trigram contexts as two space-separated tokens", () => {
    const models = buildAllModels(SAMPLE, NOW);
    for (const direction of ["en-es", "es-en"] as const) {
      const contexts = Object.keys(models[direction].trigrams);
      expect(contexts.length).toBeGreaterThan(0);
      for (const ctx of contexts) {
        expect(ctx).toMatch(/^\S+ \S+$/);
      }
    }
  });

  it("feeds the client engine: a built model produces trigram next-word predictions", () => {
    const models = buildAllModels(SAMPLE, NOW);
    // Typing "i love " — the engine looks up trigrams["i love"] and must find
    // "you". This is the end-to-end contract between builder and engine that
    // silently broke before: keys written one way, looked up another.
    const p = predict(models["en-es"], "i love ");
    const suggested = [p.ghostText.trim(), ...p.chips.map((c) => c.label)];
    expect(suggested.some((s) => s.startsWith("you"))).toBe(true);
  });
});
