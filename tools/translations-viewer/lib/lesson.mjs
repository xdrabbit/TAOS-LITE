// "Lessons from your own history" — the breakdown half, as a prototype.
//
// Pick a sentence or two you actually said (or heard) and get back:
//   1. the words — gloss, and what each form carries (a subject hidden in the
//      verb, a clitic),
//   2. why they are in THAT order — including the English-order version an
//      English speaker would build, shown as wrong,
//   3. what it means in the conversation it came from,
//   4. build-up chunks from the end of the sentence, for practice later.
//
// Practice itself is not here yet; this exists to judge whether the
// explanations are good before anything else gets built on them.

// gpt-4.1 explained well but marked correct, flexible word orders as mistakes
// ("Tengo unos raviolis ahí" shown as wrong); gpt-5.5 told "wrong" from "just
// different" on the same sentences. Slower (13-25s) — worth it for a lesson.
export const LESSON_MODEL_DEFAULT = "gpt-5.5";

/** Most of the history is Spanish⇄English; anything else is taught the same way. */
const LANGUAGE_NAMES = {
  es: "Spanish",
  en: "English",
  fr: "French",
  it: "Italian",
  pt: "Portuguese",
  de: "German",
  bs: "Bosnian",
  ko: "Korean",
  zh: "Chinese"
};
const languageName = (code) => LANGUAGE_NAMES[code] ?? code ?? "the target language";

/**
 * Which side of a record is the language being learned. The learner is an
 * English speaker, so it's whichever side isn't English — Spanish when a
 * record doesn't say.
 */
export function targetSide(record) {
  if (record.source_lang && record.source_lang !== "en") {
    return { lang: record.source_lang, text: record.original_text, english: record.translation_text };
  }
  if (record.target_lang && record.target_lang !== "en") {
    return { lang: record.target_lang, text: record.translation_text, english: record.original_text };
  }
  return { lang: "es", text: record.translation_text, english: record.original_text };
}

/**
 * JSON schema for OpenAI structured outputs (strict). Every field is required
 * in strict mode, so "nothing to say" is an empty string or empty list.
 */
export const LESSON_SCHEMA = {
  name: "sentence_breakdown",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["target_language", "sentences", "caveats"],
    properties: {
      target_language: { type: "string" },
      caveats: { type: "string" },
      sentences: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "target",
            "as_said",
            "english",
            "words",
            "english_order_trap",
            "order_points",
            "context_meaning",
            "register",
            "chunks"
          ],
          properties: {
            target: { type: "string" },
            as_said: { type: "string" },
            english: { type: "string" },
            words: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["text", "lemma", "gloss", "literal", "role", "note"],
                properties: {
                  text: { type: "string" },
                  lemma: { type: "string" },
                  gloss: { type: "string" },
                  literal: { type: "string" },
                  role: { type: "string" },
                  note: { type: "string" }
                }
              }
            },
            english_order_trap: { type: "string" },
            order_points: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["rule", "explanation", "example"],
                properties: {
                  rule: { type: "string" },
                  explanation: { type: "string" },
                  example: { type: "string" }
                }
              }
            },
            context_meaning: { type: "string" },
            register: { type: "string" },
            chunks: { type: "array", items: { type: "string" } }
          }
        }
      }
    }
  }
};

/**
 * The prompt. Exported so tests can read what the model is being told.
 *
 * @param {object} input
 * @param {string} input.selection  what the learner highlighted (may be empty)
 * @param {Array}  input.records    the record(s) the selection came from
 * @param {Array}  input.context    nearby records from the same conversation
 */
export function buildLessonPrompt({ selection = "", records, context = [] }) {
  const sides = records.map(targetSide);
  const lang = sides[0]?.lang ?? "es";
  const name = languageName(lang);

  const system = [
    `You are a patient ${name} teacher for an adult native English speaker.`,
    `They already understand what their sentences MEAN. Their real problem: they know many of the`,
    `words, but they put them in English order, and ${name} orders them differently. Teach the`,
    `structure so they could produce the sentence themselves.`,
    ``,
    `The sentences come from their own translation app history — real speech captured by`,
    `speech-to-text, so they can contain transcription slips, missing punctuation, or run-ons.`,
    `- "target" is the clean, natural ${name} sentence you will teach. If what was captured is`,
    `  non-standard or garbled, fix it and put the captured text in "as_said"; otherwise`,
    `  "as_said" is an empty string. Never teach an error as correct.`,
    `- Split the material into natural sentences (usually 1-3). If the learner highlighted`,
    `  English, teach the ${name} that corresponds to it.`,
    `- Latin American ${name === "Spanish" ? "Spanish, tú by default" : name} unless the text itself uses something else.`,
    ``,
    `For each sentence:`,
    `- "words": every word of "target" in order. "gloss" is the English meaning here;`,
    `  "role" is short (verb, noun, object pronoun, preposition…); "note" says what the form`,
    `  carries that English spells out separately (e.g. "dije = I said: the 'I' is inside the`,
    `  verb, preterite"), or is empty.`,
    `- each word's "literal": its shortest English stand-in for a word-for-word line,`,
    `  hyphenated when one word carries several ("I-told", "to-you"). The line is assembled`,
    `  from these in ${name} order, so it shows the learner the ${name} order.`,
    `- "english_order_trap": the mistake a real English speaker actually makes here — what`,
    `  comes out when they start from the English sentence and translate it in English order.`,
    `  That is usually NOT a pronoun stranded at the end; it is things like a pronoun placed`,
    `  after the verb ("dije te"), a required word left out because English doesn't need it`,
    `  (the doubled "le" in "le preparo algo a Ana"), "para" where Spanish uses "a", an`,
    `  unnecessary "yo", or an adjective before the noun. It must be something a learner would`,
    `  plausibly say. It must be genuinely WRONG or clearly unnatural — never an alternative`,
    `  word order that native speakers also use (flexible adverbs like "ahí" or "ya" often`,
    `  are). If English order produces acceptable ${name}, leave it empty and say in an`,
    `  order point that the order is flexible here.`,
    `- "order_points": 1-3 rules that explain THIS sentence's order, each with a short second`,
    `  example sentence that uses the same rule. Plain words, no grammar jargon without an`,
    `  explanation.`,
    `- "context_meaning": what it means in the conversation given — tone, intent, anything`,
    `  implied. Two sentences at most.`,
    `- "register": e.g. "tú, casual" or "usted, polite".`,
    `- "chunks": build-up practice from the END of the sentence, growing leftward to the`,
    `  whole sentence (e.g. "ayer" → "dije ayer" → "te lo dije ayer" → "Ya te lo dije ayer").`,
    `  3 to 6 steps: grow by meaningful phrases, not one word at a time, and the last step is`,
    `  always the whole sentence.`,
    `"caveats": only real problems with the source text (a transcription slip you fixed, a`,
    `translation that is wrong). Never claim a correction you did not make; if "as_said" is`,
    `empty everywhere and the translation is fine, "caveats" is an empty string.`,
    `"target_language": the ISO code, "${lang}".`
  ].join("\n");

  const lines = [];
  if (selection.trim()) {
    lines.push(`The learner highlighted:\n"""${selection.trim()}"""`, "");
  }
  lines.push("From this record (what they said, and its translation):");
  records.forEach((r, i) => {
    const s = sides[i];
    lines.push(`${name}: ${s.text}`, `English: ${s.english}`, "");
  });
  if (context.length) {
    lines.push("The conversation around it, oldest first (for context only — do not teach these):");
    for (const r of context) {
      const s = targetSide(r);
      lines.push(`- ${s.text}  |  ${s.english}`);
    }
  }
  return { system, user: lines.join("\n").trim(), lang };
}

/**
 * Validate what came back. Strict mode makes this mostly a formality, but a
 * lesson with no sentences or a sentence with no words is useless to render,
 * so say so rather than show an empty card.
 */
export function parseLesson(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("The lesson came back as something other than JSON.");
  }
  const sentences = Array.isArray(parsed?.sentences) ? parsed.sentences : [];
  const usable = sentences.filter(
    (s) => s && typeof s.target === "string" && s.target.trim() && Array.isArray(s.words) && s.words.length
  );
  if (!usable.length) throw new Error("The lesson came back without any sentences to teach.");
  return {
    target_language: String(parsed.target_language ?? ""),
    caveats: String(parsed.caveats ?? ""),
    sentences: usable.map((s) => {
      const words = s.words.map((w) => ({
        text: String(w.text ?? ""),
        lemma: String(w.lemma ?? ""),
        gloss: String(w.gloss ?? ""),
        literal: String(w.literal ?? ""),
        role: String(w.role ?? ""),
        note: String(w.note ?? "")
      }));
      return {
        target: s.target.trim(),
        as_said: String(s.as_said ?? ""),
        english: String(s.english ?? ""),
        words,
        // Assembled here, not asked for: a model writing the whole line drifts
        // back into English order, which is the one thing this line must not do.
        literal: words.map((w) => w.literal || w.gloss).join(" "),
        ...rest(s)
      };
    })
  };
}

/** Everything after the words; chunks capped so the build-up stays a ladder. */
function rest(s) {
  return {
    english_order_trap: String(s.english_order_trap ?? ""),
    order_points: (Array.isArray(s.order_points) ? s.order_points : []).map((p) => ({
      rule: String(p.rule ?? ""),
      explanation: String(p.explanation ?? ""),
      example: String(p.example ?? "")
    })),
    context_meaning: String(s.context_meaning ?? ""),
    register: String(s.register ?? ""),
    chunks: capChunks((Array.isArray(s.chunks) ? s.chunks : []).map(String))
  };
}

export const MAX_CHUNKS = 6;

/**
 * At most MAX_CHUNKS build-up steps, spread evenly, always ending on the
 * whole sentence (the last step) and starting from the shortest (the first).
 */
export function capChunks(chunks) {
  if (chunks.length <= MAX_CHUNKS) return chunks;
  const last = chunks.length - 1;
  const picked = new Set();
  for (let i = 0; i < MAX_CHUNKS; i += 1) picked.add(Math.round((i * last) / (MAX_CHUNKS - 1)));
  return [...picked].sort((a, b) => a - b).map((i) => chunks[i]);
}

/** Ask OpenAI for the breakdown. Throws a readable Error on any failure. */
export async function generateLesson({ apiKey, model, prompt, fetchImpl = fetch }) {
  const res = await fetchImpl("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      // Reasoning models (gpt-5*, o*) reject a temperature other than the default.
      ...(/^(gpt-5|o\d)/.test(model) ? {} : { temperature: 0.3 }),
      response_format: { type: "json_schema", json_schema: LESSON_SCHEMA },
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user }
      ]
    }),
    // gpt-5.5 took 42s on a three-sentence message; leave room for longer ones.
    signal: AbortSignal.timeout(120_000)
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = payload?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`OpenAI refused the lesson: ${detail}`);
  }
  const content = payload?.choices?.[0]?.message?.content ?? "";
  const refusal = payload?.choices?.[0]?.message?.refusal;
  if (refusal) throw new Error(`The model declined: ${refusal}`);
  return { lesson: parseLesson(content), usage: payload?.usage ?? null };
}
