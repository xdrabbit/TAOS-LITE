// Study: a lesson from a sentence you actually said.
//
// A port of tools/translations-viewer/lib/lesson.mjs, the prototype that
// proved the explanations were good before anything was built on them. The
// prompt text is kept as close to byte-identical as TypeScript allows, because
// it was hardened by a stress run (ENHANCEMENTS.md, 2026-09-26) and a reworded
// prompt is an untested prompt.
//
// What a lesson is: for one or two sentences the learner picked out of their
// own history,
//   1. the words — gloss, and what each form carries,
//   2. why they are in THAT order — including the version an explain-language
//      speaker would build, shown as wrong,
//   3. what it meant in the conversation it came from,
//   4. build-up chunks from the end of the sentence, for saying out loud.
//
// Server-only: imports node:crypto for the lesson key and talks to OpenAI.
// The screen types a lesson through lib/study/types.ts instead.

import { createHash } from "node:crypto";
import type { StudyLesson, StudySentence, StudySource, StudyWord } from "./types";

// gpt-4.1 explained well but marked correct, flexible word orders as mistakes
// ("Tengo unos raviolis ahí" shown as wrong); gpt-5.5 told "wrong" from "just
// different" on the same sentences. Slower (13-25s) — worth it for a lesson.
export const STUDY_LESSON_MODEL_DEFAULT = "gpt-5.5";

/** "es" → "Spanish". Intl knows every code the catalog uses; the code itself is the fallback. */
export function languageName(code: string | null | undefined): string {
  if (!code) return "the target language";
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) || code;
  } catch {
    return code;
  }
}

export interface Side {
  lang: string;
  text: string;
  other: string;
  otherLang: string;
}

/**
 * The side of a record in the language being learned, and the other side.
 *
 * With `target`, it's the side in that language, or null when the record has
 * none (asking to learn Italian from an English⇄Spanish message). Without
 * one, the original assumption holds: the learner speaks English, so it's
 * whichever side isn't English — Spanish when a record doesn't say.
 */
export function targetSide(record: StudySource, target: string | null = null): Side | null {
  const original = { lang: record.source_lang, text: record.original_text };
  const translation = { lang: record.target_lang, text: record.translation_text };
  const pair = (a: { lang: string; text: string }, b: { lang: string; text: string }): Side => ({
    lang: a.lang,
    text: a.text,
    other: b.text,
    otherLang: b.lang
  });
  if (target) {
    if (original.lang === target) return pair(original, translation);
    if (translation.lang === target) return pair(translation, original);
    return null;
  }
  if (original.lang && original.lang !== "en") return pair(original, translation);
  if (translation.lang && translation.lang !== "en") return pair(translation, original);
  return pair({ lang: "es", text: translation.text }, { lang: original.lang ?? "en", text: original.text });
}

/** Every language that appears on any of these records. */
export function languagesIn(records: StudySource[]): string[] {
  return [...new Set(records.flatMap((r) => [r.source_lang, r.target_lang]).filter(Boolean))];
}

interface Hints {
  variety: string;
  colloquial: string;
  trap: string;
  flexible: string;
  register: string;
  regional: string;
}

/**
 * Direction-specific teaching hints. The mistakes worth showing depend on
 * which way the learner is crossing: an English speaker writes "dije te", a
 * Spanish speaker writes "Is raining". Anything without a tailored entry gets
 * the generic description, which gpt-5.5 handles well enough.
 */
function directionHints(target: string, explain: string): Hints {
  const t = languageName(target);
  const x = languageName(explain);
  if (target === "es") {
    return {
      variety: "Latin American Spanish, tú by default",
      colloquial: `("le dije que si quería venir" for "I asked her if she wanted to come" is normal spoken Spanish)`,
      trap:
        explain === "en"
          ? `That is usually NOT a pronoun stranded at the end; it is things like a pronoun placed after the verb ("dije te"), a required word left out because English doesn't need it (the doubled "le" in "le preparo algo a Ana"), "para" where Spanish uses "a", an unnecessary "yo", or an adjective before the noun.`
          : `Typical: a pronoun in the wrong place, a word Spanish requires that ${x} leaves out (or the reverse), a literal calque from ${x}.`,
      flexible: `(flexible adverbs like "ahí" or "ya" often are)`,
      register: `e.g. "tú, casual" or "usted, polite"`,
      regional: `(e.g. Venezuelan "arrecho" = angry, but vulgar in Mexico)`
    };
  }
  if (target === "en") {
    return {
      variety: "American English",
      colloquial: `("gonna", "I was like…", "you guys" are normal spoken English)`,
      trap:
        explain === "es"
          ? `For a Spanish speaker that is things like a dropped subject ("Is raining" for "It's raining"), an adjective after the noun ("the car red"), "have" for age ("I have 30 years"), a question without "do" ("You want coffee?"), "the" before a general noun ("The life is hard"), or a double negative ("I don't want nothing").`
          : `Typical: a missing subject or "do", an adjective after the noun, a literal calque from ${x}.`,
      flexible: `(adverbs like "really" or "already" often move)`,
      register: `e.g. "casual", "neutral", "formal"`,
      regional: `(e.g. "pants" means underwear in the UK)`
    };
  }
  return {
    variety: `natural, widely understood ${t}`,
    colloquial: `(keep everyday spoken ${t} as people really say it)`,
    trap: `Typical: a word placed where ${x} would put it, a word ${t} requires that ${x} leaves out (or the reverse), a literal calque from ${x}.`,
    flexible: `(some adverbs and particles move freely)`,
    register: `e.g. "casual", "neutral", "formal"`,
    regional: `(words that are rude, or mean something else, in another ${t}-speaking place)`
  };
}

/** The strict JSON schema the model must answer in. */
export const STUDY_LESSON_SCHEMA = {
  name: "study_lesson",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["target_language", "caveats", "sentences"],
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
} as const;

export interface StudyPrompt {
  system: string;
  user: string;
  lang: string;
  explain: string;
}

/**
 * The prompt. Exported so tests can read what the model is being told.
 *
 * `selection` is what the learner highlighted (may be empty); `records` are the
 * row(s) it came from; `context` is the conversation around them, oldest first,
 * for meaning only — never taught.
 */
export function buildStudyPrompt({
  selection = "",
  records,
  context = [],
  target = null,
  explain = "en"
}: {
  selection?: string;
  records: StudySource[];
  context?: StudySource[];
  target?: string | null;
  explain?: string;
}): StudyPrompt {
  const sides = records.map((r) => targetSide(r, target) ?? (targetSide(r) as Side));
  const lang = target ?? sides[0]?.lang ?? "es";
  const name = languageName(lang);
  const x = languageName(explain);
  const h = directionHints(lang, explain);

  const system = [
    `You are a patient ${name} teacher for an adult native ${x} speaker.`,
    `They already understand what their sentences MEAN. Their real problem: they know many of the`,
    `words, but they put them in ${x} order, and ${name} orders them differently. Teach the`,
    `structure so they could produce the sentence themselves.`,
    ``,
    `LANGUAGES: teach ${name}; WRITE THE LESSON IN ${x.toUpperCase()}. Every explanation — each`,
    `word's "gloss", "literal", "role" and "note", the rules and their explanations,`,
    `"context_meaning", "register", "caveats", and the "english" field (which holds the`,
    `sentence's meaning, in ${x}) — is in ${x}. Only "target", "as_said",`,
    `"english_order_trap", the "chunks" and each rule's "example" are in ${name}.`,
    ``,
    `The sentences come from their own translation app history — real speech captured by`,
    `speech-to-text, so they can contain transcription slips, missing punctuation, or run-ons.`,
    `- "target" is the clean, natural ${name} sentence you will teach. Fix only real slips —`,
    `  transcription mistakes (a wrong homophone, a garbled word), missing accents and`,
    `  punctuation — and put the captured text in "as_said"; otherwise "as_said" is an empty`,
    `  string. Never teach an error as correct. But everyday COLLOQUIAL speech is not an`,
    `  error: keep how people really talk ${h.colloquial} and explain it, rather than rewriting it`,
    `  into textbook phrasing the speaker didn't use.`,
    `  Adding a capital letter or a final period alone is not worth reporting: leave "as_said"`,
    `  empty and don't mention it in "caveats".`,
    `- Split the material into natural sentences (usually 1-3). If the learner highlighted`,
    `  the other language, teach the ${name} that corresponds to it.`,
    `- ${h.variety}, unless the text itself uses something else.`,
    ``,
    `For each sentence:`,
    `- "words": every word of "target" in order. "gloss" is its meaning here, in ${x};`,
    `  "role" is short (verb, noun, pronoun, preposition…, in ${x}); "note" says what the form`,
    `  carries that ${x} would spell out separately, or where it differs from ${x}, or is empty.`,
    `- each word's "literal": its shortest ${x} stand-in for a word-for-word line, hyphenated`,
    `  when one word carries several. The line is assembled from these in ${name} order, so it`,
    `  shows the learner the ${name} order.`,
    `- "english_order_trap": the mistake a real ${x} speaker actually makes here — what comes`,
    `  out when they start from the ${x} sentence and translate it in ${x} order. ${h.trap}`,
    `  It must be something a learner would plausibly say. Only the sentence itself — no`,
    `  commentary, quotes or explanation (that belongs in "order_points"). It must be genuinely`,
    `  WRONG or clearly unnatural — never an alternative word order that native speakers also`,
    `  use ${h.flexible}. If ${x} order produces acceptable ${name}, leave it empty and say in an`,
    `  order point that the order is flexible here.`,
    `- "order_points": 1-3 rules that explain THIS sentence's order, each with a short second`,
    `  ${name} example sentence that uses the same rule. Plain words, no grammar jargon without an`,
    `  explanation.`,
    `- "context_meaning": what it means in the conversation given — tone, intent, anything`,
    `  implied. Two sentences at most.`,
    `- "register": ${h.register}.`,
    `- "chunks": build-up practice from the END of the sentence, growing leftward to the`,
    `  whole sentence. At most 6 steps: grow by meaningful phrases, not one word at a time, and`,
    `  the last step is always the whole sentence. A sentence of three words or fewer needs`,
    `  just 1-2 steps.`,
    `- In a word's "note", warn when a word or phrase means something different, or is rude`,
    `  or vulgar, in other ${name}-speaking countries ${h.regional} — a learner needs to know`,
    `  before using it elsewhere.`,
    `"caveats": only real problems with the source text (a transcription slip you fixed, a`,
    `translation that is wrong). Never claim a correction you did not make; if "as_said" is`,
    `empty everywhere and the translation is fine, "caveats" is an empty string.`,
    `"target_language": the ISO code, "${lang}".`
  ].join("\n");

  const lines: string[] = [];
  if (selection.trim()) {
    lines.push(`The learner highlighted:\n"""${selection.trim()}"""`, "");
  }
  lines.push("From this record (what was said, and its translation):");
  records.forEach((r, i) => {
    const s = sides[i];
    lines.push(`${languageName(s.lang)}: ${s.text}`, `${languageName(s.otherLang ?? "en")}: ${s.other}`, "");
  });
  if (context.length) {
    lines.push("The conversation around it, oldest first (for context only — do not teach these):");
    for (const r of context) {
      const s = targetSide(r, lang) ?? (targetSide(r) as Side);
      lines.push(`- ${s.text}  |  ${s.other}`);
    }
  }
  return { system, user: lines.join("\n").trim(), lang, explain };
}

export class StudyLessonParseError extends Error {}

/**
 * The struck-through "English order" line must be just a sentence. Told so,
 * the model still sometimes appends commentary ("… — English pushes you
 * toward…") or wraps it in quotes; that reads as a crossed-out explanation.
 */
export function cleanTrap(value: unknown): string {
  let t = String(value ?? "").trim();
  t = t.split(/\s[—–]\s|\s-\s(?=[A-Z])/)[0].trim(); // drop " — commentary"
  t = t.replace(/^[“"'‘*]+|[”"'’]+$/g, "").trim(); // drop wrapping quotes / a leading "*"
  return t;
}

export const MAX_CHUNKS = 6;

/**
 * At most MAX_CHUNKS build-up steps, spread evenly, always ending on the
 * whole sentence (the last step) and starting from the shortest (the first).
 */
export function capChunks(chunks: string[]): string[] {
  if (chunks.length <= MAX_CHUNKS) return chunks;
  const last = chunks.length - 1;
  const picked = new Set<number>();
  for (let i = 0; i < MAX_CHUNKS; i += 1) picked.add(Math.round((i * last) / (MAX_CHUNKS - 1)));
  return [...picked].sort((a, b) => a - b).map((i) => chunks[i]);
}

type Raw = Record<string, unknown>;
const rec = (v: unknown): Raw => (v && typeof v === "object" ? (v as Raw) : {});
const str = (v: unknown): string => String(v ?? "");

/**
 * Validate what came back. Strict mode makes this mostly a formality, but a
 * lesson with no sentences or a sentence with no words is useless to render,
 * so say so rather than show an empty card.
 */
export function parseStudyLesson(content: string, explain: string): StudyLesson {
  let parsed: Raw;
  try {
    parsed = rec(JSON.parse(content));
  } catch {
    throw new StudyLessonParseError("The lesson came back as something other than JSON.");
  }
  const sentences = Array.isArray(parsed.sentences) ? (parsed.sentences as unknown[]) : [];
  const usable = sentences
    .map(rec)
    .filter((s) => typeof s.target === "string" && s.target.trim() && Array.isArray(s.words) && s.words.length);
  if (!usable.length) throw new StudyLessonParseError("The lesson came back without any sentences to teach.");

  return {
    target_language: str(parsed.target_language),
    explain_language: explain,
    caveats: str(parsed.caveats),
    sentences: usable.map((s): StudySentence => {
      const words: StudyWord[] = (s.words as unknown[]).map(rec).map((w) => ({
        text: str(w.text),
        lemma: str(w.lemma),
        gloss: str(w.gloss),
        literal: str(w.literal),
        role: str(w.role),
        note: str(w.note)
      }));
      return {
        target: str(s.target).trim(),
        as_said: str(s.as_said),
        english: str(s.english),
        words,
        // Assembled here, not asked for: a model writing the whole line drifts
        // back into English order, which is the one thing this line must not do.
        literal: words.map((w) => w.literal || w.gloss).join(" "),
        english_order_trap: cleanTrap(s.english_order_trap),
        order_points: (Array.isArray(s.order_points) ? (s.order_points as unknown[]) : []).map(rec).map((p) => ({
          rule: str(p.rule),
          explanation: str(p.explanation),
          example: str(p.example)
        })),
        context_meaning: str(s.context_meaning),
        register: str(s.register),
        chunks: capChunks((Array.isArray(s.chunks) ? (s.chunks as unknown[]) : []).map(String))
      };
    })
  };
}

/**
 * The key a lesson is saved under: its source row ids (sorted, so order of
 * selection doesn't matter), the exact selection, and the language pair. The
 * same line explained in the other direction is a different lesson.
 */
export function studyLessonKey(sourceIds: string[], selection: string, target: string, explain: string): string {
  const parts = [[...sourceIds].sort(), String(selection).trim(), `${target}>${explain}`];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

export interface Generated {
  lesson: StudyLesson;
  usage: { prompt_tokens?: number; completion_tokens?: number } | null;
}

/** Ask OpenAI for the breakdown. Throws a readable Error on any failure. */
export async function generateStudyLesson({
  apiKey,
  model,
  prompt,
  fetchImpl = fetch
}: {
  apiKey: string;
  model: string;
  prompt: StudyPrompt;
  fetchImpl?: typeof fetch;
}): Promise<Generated> {
  const res = await fetchImpl("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      // Reasoning models (gpt-5*, o*) reject a temperature other than the default.
      ...(/^(gpt-5|o\d)/.test(model) ? {} : { temperature: 0.3 }),
      response_format: { type: "json_schema", json_schema: STUDY_LESSON_SCHEMA },
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user }
      ]
    }),
    cache: "no-store",
    // gpt-5.5 took 42s on a three-sentence message; leave room for longer ones.
    signal: AbortSignal.timeout(120_000)
  });
  const payload = rec(await res.json().catch(() => null));
  if (!res.ok) {
    const detail = str(rec(payload.error).message) || `HTTP ${res.status}`;
    throw new Error(`OpenAI refused the lesson: ${detail}`);
  }
  const first = rec((Array.isArray(payload.choices) ? payload.choices : [])[0]);
  const message = rec(first.message);
  if (message.refusal) throw new Error(`The model declined: ${str(message.refusal)}`);
  const content = typeof message.content === "string" ? message.content : "";
  return { lesson: parseStudyLesson(content, prompt.explain), usage: (payload.usage as Generated["usage"]) ?? null };
}
