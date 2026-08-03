"use client";

import { useMemo, useState } from "react";
import type { CourseId, LanguageCode } from "@/lib/tutor/course";

interface StudyWord {
  key: string;
  forms: string[];
  headword: string;
  meaning: string;
  explanation: string;
  variations: Array<{ form: string; meaning: string }>;
  examples: Array<{ target: string; source: string }>;
  prompt: string;
}

const STUDY_WORDS: Record<CourseId, StudyWord[]> = {
  "tom-spanish-1": [
    {
      key: "quiero",
      forms: ["quiero"],
      headword: "querer",
      meaning: "I want",
      explanation: "Quiero is the yo form of querer. Spanish usually leaves yo unstated because the verb ending already identifies the speaker.",
      variations: [
        { form: "quieres", meaning: "you want" },
        { form: "quiere", meaning: "he, she, or you-formal wants" },
        { form: "queremos", meaning: "we want" }
      ],
      examples: [
        { target: "Quiero agua.", source: "I want water." },
        { target: "No quiero café.", source: "I do not want coffee." },
        { target: "¿Quieres comer?", source: "Do you want to eat?" }
      ],
      prompt: "Say: I want to eat."
    },
    {
      key: "quieres",
      forms: ["quieres"],
      headword: "querer",
      meaning: "you want",
      explanation: "Quieres is the tú form of querer. Put ¿...? around it to ask a question without changing the word order.",
      variations: [
        { form: "quiero", meaning: "I want" },
        { form: "quiere", meaning: "he, she, or you-formal wants" },
        { form: "queremos", meaning: "we want" }
      ],
      examples: [
        { target: "¿Quieres café?", source: "Do you want coffee?" },
        { target: "¿Qué quieres?", source: "What do you want?" }
      ],
      prompt: "Ask: Do you want water?"
    },
    {
      key: "necesito",
      forms: ["necesito"],
      headword: "necesitar",
      meaning: "I need",
      explanation: "Necesito is the yo form of necesitar. Unlike English, Spanish does not add do or does to make questions or negatives.",
      variations: [
        { form: "necesitas", meaning: "you need" },
        { form: "necesita", meaning: "he, she, or you-formal needs" },
        { form: "necesitamos", meaning: "we need" }
      ],
      examples: [
        { target: "Necesito ayuda.", source: "I need help." },
        { target: "No necesito agua.", source: "I do not need water." }
      ],
      prompt: "Say: I need help now."
    },
    {
      key: "tengo",
      forms: ["tengo"],
      headword: "tener",
      meaning: "I have",
      explanation: "Tengo is the irregular yo form of tener. It is also used in many expressions where English uses be, such as tengo hambre, I am hungry.",
      variations: [
        { form: "tienes", meaning: "you have" },
        { form: "tiene", meaning: "he, she, or you-formal has" },
        { form: "tenemos", meaning: "we have" }
      ],
      examples: [
        { target: "Tengo tiempo.", source: "I have time." },
        { target: "Tengo hambre.", source: "I am hungry." }
      ],
      prompt: "Say: I have time today."
    },
    {
      key: "tenemos",
      forms: ["tenemos"],
      headword: "tener",
      meaning: "we have",
      explanation: "Tenemos is the nosotros form of tener. The ending -emos marks we for this verb.",
      variations: [
        { form: "tengo", meaning: "I have" },
        { form: "tienes", meaning: "you have" },
        { form: "tienen", meaning: "they or you-plural have" }
      ],
      examples: [{ target: "Tenemos tiempo hoy.", source: "We have time today." }],
      prompt: "Say: We have time tomorrow."
    },
    {
      key: "voy",
      forms: ["voy"],
      headword: "ir",
      meaning: "I go / I am going",
      explanation: "Voy is the irregular yo form of ir. Voy a plus an infinitive is a common near-future pattern: I am going to do something.",
      variations: [
        { form: "vas", meaning: "you go / are going" },
        { form: "va", meaning: "he, she, or you-formal goes" },
        { form: "vamos", meaning: "we go / are going" }
      ],
      examples: [
        { target: "Voy a casa.", source: "I am going home." },
        { target: "Voy a comer.", source: "I am going to eat." }
      ],
      prompt: "Say: I am going home later."
    },
    {
      key: "gusta",
      forms: ["gusta"],
      headword: "gustar",
      meaning: "is pleasing / like",
      explanation: "Me gusta literally works more like it is pleasing to me. The thing liked controls gusta or gustan, not the person who likes it.",
      variations: [
        { form: "me gusta", meaning: "I like one thing or an action" },
        { form: "me gustan", meaning: "I like plural things" },
        { form: "te gusta", meaning: "you like" }
      ],
      examples: [
        { target: "Me gusta el pescado.", source: "I like fish." },
        { target: "Me gustan las manzanas.", source: "I like apples." }
      ],
      prompt: "Say something you like."
    },
    {
      key: "hoy",
      forms: ["hoy"],
      headword: "hoy",
      meaning: "today",
      explanation: "Hoy is a time word. It often appears at the beginning or end of a sentence without changing the basic grammar.",
      variations: [
        { form: "mañana", meaning: "tomorrow or morning" },
        { form: "ahora", meaning: "now" },
        { form: "después", meaning: "later / afterward" }
      ],
      examples: [{ target: "Tenemos tiempo hoy.", source: "We have time today." }],
      prompt: "Change today to tomorrow."
    },
    {
      key: "mañana",
      forms: ["mañana"],
      headword: "mañana",
      meaning: "tomorrow / morning",
      explanation: "Context decides whether mañana means tomorrow or morning. La mañana means the morning; mañana without an article often means tomorrow.",
      variations: [
        { form: "esta mañana", meaning: "this morning" },
        { form: "mañana", meaning: "tomorrow" },
        { form: "por la mañana", meaning: "in the morning" }
      ],
      examples: [{ target: "Trabajo mañana.", source: "I work tomorrow." }],
      prompt: "Say: We have time tomorrow."
    }
  ],
  "liz-english-1": [
    {
      key: "want",
      forms: ["want", "wants"],
      headword: "want",
      meaning: "querer",
      explanation: "Use want with I, you, we, and they. Add -s for he, she, or it. Questions and negatives usually use do or does.",
      variations: [
        { form: "I want", meaning: "yo quiero" },
        { form: "she wants", meaning: "ella quiere" },
        { form: "do you want?", meaning: "¿quieres?" }
      ],
      examples: [
        { target: "I want water.", source: "Quiero agua." },
        { target: "Do you want coffee?", source: "¿Quieres café?" }
      ],
      prompt: "Di en inglés: Quiero comer."
    },
    {
      key: "need",
      forms: ["need", "needs"],
      headword: "need",
      meaning: "necesitar",
      explanation: "Use need with I, you, we, and they. Use needs with he, she, or it. Use do not or does not for negatives.",
      variations: [
        { form: "I need", meaning: "yo necesito" },
        { form: "she needs", meaning: "ella necesita" },
        { form: "do you need?", meaning: "¿necesitas?" }
      ],
      examples: [{ target: "I need help now.", source: "Necesito ayuda ahora." }],
      prompt: "Di en inglés: Necesito agua."
    },
    {
      key: "have",
      forms: ["have", "has"],
      headword: "have",
      meaning: "tener",
      explanation: "Use have with I, you, we, and they. Use has with he, she, or it.",
      variations: [
        { form: "I have", meaning: "yo tengo" },
        { form: "she has", meaning: "ella tiene" },
        { form: "we have", meaning: "nosotros tenemos" }
      ],
      examples: [{ target: "We have time today.", source: "Tenemos tiempo hoy." }],
      prompt: "Di en inglés: Tengo tiempo."
    },
    {
      key: "going",
      forms: ["go", "going"],
      headword: "go",
      meaning: "ir",
      explanation: "I am going describes movement happening now or a plan. Going to plus a verb is a common future pattern.",
      variations: [
        { form: "I go", meaning: "yo voy habitualmente" },
        { form: "I am going", meaning: "voy / estoy yendo" },
        { form: "I am going to eat", meaning: "voy a comer" }
      ],
      examples: [{ target: "I am going home later.", source: "Voy a casa después." }],
      prompt: "Di en inglés: Voy a comer."
    },
    {
      key: "like",
      forms: ["like", "likes"],
      headword: "like",
      meaning: "gustar",
      explanation: "English puts the person who likes something first: I like fish. Add -s for he, she, or it: She likes fish.",
      variations: [
        { form: "I like", meaning: "me gusta" },
        { form: "she likes", meaning: "a ella le gusta" },
        { form: "do you like?", meaning: "¿te gusta?" }
      ],
      examples: [{ target: "I like fish.", source: "Me gusta el pescado." }],
      prompt: "Di en inglés algo que te gusta."
    },
    {
      key: "today",
      forms: ["today"],
      headword: "today",
      meaning: "hoy",
      explanation: "Today can go near the beginning or end of a sentence: Today we have time. We have time today.",
      variations: [
        { form: "tomorrow", meaning: "mañana" },
        { form: "now", meaning: "ahora" },
        { form: "later", meaning: "después / más tarde" }
      ],
      examples: [{ target: "We have time today.", source: "Tenemos tiempo hoy." }],
      prompt: "Cambia today por tomorrow."
    },
    {
      key: "tomorrow",
      forms: ["tomorrow"],
      headword: "tomorrow",
      meaning: "mañana",
      explanation: "Tomorrow refers only to the next day. English uses morning for la mañana.",
      variations: [
        { form: "tomorrow", meaning: "mañana, el día siguiente" },
        { form: "morning", meaning: "la mañana" },
        { form: "tomorrow morning", meaning: "mañana por la mañana" }
      ],
      examples: [{ target: "I work tomorrow.", source: "Trabajo mañana." }],
      prompt: "Di en inglés: Tenemos tiempo mañana."
    }
  ]
};

function normalizeToken(value: string): string {
  return value.toLocaleLowerCase().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
}

function wordsFor(courseId: CourseId): Map<string, StudyWord> {
  const map = new Map<string, StudyWord>();
  for (const entry of STUDY_WORDS[courseId]) {
    for (const form of entry.forms) map.set(normalizeToken(form), entry);
  }
  return map;
}

export function TutorStudyText({
  text,
  courseId,
  targetLanguage,
  className
}: {
  text: string;
  courseId: CourseId;
  targetLanguage: LanguageCode;
  className?: string;
}): JSX.Element {
  const [selected, setSelected] = useState<StudyWord | null>(null);
  const entries = useMemo(() => wordsFor(courseId), [courseId]);
  const pieces = text.split(/(\s+)/);

  async function hear(value: string, slow = false) {
    try {
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: value,
          engine: "openai",
          targetLanguage,
          instructions: slow ? "Speak slowly and clearly for a beginning language learner." : undefined
        })
      });
      if (!response.ok) return;
      const url = URL.createObjectURL(await response.blob());
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
    } catch {
      // The study card remains useful without audio.
    }
  }

  return (
    <>
      <div className={className}>
        {pieces.map((piece, index) => {
          if (/^\s+$/.test(piece)) return <span key={index}>{piece}</span>;
          const entry = entries.get(normalizeToken(piece));
          if (!entry) return <span key={index}>{piece}</span>;
          return (
            <button
              key={index}
              type="button"
              onClick={() => setSelected(entry)}
              className="rounded-md border-b border-dotted border-amber-300/70 px-0.5 text-inherit underline decoration-amber-300/60 decoration-dotted underline-offset-4"
              aria-label={`Study ${piece}`}
            >
              {piece}
            </button>
          );
        })}
      </div>

      {selected ? (
        <section className="mt-4 rounded-3xl border border-amber-300/25 bg-[rgba(38,30,19,0.98)] p-4 text-left shadow-2xl">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.16em] text-amber-200/55">Study word</p>
              <h3 className="mt-1 text-2xl font-semibold text-white">{selected.forms[0]}</h3>
              <p className="text-sm text-amber-100/65">{selected.headword} · {selected.meaning}</p>
            </div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="rounded-full border border-white/10 px-3 py-1 text-sm text-amber-100/70"
              aria-label="Close study word"
            >
              Close
            </button>
          </div>

          <p className="mt-4 text-sm leading-relaxed text-amber-50/75">{selected.explanation}</p>

          <div className="mt-4 flex gap-2">
            <button type="button" onClick={() => void hear(selected.forms[0])} className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-sm text-emerald-100">
              🔊 Hear
            </button>
            <button type="button" onClick={() => void hear(selected.forms[0], true)} className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-sm text-emerald-100">
              🐢 Slow
            </button>
          </div>

          <div className="mt-4 grid gap-2">
            {selected.variations.map((item) => (
              <div key={item.form} className="flex items-baseline justify-between gap-3 rounded-2xl bg-white/5 px-3 py-2">
                <strong className="text-white">{item.form}</strong>
                <span className="text-right text-sm text-amber-100/60">{item.meaning}</span>
              </div>
            ))}
          </div>

          <div className="mt-4 space-y-2">
            {selected.examples.map((example) => (
              <div key={example.target} className="rounded-2xl border border-white/10 p-3">
                <p className="text-base text-white">{example.target}</p>
                <p className="mt-1 text-sm text-amber-100/55">{example.source}</p>
              </div>
            ))}
          </div>

          <p className="mt-4 rounded-2xl bg-amber-300/10 p-3 text-sm text-amber-100">
            <span className="font-semibold">Try it:</span> {selected.prompt}
          </p>
        </section>
      ) : null}
    </>
  );
}
