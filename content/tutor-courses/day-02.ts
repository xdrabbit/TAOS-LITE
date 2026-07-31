import { assertTutorLesson, type TutorLesson } from "@/lib/tutor/course";
import { getCourse } from "@/lib/tutor/courses";

const tom: TutorLesson = {
  id: "tom-spanish-1-day-02",
  courseId: "tom-spanish-1",
  day: 2,
  title: "Yes, no, and simple questions",
  communicativeGoal: "Ask whether someone wants, needs, or has something and answer clearly.",
  grammarFocus: ["¿... ? question frame", "sí / no", "tú forms: quieres, necesitas, tienes"],
  vocabularyFocus: ["sí", "no", "quieres", "necesitas", "tienes", "café", "agua", "ayuda", "tiempo"],
  anchorSentences: [
    { source: "Do you want coffee?", target: "¿Quieres café?" },
    { source: "Yes, I want coffee.", target: "Sí, quiero café." },
    { source: "Do you need help?", target: "¿Necesitas ayuda?" },
    { source: "No, I don't need help.", target: "No, no necesito ayuda." },
    { source: "Do you have time?", target: "¿Tienes tiempo?" }
  ],
  drills: [
    { id: "model-question", kind: "model", instruction: "Listen to the rise and fall of the question.", sourceText: "Do you want coffee?", targetText: "¿Quieres café?" },
    { id: "repeat-answer", kind: "repeat", instruction: "Answer with a complete sentence.", sourceText: "Yes, I want coffee.", targetText: "Sí, quiero café.", reviewAfterDays: [1, 3, 7, 14] },
    { id: "substitute-need", kind: "substitution", instruction: "Keep the question pattern and change the verb.", sourceText: "Do you need help?", targetText: "¿Necesitas ayuda?", substitutions: [{ id: "verb", prompt: "Change want to need.", values: [{ source: "want", target: "quieres" }, { source: "need", target: "necesitas" }] }] },
    { id: "recall-negative", kind: "recall", instruction: "Answer no, then say the whole sentence.", sourceText: "No, I don't need help.", targetText: "No, no necesito ayuda.", hint: "No, no ne…", reviewAfterDays: [1, 3, 7, 14] },
    { id: "recall-have", kind: "recall", instruction: "Ask if the other person has time.", sourceText: "Do you have time?", targetText: "¿Tienes tiempo?", hint: "¿Tie…?", reviewAfterDays: [1, 3, 7, 14] }
  ],
  miniDialogue: [
    { speaker: "teacher", source: "Do you want water?", target: "¿Quieres agua?" },
    { speaker: "learner", source: "Yes, I want water.", target: "Sí, quiero agua." },
    { speaker: "teacher", source: "Do you need help?", target: "¿Necesitas ayuda?" },
    { speaker: "learner", source: "No, I don't need help.", target: "No, no necesito ayuda." }
  ],
  completion: { minimumIndependentRecalls: 2, minimumSpokenAttempts: 4 }
};

const liz: TutorLesson = {
  id: "liz-english-1-day-02",
  courseId: "liz-english-1",
  day: 2,
  title: "Yes, no, and simple questions",
  communicativeGoal: "Preguntar si alguien quiere, necesita o tiene algo y responder con claridad.",
  grammarFocus: ["Do you...?", "yes / no", "don't before the base verb"],
  vocabularyFocus: ["yes", "no", "do you want", "do you need", "do you have", "coffee", "water", "help", "time"],
  anchorSentences: [
    { source: "¿Quieres café?", target: "Do you want coffee?" },
    { source: "Sí, quiero café.", target: "Yes, I want coffee." },
    { source: "¿Necesitas ayuda?", target: "Do you need help?" },
    { source: "No, no necesito ayuda.", target: "No, I don't need help." },
    { source: "¿Tienes tiempo?", target: "Do you have time?" }
  ],
  drills: [
    { id: "model-question", kind: "model", instruction: "Escucha cómo do inicia la pregunta.", sourceText: "¿Quieres café?", targetText: "Do you want coffee?" },
    { id: "repeat-answer", kind: "repeat", instruction: "Responde con una oración completa.", sourceText: "Sí, quiero café.", targetText: "Yes, I want coffee.", reviewAfterDays: [1, 3, 7, 14] },
    { id: "substitute-need", kind: "substitution", instruction: "Mantén la pregunta y cambia solamente el verbo.", sourceText: "¿Necesitas ayuda?", targetText: "Do you need help?", substitutions: [{ id: "verb", prompt: "Cambia want por need.", values: [{ source: "querer", target: "want" }, { source: "necesitar", target: "need" }] }] },
    { id: "recall-negative", kind: "recall", instruction: "Responde no y usa don't antes del verbo.", sourceText: "No, no necesito ayuda.", targetText: "No, I don't need help.", hint: "No, I don't ne…", reviewAfterDays: [1, 3, 7, 14] },
    { id: "recall-have", kind: "recall", instruction: "Pregunta si la otra persona tiene tiempo.", sourceText: "¿Tienes tiempo?", targetText: "Do you have time?", hint: "Do you ha…?", reviewAfterDays: [1, 3, 7, 14] }
  ],
  miniDialogue: [
    { speaker: "teacher", source: "¿Quieres agua?", target: "Do you want water?" },
    { speaker: "learner", source: "Sí, quiero agua.", target: "Yes, I want water." },
    { speaker: "teacher", source: "¿Necesitas ayuda?", target: "Do you need help?" },
    { speaker: "learner", source: "No, no necesito ayuda.", target: "No, I don't need help." }
  ],
  completion: { minimumIndependentRecalls: 2, minimumSpokenAttempts: 4 }
};

export const dayTwoLessons = {
  "tom-spanish-1": assertTutorLesson(tom, getCourse("tom-spanish-1")),
  "liz-english-1": assertTutorLesson(liz, getCourse("liz-english-1"))
} as const;
