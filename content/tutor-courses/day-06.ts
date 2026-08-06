import { assertTutorLesson, type TutorLesson } from "@/lib/tutor/course";
import { getCourse } from "@/lib/tutor/courses";

const tom: TutorLesson = {
  id: "tom-spanish-1-day-06", courseId: "tom-spanish-1", day: 6,
  title: "Food and ordering",
  communicativeGoal: "Order simple food and drinks and state preferences.",
  grammarFocus: ["quiero + noun", "me gusta / no me gusta", "por favor"],
  vocabularyFocus: ["comida", "café", "agua", "pollo", "pescado", "arroz", "me gusta", "por favor"],
  anchorSentences: [
    { source: "I want coffee, please.", target: "Quiero café, por favor." },
    { source: "I want chicken.", target: "Quiero pollo." },
    { source: "I like fish.", target: "Me gusta el pescado." },
    { source: "I don't like rice.", target: "No me gusta el arroz." },
    { source: "Can I have water?", target: "¿Me da agua?" }
  ],
  drills: [
    { id: "model-order", kind: "model", instruction: "Listen to the polite ordering chunk.", sourceText: "I want coffee, please.", targetText: "Quiero café, por favor." },
    { id: "repeat-like", kind: "repeat", instruction: "Repeat the preference sentence.", sourceText: "I like fish.", targetText: "Me gusta el pescado.", reviewAfterDays: [1, 3, 7, 14] },
    { id: "substitute-food", kind: "substitution", instruction: "Keep quiero and change only the food.", sourceText: "I want chicken.", targetText: "Quiero pollo.", substitutions: [{ id: "food", prompt: "Change chicken to fish.", values: [{ source: "chicken", target: "pollo" }, { source: "fish", target: "pescado" }] }] },
    { id: "recall-dislike", kind: "recall", instruction: "Say what you do not like.", sourceText: "I don't like rice.", targetText: "No me gusta el arroz.", hint: "No me gusta…", reviewAfterDays: [1, 3, 7, 14] },
    { id: "recall-water", kind: "recall", instruction: "Ask politely for water.", sourceText: "Can I have water?", targetText: "¿Me da agua?", hint: "¿Me da…?", reviewAfterDays: [1, 3, 7, 14] }
  ],
  miniDialogue: [
    { speaker: "teacher", source: "What do you want?", target: "¿Qué quieres?" },
    { speaker: "learner", source: "I want chicken, please.", target: "Quiero pollo, por favor." },
    { speaker: "teacher", source: "Do you like rice?", target: "¿Te gusta el arroz?" },
    { speaker: "learner", source: "No, I like fish.", target: "No, me gusta el pescado." }
  ],
  completion: { minimumIndependentRecalls: 2, minimumSpokenAttempts: 4 }
};

const liz: TutorLesson = {
  id: "liz-english-1-day-06", courseId: "liz-english-1", day: 6,
  title: "Food and ordering",
  communicativeGoal: "Pedir comida y bebidas sencillas y expresar preferencias.",
  grammarFocus: ["I want + noun", "I like / I don't like", "please"],
  vocabularyFocus: ["food", "coffee", "water", "chicken", "fish", "rice", "I like", "please"],
  anchorSentences: [
    { source: "Quiero café, por favor.", target: "I want coffee, please." },
    { source: "Quiero pollo.", target: "I want chicken." },
    { source: "Me gusta el pescado.", target: "I like fish." },
    { source: "No me gusta el arroz.", target: "I don't like rice." },
    { source: "¿Me da agua?", target: "Can I have water?" }
  ],
  drills: [
    { id: "model-order", kind: "model", instruction: "Escucha la frase completa para pedir con cortesía.", sourceText: "Quiero café, por favor.", targetText: "I want coffee, please." },
    { id: "repeat-like", kind: "repeat", instruction: "Repite la preferencia completa.", sourceText: "Me gusta el pescado.", targetText: "I like fish.", reviewAfterDays: [1, 3, 7, 14] },
    { id: "substitute-food", kind: "substitution", instruction: "Mantén I want y cambia solamente la comida.", sourceText: "Quiero pollo.", targetText: "I want chicken.", substitutions: [{ id: "food", prompt: "Cambia chicken por fish.", values: [{ source: "pollo", target: "chicken" }, { source: "pescado", target: "fish" }] }] },
    { id: "recall-dislike", kind: "recall", instruction: "Di lo que no te gusta.", sourceText: "No me gusta el arroz.", targetText: "I don't like rice.", hint: "I don't like…", reviewAfterDays: [1, 3, 7, 14] },
    { id: "recall-water", kind: "recall", instruction: "Pide agua con cortesía.", sourceText: "¿Me da agua?", targetText: "Can I have water?", hint: "Can I have…?", reviewAfterDays: [1, 3, 7, 14] }
  ],
  miniDialogue: [
    { speaker: "teacher", source: "¿Qué quieres?", target: "What do you want?" },
    { speaker: "learner", source: "Quiero pollo, por favor.", target: "I want chicken, please." },
    { speaker: "teacher", source: "¿Te gusta el arroz?", target: "Do you like rice?" },
    { speaker: "learner", source: "No, me gusta el pescado.", target: "No, I like fish." }
  ],
  completion: { minimumIndependentRecalls: 2, minimumSpokenAttempts: 4 }
};

export const daySixLessons = {
  "tom-spanish-1": assertTutorLesson(tom, getCourse("tom-spanish-1")),
  "liz-english-1": assertTutorLesson(liz, getCourse("liz-english-1"))
} as const;
