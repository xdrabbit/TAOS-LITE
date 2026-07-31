import { assertTutorLesson, type TutorLesson } from "@/lib/tutor/course";
import { getCourse } from "@/lib/tutor/courses";

const tom: TutorLesson = {
  id: "tom-spanish-1-day-05", courseId: "tom-spanish-1", day: 5,
  title: "Time: now, later, today, tomorrow",
  communicativeGoal: "Say when something happens and ask about timing.",
  grammarFocus: ["time words", "¿cuándo...?"],
  vocabularyFocus: ["ahora", "después", "hoy", "mañana", "temprano", "tarde", "cuándo"],
  anchorSentences: [
    { source: "I need help now.", target: "Necesito ayuda ahora." },
    { source: "I will go later.", target: "Voy después." },
    { source: "I work today.", target: "Trabajo hoy." },
    { source: "I work tomorrow.", target: "Trabajo mañana." },
    { source: "When are you coming?", target: "¿Cuándo vienes?" }
  ],
  drills: [
    { id: "model-now", kind: "model", instruction: "Notice that the time word can come at the end.", sourceText: "I need help now.", targetText: "Necesito ayuda ahora." },
    { id: "repeat-tomorrow", kind: "repeat", instruction: "Repeat the whole sentence with mañana.", sourceText: "I work tomorrow.", targetText: "Trabajo mañana.", reviewAfterDays: [1, 3, 7, 14] },
    { id: "substitute-time", kind: "substitution", instruction: "Keep the action and change only the time.", sourceText: "I work today.", targetText: "Trabajo hoy.", substitutions: [{ id: "time", prompt: "Change today to tomorrow.", values: [{ source: "today", target: "hoy" }, { source: "tomorrow", target: "mañana" }] }] },
    { id: "recall-later", kind: "recall", instruction: "Say that you will go later.", sourceText: "I will go later.", targetText: "Voy después.", hint: "Voy des…", reviewAfterDays: [1, 3, 7, 14] },
    { id: "recall-when", kind: "recall", instruction: "Ask when the person is coming.", sourceText: "When are you coming?", targetText: "¿Cuándo vienes?", hint: "¿Cuándo…?", reviewAfterDays: [1, 3, 7, 14] }
  ],
  miniDialogue: [
    { speaker: "teacher", source: "When are you coming?", target: "¿Cuándo vienes?" },
    { speaker: "learner", source: "I am coming now.", target: "Vengo ahora." },
    { speaker: "teacher", source: "Are you working tomorrow?", target: "¿Trabajas mañana?" },
    { speaker: "learner", source: "No, I work today.", target: "No, trabajo hoy." }
  ],
  completion: { minimumIndependentRecalls: 2, minimumSpokenAttempts: 4 }
};

const liz: TutorLesson = {
  id: "liz-english-1-day-05", courseId: "liz-english-1", day: 5,
  title: "Time: now, later, today, tomorrow",
  communicativeGoal: "Decir cuándo ocurre algo y preguntar por el tiempo.",
  grammarFocus: ["time words", "when questions"],
  vocabularyFocus: ["now", "later", "today", "tomorrow", "early", "late", "when"],
  anchorSentences: [
    { source: "Necesito ayuda ahora.", target: "I need help now." },
    { source: "Voy después.", target: "I will go later." },
    { source: "Trabajo hoy.", target: "I work today." },
    { source: "Trabajo mañana.", target: "I work tomorrow." },
    { source: "¿Cuándo vienes?", target: "When are you coming?" }
  ],
  drills: [
    { id: "model-now", kind: "model", instruction: "Escucha cómo now aparece al final.", sourceText: "Necesito ayuda ahora.", targetText: "I need help now." },
    { id: "repeat-tomorrow", kind: "repeat", instruction: "Repite la oración completa con tomorrow.", sourceText: "Trabajo mañana.", targetText: "I work tomorrow.", reviewAfterDays: [1, 3, 7, 14] },
    { id: "substitute-time", kind: "substitution", instruction: "Mantén la acción y cambia solamente el tiempo.", sourceText: "Trabajo hoy.", targetText: "I work today.", substitutions: [{ id: "time", prompt: "Cambia today por tomorrow.", values: [{ source: "hoy", target: "today" }, { source: "mañana", target: "tomorrow" }] }] },
    { id: "recall-later", kind: "recall", instruction: "Di que irás después.", sourceText: "Voy después.", targetText: "I will go later.", hint: "I will go…", reviewAfterDays: [1, 3, 7, 14] },
    { id: "recall-when", kind: "recall", instruction: "Pregunta cuándo viene la persona.", sourceText: "¿Cuándo vienes?", targetText: "When are you coming?", hint: "When are…?", reviewAfterDays: [1, 3, 7, 14] }
  ],
  miniDialogue: [
    { speaker: "teacher", source: "¿Cuándo vienes?", target: "When are you coming?" },
    { speaker: "learner", source: "Vengo ahora.", target: "I am coming now." },
    { speaker: "teacher", source: "¿Trabajas mañana?", target: "Are you working tomorrow?" },
    { speaker: "learner", source: "No, trabajo hoy.", target: "No, I work today." }
  ],
  completion: { minimumIndependentRecalls: 2, minimumSpokenAttempts: 4 }
};

export const dayFiveLessons = {
  "tom-spanish-1": assertTutorLesson(tom, getCourse("tom-spanish-1")),
  "liz-english-1": assertTutorLesson(liz, getCourse("liz-english-1"))
} as const;
