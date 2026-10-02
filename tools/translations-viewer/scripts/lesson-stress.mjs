#!/usr/bin/env node
// Re-run the lesson stress cases against a model and print what to eyeball.
//
//   node tools/translations-viewer/scripts/lesson-stress.mjs [model]
//
// Every sentence here is WRITTEN FOR THE TEST, not taken from the history:
// testing should never ship someone's real messages to a provider. Each case
// is a pattern that broke, or might break, a lesson (2026-09-26 run):
// run-on speech-to-text, Venezuelan slang, a homophone slip, a bad
// translation, English as the source, gustar, subjunctive, clitic pairs, a
// one-word reply, colloquial "que qué", regional/vulgar words, Italian.
// Costs a few cents per case. Not part of the test suite (it calls OpenAI).

import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildLessonPrompt, generateLesson, LESSON_MODEL_DEFAULT } from "../lib/lesson.mjs";
import { readDotEnv } from "../lib/live.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = await readDotEnv(path.resolve(HERE, "../../../.env.local"));
const apiKey = process.env.OPENAI_API_KEY || env.OPENAI_API_KEY;
const model = process.argv[2] || LESSON_MODEL_DEFAULT;
if (!apiKey) {
  console.error("No OPENAI_API_KEY");
  process.exit(1);
}

const es = (o, t) => ({ source_lang: "es", target_lang: "en", original_text: o, translation_text: t });
const CASES = {
  runon: es(
    "fuimos a la playa y estaba lindo pero despues empezo a llover y nos tuvimos que ir",
    "we went to the beach and it was nice but then it started to rain and we had to leave"
  ),
  colloquial: es(
    "mi mamá me preguntó que qué quería comer y yo le dije que lo que sea",
    "my mom asked me what I wanted to eat and I told her whatever"
  ),
  slang: es("Chamo, qué fino, ese pana está burda de arrecho con el jefe", "Dude, how cool, that buddy is super angry with the boss"),
  regional: es("Voy a coger el autobús para llegar más rápido", "I am going to take the bus to get there faster"),
  asr_slip: es("Hecho de menos a mi mamá, hace mucho que no la veo", "I miss my mom, I havent seen her in a long time"),
  bad_translation: es("Me da pena decirte esto", "It gives me pain to tell you this"),
  english_source: {
    source_lang: "en",
    target_lang: "es",
    original_text: "Can you pick me up at the airport tomorrow morning?",
    translation_text: "¿Me puedes recoger en el aeropuerto mañana por la mañana?"
  },
  gustar: es("Me gustan mucho tus ojos", "I really like your eyes"),
  subjunctive: es("Espero que te sientas mejor pronto", "I hope you feel better soon"),
  clitic_pair: es("¿Me lo puedes explicar otra vez?", "Can you explain it to me again?"),
  tiny: es("Ya voy.", "I am coming."),
  trivial_fix: es("Ojalá que no llueva mañana", "I hope it does not rain tomorrow"),
  italian: { source_lang: "it", target_lang: "en", original_text: "Ci vediamo domani alle otto", translation_text: "See you tomorrow at eight" }
};

console.log(`model: ${model}, ${Object.keys(CASES).length} cases\n`);
const results = await Promise.all(
  Object.entries(CASES).map(async ([name, rec]) => {
    const started = Date.now();
    try {
      const { lesson, usage } = await generateLesson({ apiKey, model, prompt: buildLessonPrompt({ records: [rec] }) });
      return { name, ms: Date.now() - started, usage, lesson };
    } catch (err) {
      return { name, ms: Date.now() - started, error: err.message };
    }
  })
);

for (const r of results) {
  console.log(`### ${r.name}  ${r.ms}ms${r.usage ? `  ${r.usage.prompt_tokens}+${r.usage.completion_tokens} tok` : ""}`);
  if (r.error) {
    console.log(`  ERROR ${r.error}\n`);
    continue;
  }
  if (r.lesson.caveats) console.log(`  caveats: ${r.lesson.caveats}`);
  for (const s of r.lesson.sentences) {
    console.log(`  ${s.target}${s.as_said ? `   [as said: ${s.as_said}]` : ""}`);
    console.log(`    literal: ${s.literal}`);
    console.log(`    trap:    ${s.english_order_trap || "(none)"}   ← must be genuinely wrong, no commentary`);
    for (const p of s.order_points) console.log(`    rule:    ${p.rule}`);
    for (const w of s.words.filter((w) => /vulgar|rude|other countr|region/i.test(w.note))) {
      console.log(`    warn:    ${w.text}: ${w.note}`);
    }
    console.log(`    chunks:  ${s.chunks.length}  (≤6; 1-2 for tiny sentences)`);
  }
  console.log("");
}
