import { assertTutorLesson, type TutorLesson } from "@/lib/tutor/course";
import { getCourse } from "@/lib/tutor/courses";

const tom: TutorLesson = {
  id: "tom-spanish-1-day-08", courseId: "tom-spanish-1", day: 8,
  title: "Shopping, money, and numbers",
  communicativeGoal: "Ask a price, understand small numbers, and buy one item.",
  grammarFocus: ["¿cuánto cuesta?", "quiero comprar", "numbers 1-10"],
  vocabularyFocus: ["cuánto", "cuesta", "comprar", "uno", "dos", "tres", "cinco", "diez", "dólares"],
  anchorSentences: [
    { source: "How much does it cost?", target: "¿Cuánto cuesta?" },
    { source: "It costs five dollars.", target: "Cuesta cinco dólares." },
    { source: "I want to buy this.", target: "Quiero comprar esto." },
    { source: "I need two.", target: "Necesito dos." },
    { source: "Do you have three?", target: "¿Tienes tres?" }
  ],
  drills: [
    { id: "model-price", kind: "model", instruction: "Listen to the whole price question.", sourceText: "How much does it cost?", targetText: "¿Cuánto cuesta?" },
    { id: "repeat-five", kind: "repeat", instruction: "Repeat the complete price.", sourceText: "It costs five dollars.", targetText: "Cuesta cinco dólares.", reviewAfterDays: [1, 3, 7, 14] },
    { id: "substitute-number", kind: "substitution", instruction: "Keep necesito and change only the number.", sourceText: "I need two.", targetText: "Necesito dos.", substitutions: [{ id: "number", prompt: "Change two to three.", values: [{ source: "two", target: "dos" }, { source: "three", target: "tres" }] }] },
    { id: "recall-buy", kind: "recall", instruction: "Say that you want to buy this.", sourceText: "I want to buy this.", targetText: "Quiero comprar esto.", hint: "Quiero comprar…", reviewAfterDays: [1, 3, 7, 14] },
    { id: "recall-three", kind: "recall", instruction: "Ask whether the person has three.", sourceText: "Do you have three?", targetText: "¿Tienes tres?", hint: "¿Tienes…?", reviewAfterDays: [1, 3, 7, 14] }
  ],
  miniDialogue: [
    { speaker: "teacher", source: "How much does it cost?", target: "¿Cuánto cuesta?" },
    { speaker: "learner", source: "It costs five dollars.", target: "Cuesta cinco dólares." },
    { speaker: "teacher", source: "Do you want to buy it?", target: "¿Quieres comprarlo?" },
    { speaker: "learner", source: "Yes, I want to buy it.", target: "Sí, quiero comprarlo." }
  ],
  completion: { minimumIndependentRecalls: 2, minimumSpokenAttempts: 4 }
};

const liz: TutorLesson = {
  id: "liz-english-1-day-08", courseId: "liz-english-1", day: 8,
  title: "Shopping, money, and numbers",
  communicativeGoal: "Preguntar un precio, entender números pequeños y comprar un artículo.",
  grammarFocus: ["How much is it?", "I want to buy", "numbers 1-10"],
  vocabularyFocus: ["how much", "cost", "buy", "one", "two", "three", "five", "ten", "dollars"],
  anchorSentences: [
    { source: "¿Cuánto cuesta?", target: "How much does it cost?" },
    { source: "Cuesta cinco dólares.", target: "It costs five dollars." },
    { source: "Quiero comprar esto.", target: "I want to buy this." },
    { source: "Necesito dos.", target: "I need two." },
    { source: "¿Tienes tres?", target: "Do you have three?" }
  ],
  drills: [
    { id: "model-price", kind: "model", instruction: "Escucha la pregunta completa del precio.", sourceText: "¿Cuánto cuesta?", targetText: "How much does it cost?" },
    { id: "repeat-five", kind: "repeat", instruction: "Repite el precio completo.", sourceText: "Cuesta cinco dólares.", targetText: "It costs five dollars.", reviewAfterDays: [1, 3, 7, 14] },
    { id: "substitute-number", kind: "substitution", instruction: "Mantén I need y cambia solamente el número.", sourceText: "Necesito dos.", targetText: "I need two.", substitutions: [{ id: "number", prompt: "Cambia two por three.", values: [{ source: "dos", target: "two" }, { source: "tres", target: "three" }] }] },
    { id: "recall-buy", kind: "recall", instruction: "Di que quieres comprar esto.", sourceText: "Quiero comprar esto.", targetText: "I want to buy this.", hint: "I want to buy…", reviewAfterDays: [1, 3, 7, 14] },
    { id: "recall-three", kind: "recall", instruction: "Pregunta si la persona tiene tres.", sourceText: "¿Tienes tres?", targetText: "Do you have three?", hint: "Do you have…?", reviewAfterDays: [1, 3, 7, 14] }
  ],
  miniDialogue: [
    { speaker: "teacher", source: "¿Cuánto cuesta?", target: "How much does it cost?" },
    { speaker: "learner", source: "Cuesta cinco dólares.", target: "It costs five dollars." },
    { speaker: "teacher", source: "¿Quieres comprarlo?", target: "Do you want to buy it?" },
    { speaker: "learner", source: "Sí, quiero comprarlo.", target: "Yes, I want to buy it." }
  ],
  completion: { minimumIndependentRecalls: 2, minimumSpokenAttempts: 4 }
};

export const dayEightLessons = {
  "tom-spanish-1": assertTutorLesson(tom, getCourse("tom-spanish-1")),
  "liz-english-1": assertTutorLesson(liz, getCourse("liz-english-1"))
} as const;
