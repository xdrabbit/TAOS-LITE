import { assertTutorLesson, type TutorLesson } from "@/lib/tutor/course";
import { getCourse } from "@/lib/tutor/courses";

const tomSpanishDay1: TutorLesson = {
  id: "tom-spanish-1-day-01",
  courseId: "tom-spanish-1",
  day: 1,
  title: "Want, need, and have",
  communicativeGoal: "Say three useful things about what you want, need, and have.",
  grammarFocus: ["yo + present-tense verb", "no before the verb"],
  vocabularyFocus: ["quiero", "necesito", "tengo", "café", "agua", "ayuda", "tiempo"],
  anchorSentences: [
    { source: "I want coffee.", target: "Yo quiero café." },
    { source: "I need help.", target: "Yo necesito ayuda." },
    { source: "I have time.", target: "Yo tengo tiempo." },
    { source: "I don't have time.", target: "Yo no tengo tiempo." }
  ],
  drills: [
    {
      id: "model-quiero",
      kind: "model",
      instruction: "Listen first. Notice that Spanish can keep the subject and verb together.",
      sourceText: "I want coffee.",
      targetText: "Yo quiero café."
    },
    {
      id: "repeat-quiero",
      kind: "repeat",
      instruction: "Repeat the complete sentence.",
      sourceText: "I want coffee.",
      targetText: "Yo quiero café.",
      reviewAfterDays: [1, 3, 7, 14]
    },
    {
      id: "substitute-drink",
      kind: "substitution",
      instruction: "Keep the frame and change only the drink.",
      sourceText: "I want water.",
      targetText: "Yo quiero agua.",
      substitutions: [
        {
          id: "drink",
          prompt: "Change coffee to water.",
          values: [
            { source: "coffee", target: "café" },
            { source: "water", target: "agua" }
          ]
        }
      ]
    },
    {
      id: "recall-necesito",
      kind: "recall",
      instruction: "Say it in Spanish without looking at the answer first.",
      sourceText: "I need help.",
      targetText: "Yo necesito ayuda.",
      hint: "Yo ne…",
      reviewAfterDays: [1, 3, 7, 14]
    },
    {
      id: "recall-negative",
      kind: "recall",
      instruction: "Put no directly before tengo.",
      sourceText: "I don't have time.",
      targetText: "Yo no tengo tiempo.",
      hint: "Yo no…",
      reviewAfterDays: [1, 3, 7, 14]
    }
  ],
  miniDialogue: [
    { speaker: "teacher", source: "Do you need help?", target: "¿Necesitas ayuda?" },
    { speaker: "learner", source: "Yes, I need help.", target: "Sí, necesito ayuda." },
    { speaker: "teacher", source: "Do you have time?", target: "¿Tienes tiempo?" },
    { speaker: "learner", source: "No, I don't have time.", target: "No, no tengo tiempo." }
  ],
  completion: {
    minimumIndependentRecalls: 2,
    minimumSpokenAttempts: 4
  }
};

const lizEnglishDay1: TutorLesson = {
  id: "liz-english-1-day-01",
  courseId: "liz-english-1",
  day: 1,
  title: "Want, need, and have",
  communicativeGoal: "Decir tres cosas útiles sobre lo que quieres, necesitas y tienes.",
  grammarFocus: ["I + verbo en presente", "don't antes del verbo"],
  vocabularyFocus: ["want", "need", "have", "coffee", "water", "help", "time"],
  anchorSentences: [
    { source: "Yo quiero café.", target: "I want coffee." },
    { source: "Yo necesito ayuda.", target: "I need help." },
    { source: "Yo tengo tiempo.", target: "I have time." },
    { source: "Yo no tengo tiempo.", target: "I don't have time." }
  ],
  drills: [
    {
      id: "model-want",
      kind: "model",
      instruction: "Escucha primero. En inglés se dice el sujeto I antes del verbo.",
      sourceText: "Yo quiero café.",
      targetText: "I want coffee."
    },
    {
      id: "repeat-want",
      kind: "repeat",
      instruction: "Repite la oración completa.",
      sourceText: "Yo quiero café.",
      targetText: "I want coffee.",
      reviewAfterDays: [1, 3, 7, 14]
    },
    {
      id: "substitute-drink",
      kind: "substitution",
      instruction: "Mantén la estructura y cambia solamente la bebida.",
      sourceText: "Yo quiero agua.",
      targetText: "I want water.",
      substitutions: [
        {
          id: "drink",
          prompt: "Cambia coffee por water.",
          values: [
            { source: "café", target: "coffee" },
            { source: "agua", target: "water" }
          ]
        }
      ]
    },
    {
      id: "recall-need",
      kind: "recall",
      instruction: "Dilo en inglés sin mirar primero la respuesta.",
      sourceText: "Yo necesito ayuda.",
      targetText: "I need help.",
      hint: "I ne…",
      reviewAfterDays: [1, 3, 7, 14]
    },
    {
      id: "recall-negative",
      kind: "recall",
      instruction: "Usa don't antes de have.",
      sourceText: "Yo no tengo tiempo.",
      targetText: "I don't have time.",
      hint: "I don't…",
      reviewAfterDays: [1, 3, 7, 14]
    }
  ],
  miniDialogue: [
    { speaker: "teacher", source: "¿Necesitas ayuda?", target: "Do you need help?" },
    { speaker: "learner", source: "Sí, necesito ayuda.", target: "Yes, I need help." },
    { speaker: "teacher", source: "¿Tienes tiempo?", target: "Do you have time?" },
    { speaker: "learner", source: "No, no tengo tiempo.", target: "No, I don't have time." }
  ],
  completion: {
    minimumIndependentRecalls: 2,
    minimumSpokenAttempts: 4
  }
};

export const dayOneLessons = {
  "tom-spanish-1": assertTutorLesson(tomSpanishDay1, getCourse("tom-spanish-1")),
  "liz-english-1": assertTutorLesson(lizEnglishDay1, getCourse("liz-english-1"))
} as const;
