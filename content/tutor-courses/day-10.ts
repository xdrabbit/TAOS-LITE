import { assertTutorLesson, type TutorLesson } from "@/lib/tutor/course";
import { getCourse } from "@/lib/tutor/courses";

function make(courseId: "tom-spanish-1" | "liz-english-1", target: "es" | "en"): TutorLesson {
  const spanish = target === "es";
  return {
    id: `${courseId}-day-10`, courseId, day: 10,
    title: "Complete conversation",
    communicativeGoal: spanish ? "Carry a short practical conversation using the first ten days." : "Mantener una conversación práctica corta usando los primeros diez días.",
    grammarFocus: spanish ? ["integrated questions", "answers, time, food, location, price"] : ["preguntas integradas", "respuestas, tiempo, comida, ubicación, precio"],
    vocabularyFocus: spanish ? ["quiero", "necesito", "cuándo", "dónde", "cuánto", "hoy", "mañana", "por favor"] : ["want", "need", "when", "where", "how much", "today", "tomorrow", "please"],
    anchorSentences: spanish ? [
      { source: "Do you want coffee?", target: "¿Quieres café?" },
      { source: "No, I want water, please.", target: "No, quiero agua, por favor." },
      { source: "When are you going home?", target: "¿Cuándo vas a casa?" },
      { source: "I am going home later.", target: "Voy a casa después." },
      { source: "Where are the keys?", target: "¿Dónde están las llaves?" },
      { source: "How much does it cost?", target: "¿Cuánto cuesta?" }
    ] : [
      { source: "¿Quieres café?", target: "Do you want coffee?" },
      { source: "No, quiero agua, por favor.", target: "No, I want water, please." },
      { source: "¿Cuándo vas a casa?", target: "When are you going home?" },
      { source: "Voy a casa después.", target: "I am going home later." },
      { source: "¿Dónde están las llaves?", target: "Where are the keys?" },
      { source: "¿Cuánto cuesta?", target: "How much does it cost?" }
    ],
    drills: spanish ? [
      { id: "recall-order", kind: "recall", instruction: "Answer the drink question politely.", sourceText: "No, I want water, please.", targetText: "No, quiero agua, por favor.", hint: "No, quiero…", reviewAfterDays: [1, 3, 7, 14] },
      { id: "recall-time", kind: "recall", instruction: "Say when you are going home.", sourceText: "I am going home later.", targetText: "Voy a casa después.", hint: "Voy a casa…", reviewAfterDays: [1, 3, 7, 14] },
      { id: "recall-keys", kind: "recall", instruction: "Ask where the keys are.", sourceText: "Where are the keys?", targetText: "¿Dónde están las llaves?", hint: "¿Dónde están…?", reviewAfterDays: [1, 3, 7, 14] },
      { id: "recall-price", kind: "recall", instruction: "Ask the price.", sourceText: "How much does it cost?", targetText: "¿Cuánto cuesta?", hint: "¿Cuánto…?", reviewAfterDays: [1, 3, 7, 14] },
      { id: "substitute-day", kind: "substitution", instruction: "Change today to tomorrow.", sourceText: "I work tomorrow.", targetText: "Trabajo mañana.", substitutions: [{ id: "day", prompt: "Change today to tomorrow.", values: [{ source: "today", target: "hoy" }, { source: "tomorrow", target: "mañana" }] }] }
    ] : [
      { id: "recall-order", kind: "recall", instruction: "Responde la pregunta de la bebida con cortesía.", sourceText: "No, quiero agua, por favor.", targetText: "No, I want water, please.", hint: "No, I want…", reviewAfterDays: [1, 3, 7, 14] },
      { id: "recall-time", kind: "recall", instruction: "Di cuándo vas a casa.", sourceText: "Voy a casa después.", targetText: "I am going home later.", hint: "I am going home…", reviewAfterDays: [1, 3, 7, 14] },
      { id: "recall-keys", kind: "recall", instruction: "Pregunta dónde están las llaves.", sourceText: "¿Dónde están las llaves?", targetText: "Where are the keys?", hint: "Where are…?", reviewAfterDays: [1, 3, 7, 14] },
      { id: "recall-price", kind: "recall", instruction: "Pregunta el precio.", sourceText: "¿Cuánto cuesta?", targetText: "How much does it cost?", hint: "How much…?", reviewAfterDays: [1, 3, 7, 14] },
      { id: "substitute-day", kind: "substitution", instruction: "Cambia today por tomorrow.", sourceText: "Trabajo mañana.", targetText: "I work tomorrow.", substitutions: [{ id: "day", prompt: "Cambia today por tomorrow.", values: [{ source: "hoy", target: "today" }, { source: "mañana", target: "tomorrow" }] }] }
    ],
    miniDialogue: spanish ? [
      { speaker: "teacher", source: "Do you want coffee?", target: "¿Quieres café?" },
      { speaker: "learner", source: "No, I want water, please.", target: "No, quiero agua, por favor." },
      { speaker: "teacher", source: "When are you going home?", target: "¿Cuándo vas a casa?" },
      { speaker: "learner", source: "I am going home later.", target: "Voy a casa después." },
      { speaker: "teacher", source: "Where are the keys?", target: "¿Dónde están las llaves?" },
      { speaker: "learner", source: "The keys are on the table.", target: "Las llaves están en la mesa." }
    ] : [
      { speaker: "teacher", source: "¿Quieres café?", target: "Do you want coffee?" },
      { speaker: "learner", source: "No, quiero agua, por favor.", target: "No, I want water, please." },
      { speaker: "teacher", source: "¿Cuándo vas a casa?", target: "When are you going home?" },
      { speaker: "learner", source: "Voy a casa después.", target: "I am going home later." },
      { speaker: "teacher", source: "¿Dónde están las llaves?", target: "Where are the keys?" },
      { speaker: "learner", source: "Las llaves están en la mesa.", target: "The keys are on the table." }
    ],
    completion: { minimumIndependentRecalls: 4, minimumSpokenAttempts: 5 }
  };
}

export const dayTenLessons = {
  "tom-spanish-1": assertTutorLesson(make("tom-spanish-1", "es"), getCourse("tom-spanish-1")),
  "liz-english-1": assertTutorLesson(make("liz-english-1", "en"), getCourse("liz-english-1"))
} as const;
