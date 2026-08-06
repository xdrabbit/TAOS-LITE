import { assertTutorLesson, type TutorLesson } from "@/lib/tutor/course";
import { getCourse } from "@/lib/tutor/courses";

function make(courseId: "tom-spanish-1" | "liz-english-1", target: "es" | "en"): TutorLesson {
  const spanish = target === "es";
  return {
    id: `${courseId}-day-07`, courseId, day: 7,
    title: spanish ? "Review and mini conversation" : "Review and mini conversation",
    communicativeGoal: spanish ? "Combine the first six days without new grammar." : "Combinar los primeros seis días sin gramática nueva.",
    grammarFocus: spanish ? ["cumulative review", "questions and answers"] : ["repaso acumulativo", "preguntas y respuestas"],
    vocabularyFocus: spanish ? ["quiero", "necesito", "tengo", "voy", "hoy", "mañana", "comida"] : ["want", "need", "have", "go", "today", "tomorrow", "food"],
    anchorSentences: spanish ? [
      { source: "Do you want coffee?", target: "¿Quieres café?" },
      { source: "No, I want water.", target: "No, quiero agua." },
      { source: "I need help now.", target: "Necesito ayuda ahora." },
      { source: "We have time today.", target: "Tenemos tiempo hoy." },
      { source: "I am going home later.", target: "Voy a casa después." },
      { source: "I like fish.", target: "Me gusta el pescado." }
    ] : [
      { source: "¿Quieres café?", target: "Do you want coffee?" },
      { source: "No, quiero agua.", target: "No, I want water." },
      { source: "Necesito ayuda ahora.", target: "I need help now." },
      { source: "Tenemos tiempo hoy.", target: "We have time today." },
      { source: "Voy a casa después.", target: "I am going home later." },
      { source: "Me gusta el pescado.", target: "I like fish." }
    ],
    drills: spanish ? [
      { id: "recall-want", kind: "recall", instruction: "Answer without looking.", sourceText: "No, I want water.", targetText: "No, quiero agua.", hint: "No, quiero…", reviewAfterDays: [1, 3, 7, 14] },
      { id: "recall-now", kind: "recall", instruction: "Add the time word at the end.", sourceText: "I need help now.", targetText: "Necesito ayuda ahora.", hint: "Necesito ayuda…", reviewAfterDays: [1, 3, 7, 14] },
      { id: "substitute-time", kind: "substitution", instruction: "Change today to tomorrow.", sourceText: "We have time tomorrow.", targetText: "Tenemos tiempo mañana.", substitutions: [{ id: "time", prompt: "Change today to tomorrow.", values: [{ source: "today", target: "hoy" }, { source: "tomorrow", target: "mañana" }] }] },
      { id: "recall-home", kind: "recall", instruction: "Say the whole plan.", sourceText: "I am going home later.", targetText: "Voy a casa después.", hint: "Voy a casa…", reviewAfterDays: [1, 3, 7, 14] },
      { id: "recall-like", kind: "recall", instruction: "State the preference.", sourceText: "I like fish.", targetText: "Me gusta el pescado.", hint: "Me gusta…", reviewAfterDays: [1, 3, 7, 14] }
    ] : [
      { id: "recall-want", kind: "recall", instruction: "Responde sin mirar.", sourceText: "No, quiero agua.", targetText: "No, I want water.", hint: "No, I want…", reviewAfterDays: [1, 3, 7, 14] },
      { id: "recall-now", kind: "recall", instruction: "Agrega now al final.", sourceText: "Necesito ayuda ahora.", targetText: "I need help now.", hint: "I need help…", reviewAfterDays: [1, 3, 7, 14] },
      { id: "substitute-time", kind: "substitution", instruction: "Cambia today por tomorrow.", sourceText: "Tenemos tiempo mañana.", targetText: "We have time tomorrow.", substitutions: [{ id: "time", prompt: "Cambia today por tomorrow.", values: [{ source: "hoy", target: "today" }, { source: "mañana", target: "tomorrow" }] }] },
      { id: "recall-home", kind: "recall", instruction: "Di el plan completo.", sourceText: "Voy a casa después.", targetText: "I am going home later.", hint: "I am going home…", reviewAfterDays: [1, 3, 7, 14] },
      { id: "recall-like", kind: "recall", instruction: "Di la preferencia.", sourceText: "Me gusta el pescado.", targetText: "I like fish.", hint: "I like…", reviewAfterDays: [1, 3, 7, 14] }
    ],
    miniDialogue: spanish ? [
      { speaker: "teacher", source: "Do you want coffee?", target: "¿Quieres café?" },
      { speaker: "learner", source: "No, I want water.", target: "No, quiero agua." },
      { speaker: "teacher", source: "When are you going home?", target: "¿Cuándo vas a casa?" },
      { speaker: "learner", source: "I am going home later.", target: "Voy a casa después." }
    ] : [
      { speaker: "teacher", source: "¿Quieres café?", target: "Do you want coffee?" },
      { speaker: "learner", source: "No, quiero agua.", target: "No, I want water." },
      { speaker: "teacher", source: "¿Cuándo vas a casa?", target: "When are you going home?" },
      { speaker: "learner", source: "Voy a casa después.", target: "I am going home later." }
    ],
    completion: { minimumIndependentRecalls: 4, minimumSpokenAttempts: 5 }
  };
}

export const daySevenLessons = {
  "tom-spanish-1": assertTutorLesson(make("tom-spanish-1", "es"), getCourse("tom-spanish-1")),
  "liz-english-1": assertTutorLesson(make("liz-english-1", "en"), getCourse("liz-english-1"))
} as const;
