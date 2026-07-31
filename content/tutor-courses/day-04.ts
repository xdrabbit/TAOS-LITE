import { assertTutorLesson, type TutorLesson } from "@/lib/tutor/course";
import { getCourse } from "@/lib/tutor/courses";

const tom: TutorLesson = {
  id: "tom-spanish-1-day-04", courseId: "tom-spanish-1", day: 4,
  title: "Daily verbs: go, come, eat, drink, work, sleep",
  communicativeGoal: "Talk about simple daily actions.",
  grammarFocus: ["present-tense first person", "verb + complement"],
  vocabularyFocus: ["voy", "vengo", "como", "bebo", "trabajo", "duermo", "casa", "ahora"],
  anchorSentences: [
    { source: "I am going home.", target: "Voy a casa." },
    { source: "I am coming now.", target: "Vengo ahora." },
    { source: "I eat at home.", target: "Como en casa." },
    { source: "I drink water.", target: "Bebo agua." },
    { source: "I work today.", target: "Trabajo hoy." },
    { source: "I sleep now.", target: "Duermo ahora." }
  ],
  drills: [
    { id: "model-go", kind: "model", instruction: "Listen to voy a casa as one useful chunk.", sourceText: "I am going home.", targetText: "Voy a casa." },
    { id: "repeat-drink", kind: "repeat", instruction: "Repeat the complete action.", sourceText: "I drink water.", targetText: "Bebo agua.", reviewAfterDays: [1, 3, 7, 14] },
    { id: "substitute-action", kind: "substitution", instruction: "Keep the time word and change the action.", sourceText: "I work today.", targetText: "Trabajo hoy.", substitutions: [{ id: "action", prompt: "Change work to sleep.", values: [{ source: "work", target: "trabajo" }, { source: "sleep", target: "duermo" }] }] },
    { id: "recall-eat", kind: "recall", instruction: "Say where you eat.", sourceText: "I eat at home.", targetText: "Como en casa.", hint: "Como en…", reviewAfterDays: [1, 3, 7, 14] },
    { id: "recall-come", kind: "recall", instruction: "Say that you are coming now.", sourceText: "I am coming now.", targetText: "Vengo ahora.", hint: "Vengo…", reviewAfterDays: [1, 3, 7, 14] }
  ],
  miniDialogue: [
    { speaker: "teacher", source: "Are you coming now?", target: "¿Vienes ahora?" },
    { speaker: "learner", source: "Yes, I am coming now.", target: "Sí, vengo ahora." },
    { speaker: "teacher", source: "Do you eat at home?", target: "¿Comes en casa?" },
    { speaker: "learner", source: "Yes, I eat at home.", target: "Sí, como en casa." }
  ],
  completion: { minimumIndependentRecalls: 2, minimumSpokenAttempts: 4 }
};

const liz: TutorLesson = {
  id: "liz-english-1-day-04", courseId: "liz-english-1", day: 4,
  title: "Daily verbs: go, come, eat, drink, work, sleep",
  communicativeGoal: "Hablar sobre acciones diarias sencillas.",
  grammarFocus: ["I + base verb", "go home without to"],
  vocabularyFocus: ["go", "come", "eat", "drink", "work", "sleep", "home", "now"],
  anchorSentences: [
    { source: "Voy a casa.", target: "I am going home." },
    { source: "Vengo ahora.", target: "I am coming now." },
    { source: "Como en casa.", target: "I eat at home." },
    { source: "Bebo agua.", target: "I drink water." },
    { source: "Trabajo hoy.", target: "I work today." },
    { source: "Duermo ahora.", target: "I sleep now." }
  ],
  drills: [
    { id: "model-go", kind: "model", instruction: "Escucha going home como una sola idea útil.", sourceText: "Voy a casa.", targetText: "I am going home." },
    { id: "repeat-drink", kind: "repeat", instruction: "Repite la acción completa.", sourceText: "Bebo agua.", targetText: "I drink water.", reviewAfterDays: [1, 3, 7, 14] },
    { id: "substitute-action", kind: "substitution", instruction: "Mantén today y cambia solamente la acción.", sourceText: "Trabajo hoy.", targetText: "I work today.", substitutions: [{ id: "action", prompt: "Cambia work por sleep.", values: [{ source: "trabajar", target: "work" }, { source: "dormir", target: "sleep" }] }] },
    { id: "recall-eat", kind: "recall", instruction: "Di dónde comes.", sourceText: "Como en casa.", targetText: "I eat at home.", hint: "I eat at…", reviewAfterDays: [1, 3, 7, 14] },
    { id: "recall-come", kind: "recall", instruction: "Di que vienes ahora.", sourceText: "Vengo ahora.", targetText: "I am coming now.", hint: "I am coming…", reviewAfterDays: [1, 3, 7, 14] }
  ],
  miniDialogue: [
    { speaker: "teacher", source: "¿Vienes ahora?", target: "Are you coming now?" },
    { speaker: "learner", source: "Sí, vengo ahora.", target: "Yes, I am coming now." },
    { speaker: "teacher", source: "¿Comes en casa?", target: "Do you eat at home?" },
    { speaker: "learner", source: "Sí, como en casa.", target: "Yes, I eat at home." }
  ],
  completion: { minimumIndependentRecalls: 2, minimumSpokenAttempts: 4 }
};

export const dayFourLessons = {
  "tom-spanish-1": assertTutorLesson(tom, getCourse("tom-spanish-1")),
  "liz-english-1": assertTutorLesson(liz, getCourse("liz-english-1"))
} as const;
