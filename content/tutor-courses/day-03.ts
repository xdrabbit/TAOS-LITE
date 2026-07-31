import { assertTutorLesson, type TutorLesson } from "@/lib/tutor/course";
import { getCourse } from "@/lib/tutor/courses";

const tom: TutorLesson = {
  id: "tom-spanish-1-day-03", courseId: "tom-spanish-1", day: 3,
  title: "People: I, you, we, he, she",
  communicativeGoal: "Say who is doing or needing something.",
  grammarFocus: ["subject pronouns", "verb changes with the subject"],
  vocabularyFocus: ["yo", "tú", "nosotros", "él", "ella", "quiere", "necesita", "tiene"],
  anchorSentences: [
    { source: "I want coffee.", target: "Yo quiero café." },
    { source: "You need help.", target: "Tú necesitas ayuda." },
    { source: "We have time.", target: "Nosotros tenemos tiempo." },
    { source: "He wants water.", target: "Él quiere agua." },
    { source: "She needs help.", target: "Ella necesita ayuda." }
  ],
  drills: [
    { id: "model-pronouns", kind: "model", instruction: "Listen for the person at the front of the sentence.", sourceText: "She needs help.", targetText: "Ella necesita ayuda." },
    { id: "repeat-we", kind: "repeat", instruction: "Repeat the complete we sentence.", sourceText: "We have time.", targetText: "Nosotros tenemos tiempo.", reviewAfterDays: [1, 3, 7, 14] },
    { id: "substitute-person", kind: "substitution", instruction: "Keep the idea and change only the person.", sourceText: "He wants water.", targetText: "Él quiere agua.", substitutions: [{ id: "person", prompt: "Change he to she.", values: [{ source: "he", target: "él" }, { source: "she", target: "ella" }] }] },
    { id: "recall-you", kind: "recall", instruction: "Say the sentence about you.", sourceText: "You need help.", targetText: "Tú necesitas ayuda.", hint: "Tú ne…", reviewAfterDays: [1, 3, 7, 14] },
    { id: "recall-she", kind: "recall", instruction: "Say who needs help.", sourceText: "She needs help.", targetText: "Ella necesita ayuda.", hint: "Ella ne…", reviewAfterDays: [1, 3, 7, 14] }
  ],
  miniDialogue: [
    { speaker: "teacher", source: "Does she want coffee?", target: "¿Ella quiere café?" },
    { speaker: "learner", source: "No, she wants water.", target: "No, ella quiere agua." },
    { speaker: "teacher", source: "Do we have time?", target: "¿Tenemos tiempo?" },
    { speaker: "learner", source: "Yes, we have time.", target: "Sí, tenemos tiempo." }
  ],
  completion: { minimumIndependentRecalls: 2, minimumSpokenAttempts: 4 }
};

const liz: TutorLesson = {
  id: "liz-english-1-day-03", courseId: "liz-english-1", day: 3,
  title: "People: I, you, we, he, she",
  communicativeGoal: "Decir quién quiere, necesita o tiene algo.",
  grammarFocus: ["subject pronouns", "he/she + verb ending s"],
  vocabularyFocus: ["I", "you", "we", "he", "she", "wants", "needs", "has"],
  anchorSentences: [
    { source: "Yo quiero café.", target: "I want coffee." },
    { source: "Tú necesitas ayuda.", target: "You need help." },
    { source: "Nosotros tenemos tiempo.", target: "We have time." },
    { source: "Él quiere agua.", target: "He wants water." },
    { source: "Ella necesita ayuda.", target: "She needs help." }
  ],
  drills: [
    { id: "model-pronouns", kind: "model", instruction: "Escucha quién aparece al principio de la oración.", sourceText: "Ella necesita ayuda.", targetText: "She needs help." },
    { id: "repeat-we", kind: "repeat", instruction: "Repite la oración completa con we.", sourceText: "Nosotros tenemos tiempo.", targetText: "We have time.", reviewAfterDays: [1, 3, 7, 14] },
    { id: "substitute-person", kind: "substitution", instruction: "Mantén la idea y cambia solamente la persona.", sourceText: "Él quiere agua.", targetText: "He wants water.", substitutions: [{ id: "person", prompt: "Cambia he por she.", values: [{ source: "él", target: "he" }, { source: "ella", target: "she" }] }] },
    { id: "recall-you", kind: "recall", instruction: "Di la oración sobre tú.", sourceText: "Tú necesitas ayuda.", targetText: "You need help.", hint: "You ne…", reviewAfterDays: [1, 3, 7, 14] },
    { id: "recall-she", kind: "recall", instruction: "Recuerda la s de needs con she.", sourceText: "Ella necesita ayuda.", targetText: "She needs help.", hint: "She need…", reviewAfterDays: [1, 3, 7, 14] }
  ],
  miniDialogue: [
    { speaker: "teacher", source: "¿Ella quiere café?", target: "Does she want coffee?" },
    { speaker: "learner", source: "No, ella quiere agua.", target: "No, she wants water." },
    { speaker: "teacher", source: "¿Tenemos tiempo?", target: "Do we have time?" },
    { speaker: "learner", source: "Sí, tenemos tiempo.", target: "Yes, we have time." }
  ],
  completion: { minimumIndependentRecalls: 2, minimumSpokenAttempts: 4 }
};

export const dayThreeLessons = {
  "tom-spanish-1": assertTutorLesson(tom, getCourse("tom-spanish-1")),
  "liz-english-1": assertTutorLesson(liz, getCourse("liz-english-1"))
} as const;
