import { assertTutorLesson, type TutorLesson } from "@/lib/tutor/course";
import { getCourse } from "@/lib/tutor/courses";

const tom: TutorLesson = {
  id: "tom-spanish-1-day-09", courseId: "tom-spanish-1", day: 9,
  title: "Home, rooms, and useful objects",
  communicativeGoal: "Name common places and ask where an object is.",
  grammarFocus: ["¿dónde está...?", "está en", "hay"],
  vocabularyFocus: ["casa", "cocina", "baño", "dormitorio", "mesa", "puerta", "llaves", "dónde"],
  anchorSentences: [
    { source: "Where are the keys?", target: "¿Dónde están las llaves?" },
    { source: "The keys are on the table.", target: "Las llaves están en la mesa." },
    { source: "The bathroom is here.", target: "El baño está aquí." },
    { source: "There is water in the kitchen.", target: "Hay agua en la cocina." },
    { source: "Open the door, please.", target: "Abre la puerta, por favor." }
  ],
  drills: [
    { id: "model-where", kind: "model", instruction: "Listen to dónde están for more than one thing.", sourceText: "Where are the keys?", targetText: "¿Dónde están las llaves?" },
    { id: "repeat-table", kind: "repeat", instruction: "Repeat the complete location sentence.", sourceText: "The keys are on the table.", targetText: "Las llaves están en la mesa.", reviewAfterDays: [1, 3, 7, 14] },
    { id: "substitute-room", kind: "substitution", instruction: "Keep hay agua en and change only the room.", sourceText: "There is water in the kitchen.", targetText: "Hay agua en la cocina.", substitutions: [{ id: "room", prompt: "Change kitchen to bathroom.", values: [{ source: "kitchen", target: "cocina" }, { source: "bathroom", target: "baño" }] }] },
    { id: "recall-bathroom", kind: "recall", instruction: "Say where the bathroom is.", sourceText: "The bathroom is here.", targetText: "El baño está aquí.", hint: "El baño…", reviewAfterDays: [1, 3, 7, 14] },
    { id: "recall-door", kind: "recall", instruction: "Make the polite request.", sourceText: "Open the door, please.", targetText: "Abre la puerta, por favor.", hint: "Abre la…", reviewAfterDays: [1, 3, 7, 14] }
  ],
  miniDialogue: [
    { speaker: "teacher", source: "Where are the keys?", target: "¿Dónde están las llaves?" },
    { speaker: "learner", source: "The keys are on the table.", target: "Las llaves están en la mesa." },
    { speaker: "teacher", source: "Is there water in the kitchen?", target: "¿Hay agua en la cocina?" },
    { speaker: "learner", source: "Yes, there is water in the kitchen.", target: "Sí, hay agua en la cocina." }
  ],
  completion: { minimumIndependentRecalls: 2, minimumSpokenAttempts: 4 }
};

const liz: TutorLesson = {
  id: "liz-english-1-day-09", courseId: "liz-english-1", day: 9,
  title: "Home, rooms, and useful objects",
  communicativeGoal: "Nombrar lugares comunes y preguntar dónde está un objeto.",
  grammarFocus: ["Where is/are...?", "is/are in", "there is"],
  vocabularyFocus: ["home", "kitchen", "bathroom", "bedroom", "table", "door", "keys", "where"],
  anchorSentences: [
    { source: "¿Dónde están las llaves?", target: "Where are the keys?" },
    { source: "Las llaves están en la mesa.", target: "The keys are on the table." },
    { source: "El baño está aquí.", target: "The bathroom is here." },
    { source: "Hay agua en la cocina.", target: "There is water in the kitchen." },
    { source: "Abre la puerta, por favor.", target: "Open the door, please." }
  ],
  drills: [
    { id: "model-where", kind: "model", instruction: "Escucha are porque keys es plural.", sourceText: "¿Dónde están las llaves?", targetText: "Where are the keys?" },
    { id: "repeat-table", kind: "repeat", instruction: "Repite la ubicación completa.", sourceText: "Las llaves están en la mesa.", targetText: "The keys are on the table.", reviewAfterDays: [1, 3, 7, 14] },
    { id: "substitute-room", kind: "substitution", instruction: "Mantén there is water in y cambia el cuarto.", sourceText: "Hay agua en la cocina.", targetText: "There is water in the kitchen.", substitutions: [{ id: "room", prompt: "Cambia kitchen por bathroom.", values: [{ source: "cocina", target: "kitchen" }, { source: "baño", target: "bathroom" }] }] },
    { id: "recall-bathroom", kind: "recall", instruction: "Di dónde está el baño.", sourceText: "El baño está aquí.", targetText: "The bathroom is here.", hint: "The bathroom…", reviewAfterDays: [1, 3, 7, 14] },
    { id: "recall-door", kind: "recall", instruction: "Haz la petición con cortesía.", sourceText: "Abre la puerta, por favor.", targetText: "Open the door, please.", hint: "Open the…", reviewAfterDays: [1, 3, 7, 14] }
  ],
  miniDialogue: [
    { speaker: "teacher", source: "¿Dónde están las llaves?", target: "Where are the keys?" },
    { speaker: "learner", source: "Las llaves están en la mesa.", target: "The keys are on the table." },
    { speaker: "teacher", source: "¿Hay agua en la cocina?", target: "Is there water in the kitchen?" },
    { speaker: "learner", source: "Sí, hay agua en la cocina.", target: "Yes, there is water in the kitchen." }
  ],
  completion: { minimumIndependentRecalls: 2, minimumSpokenAttempts: 4 }
};

export const dayNineLessons = {
  "tom-spanish-1": assertTutorLesson(tom, getCourse("tom-spanish-1")),
  "liz-english-1": assertTutorLesson(liz, getCourse("liz-english-1"))
} as const;
