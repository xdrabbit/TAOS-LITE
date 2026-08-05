import type { TutorLesson } from "./course";

const guidance: Record<number, { takeaway: string; usageNote: string }> = {
  1: {
    takeaway: "Usa don't antes del verbo base: I don't have, I don't want, I don't need.",
    usageNote: "En inglés normalmente debes decir el sujeto I, aunque el significado ya sea evidente."
  },
  2: {
    takeaway: "Usa do al principio de una pregunta de sí o no en presente.",
    usageNote: "Después de do, el verbo principal queda en su forma base: Do you want, no Do you wants."
  },
  3: {
    takeaway: "En presente simple, el verbo normalmente cambia solamente con he, she o it.",
    usageNote: "You sirve para una persona o varias; el contexto indica a quién incluye."
  },
  4: {
    takeaway: "Un grupo pequeño de verbos en presente permite describir casi toda la rutina diaria.",
    usageNote: "Mantén visible el sujeto en inglés: I work, I eat, I go."
  },
  5: {
    takeaway: "Today, tomorrow, now y later hacen que una oración sencilla sea precisa.",
    usageNote: "En una oración corta en inglés, las palabras de tiempo suelen sonar naturales al final."
  },
  6: {
    takeaway: "Usa I want más el objeto y agrega please para hacer una petición cortés.",
    usageNote: "Like necesita un objeto: I like coffee, I like fish."
  },
  7: {
    takeaway: "Repasar significa combinar patrones conocidos sin apoyo visual.",
    usageNote: "Intenta responder antes de revelar; recuperar la frase fortalece más la memoria que releerla."
  },
  8: {
    takeaway: "Usa How much does this cost? para preguntar el precio e I want para elegir.",
    usageNote: "Después de does, el verbo principal sigue como cost, no costs."
  },
  9: {
    takeaway: "Usa is para un objeto y are para más de uno.",
    usageNote: "El inglés distingue in, on y at con más precisión que el español distingue los usos de en."
  },
  10: {
    takeaway: "Una conversación se construye conectando oraciones pequeñas y conocidas, una por una.",
    usageNote: "Cuando te falte una palabra, sigue hablando con una oración más sencilla que ya controles."
  }
};

export function applyLizEditorialGuidance(lesson: TutorLesson): TutorLesson {
  if (lesson.courseId !== "liz-english-1") return lesson;
  const item = guidance[lesson.day];
  return item ? { ...lesson, ...item } : lesson;
}
