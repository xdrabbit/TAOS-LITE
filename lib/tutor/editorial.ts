import type { CourseId, TutorLesson } from "./course";

type Anchor = TutorLesson["anchorSentences"][number];
type SubstitutionValue = NonNullable<TutorLesson["drills"][number]["substitutions"]>[number]["values"][number];

interface EditorialOverlay {
  takeaway: string;
  usageNote: string;
  extraAnchors: Anchor[];
  extraSubstitutions: SubstitutionValue[];
}

const overlays: Record<CourseId, Record<number, EditorialOverlay>> = {
  "tom-spanish-1": {
    1: {
      takeaway: "Put no directly before the verb: no tengo, no quiero, no necesito.",
      usageNote: "Spanish often drops yo once the verb form makes the subject clear.",
      extraAnchors: [
        { source: "I want water.", target: "Quiero agua." },
        { source: "I need more time.", target: "Necesito más tiempo." }
      ],
      extraSubstitutions: [
        { source: "tea", target: "té" },
        { source: "more time", target: "más tiempo" }
      ]
    },
    2: {
      takeaway: "A rising voice can turn a statement into a yes-or-no question.",
      usageNote: "Use ¿ at the beginning and ? at the end of written Spanish questions.",
      extraAnchors: [
        { source: "Do you have water?", target: "¿Tienes agua?" },
        { source: "Yes, I have water.", target: "Sí, tengo agua." }
      ],
      extraSubstitutions: [
        { source: "coffee", target: "café" },
        { source: "help", target: "ayuda" }
      ]
    },
    3: {
      takeaway: "Spanish verb endings change with the person: quiero, quieres, quiere, queremos.",
      usageNote: "Use usted for a respectful singular you; its verb matches él and ella.",
      extraAnchors: [
        { source: "We need help.", target: "Necesitamos ayuda." },
        { source: "She has time.", target: "Ella tiene tiempo." }
      ],
      extraSubstitutions: [
        { source: "we", target: "nosotros" },
        { source: "she", target: "ella" }
      ]
    },
    4: {
      takeaway: "High-frequency present-tense verbs let you describe ordinary life immediately.",
      usageNote: "Learn each useful verb inside a whole sentence, not as an isolated label.",
      extraAnchors: [
        { source: "I work at home.", target: "Trabajo en casa." },
        { source: "I eat now.", target: "Como ahora." }
      ],
      extraSubstitutions: [
        { source: "at home", target: "en casa" },
        { source: "now", target: "ahora" }
      ]
    },
    5: {
      takeaway: "Time words can usually sit at the beginning or end of a simple sentence.",
      usageNote: "Hoy and mañana are compact anchors that make a basic sentence immediately useful.",
      extraAnchors: [
        { source: "I work today.", target: "Trabajo hoy." },
        { source: "We are going tomorrow.", target: "Vamos mañana." }
      ],
      extraSubstitutions: [
        { source: "later", target: "después" },
        { source: "now", target: "ahora" }
      ]
    },
    6: {
      takeaway: "Quiero plus a food or drink is enough to make a clear, polite request.",
      usageNote: "Add por favor to soften a request without changing its grammar.",
      extraAnchors: [
        { source: "I want fish, please.", target: "Quiero pescado, por favor." },
        { source: "I like coffee.", target: "Me gusta el café." }
      ],
      extraSubstitutions: [
        { source: "fish", target: "pescado" },
        { source: "rice", target: "arroz" }
      ]
    },
    7: {
      takeaway: "Review means combining old pieces quickly, not learning more pieces.",
      usageNote: "Pause before revealing an answer; the effort to retrieve it is the learning event.",
      extraAnchors: [
        { source: "Do you need help now?", target: "¿Necesitas ayuda ahora?" },
        { source: "We have time tomorrow.", target: "Tenemos tiempo mañana." }
      ],
      extraSubstitutions: [
        { source: "now", target: "ahora" },
        { source: "later", target: "después" }
      ]
    },
    8: {
      takeaway: "Use cuánto cuesta to ask a price and quiero to state the item you choose.",
      usageNote: "Spanish question words carry an accent when they ask a direct question.",
      extraAnchors: [
        { source: "How much does this cost?", target: "¿Cuánto cuesta esto?" },
        { source: "I want the blue one.", target: "Quiero el azul." }
      ],
      extraSubstitutions: [
        { source: "the red one", target: "el rojo" },
        { source: "the blue one", target: "el azul" }
      ]
    },
    9: {
      takeaway: "Use está for one object and están for more than one.",
      usageNote: "En can mean in, on, or at; the real-world location supplies the exact meaning.",
      extraAnchors: [
        { source: "The phone is on the table.", target: "El teléfono está en la mesa." },
        { source: "The keys are in the room.", target: "Las llaves están en el cuarto." }
      ],
      extraSubstitutions: [
        { source: "on the table", target: "en la mesa" },
        { source: "in the room", target: "en el cuarto" }
      ]
    },
    10: {
      takeaway: "A conversation is a chain of small familiar moves, not one giant performance.",
      usageNote: "When a word disappears, keep the conversation alive with a simpler sentence you already know.",
      extraAnchors: [
        { source: "I need help, please.", target: "Necesito ayuda, por favor." },
        { source: "We are going home tomorrow.", target: "Vamos a casa mañana." }
      ],
      extraSubstitutions: [
        { source: "today", target: "hoy" },
        { source: "later", target: "después" }
      ]
    }
  },
  "liz-english-1": {
    1: {
      takeaway: "Use don't before the base verb: I don't have, I don't want, I don't need.",
      usageNote: "English normally requires the subject I even when the meaning is obvious.",
      extraAnchors: [
        { source: "Yo quiero agua.", target: "I want water." },
        { source: "Yo necesito más tiempo.", target: "I need more time." }
      ],
      extraSubstitutions: [
        { source: "té", target: "tea" },
        { source: "más tiempo", target: "more time" }
      ]
    },
    2: {
      takeaway: "Use do at the beginning of a present-tense yes-or-no question.",
      usageNote: "The main verb stays in its base form after do: Do you want, not Do you wants.",
      extraAnchors: [
        { source: "¿Tienes agua?", target: "Do you have water?" },
        { source: "Sí, tengo agua.", target: "Yes, I have water." }
      ],
      extraSubstitutions: [
        { source: "café", target: "coffee" },
        { source: "ayuda", target: "help" }
      ]
    },
    3: {
      takeaway: "English verbs usually change only for he, she, or it in the simple present.",
      usageNote: "Use you for both singular and plural; context tells you who is included.",
      extraAnchors: [
        { source: "Nosotros necesitamos ayuda.", target: "We need help." },
        { source: "Ella tiene tiempo.", target: "She has time." }
      ],
      extraSubstitutions: [
        { source: "nosotros", target: "we" },
        { source: "ella", target: "she" }
      ]
    },
    4: {
      takeaway: "A small group of present-tense verbs can describe most daily routines.",
      usageNote: "Keep the subject visible in English: I work, I eat, I go.",
      extraAnchors: [
        { source: "Trabajo en casa.", target: "I work at home." },
        { source: "Como ahora.", target: "I eat now." }
      ],
      extraSubstitutions: [
        { source: "en casa", target: "at home" },
        { source: "ahora", target: "now" }
      ]
    },
    5: {
      takeaway: "Today, tomorrow, now, and later make simple sentences precise.",
      usageNote: "Time words often sound most natural at the end of a short English sentence.",
      extraAnchors: [
        { source: "Trabajo hoy.", target: "I work today." },
        { source: "Vamos mañana.", target: "We are going tomorrow." }
      ],
      extraSubstitutions: [
        { source: "después", target: "later" },
        { source: "ahora", target: "now" }
      ]
    },
    6: {
      takeaway: "Use I want plus the item, and add please to make the request polite.",
      usageNote: "Like needs an object: I like coffee, I like fish.",
      extraAnchors: [
        { source: "Quiero pescado, por favor.", target: "I want fish, please." },
        { source: "Me gusta el café.", target: "I like coffee." }
      ],
      extraSubstitutions: [
        { source: "pescado", target: "fish" },
        { source: "arroz", target: "rice" }
      ]
    },
    7: {
      takeaway: "Review is practice combining familiar patterns without visual support.",
      usageNote: "Try to answer before revealing; retrieval strengthens memory more than rereading.",
      extraAnchors: [
        { source: "¿Necesitas ayuda ahora?", target: "Do you need help now?" },
        { source: "Tenemos tiempo mañana.", target: "We have time tomorrow." }
      ],
      extraSubstitutions: [
        { source: "ahora", target: "now" },
        { source: "después", target: "later" }
      ]
    },
    8: {
      takeaway: "Use How much does this cost? for price and I want for your choice.",
      usageNote: "After does, the main verb remains cost, not costs.",
      extraAnchors: [
        { source: "¿Cuánto cuesta esto?", target: "How much does this cost?" },
        { source: "Quiero el azul.", target: "I want the blue one." }
      ],
      extraSubstitutions: [
        { source: "el rojo", target: "the red one" },
        { source: "el azul", target: "the blue one" }
      ]
    },
    9: {
      takeaway: "Use is for one object and are for more than one.",
      usageNote: "English separates in, on, and at more sharply than Spanish en.",
      extraAnchors: [
        { source: "El teléfono está en la mesa.", target: "The phone is on the table." },
        { source: "Las llaves están en el cuarto.", target: "The keys are in the room." }
      ],
      extraSubstitutions: [
        { source: "en la mesa", target: "on the table" },
        { source: "en el cuarto", target: "in the room" }
      ]
    },
    10: {
      takeaway: "A conversation is built from small familiar sentences connected one at a time.",
      usageNote: "When a word is missing, keep speaking with a simpler sentence you already control.",
      extraAnchors: [
        { source: "Necesito ayuda, por favor.", target: "I need help, please." },
        { source: "Vamos a casa mañana.", target: "We are going home tomorrow." }
      ],
      extraSubstitutions: [
        { source: "hoy", target: "today" },
        { source: "después", target: "later" }
      ]
    }
  }
};

function dedupeAnchors(anchors: Anchor[]): Anchor[] {
  const seen = new Set<string>();
  return anchors.filter((anchor) => {
    const key = `${anchor.source}\u0000${anchor.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function enrichSubstitutions(lesson: TutorLesson, values: SubstitutionValue[]): TutorLesson["drills"] {
  let applied = false;
  return lesson.drills.map((drill) => {
    if (applied || drill.kind !== "substitution" || !drill.substitutions?.length) return drill;
    applied = true;
    const [first, ...rest] = drill.substitutions;
    const seen = new Set(first.values.map((value) => `${value.source}\u0000${value.target}`));
    const additions = values.filter((value) => {
      const key = `${value.source}\u0000${value.target}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return {
      ...drill,
      substitutions: [{ ...first, values: [...first.values, ...additions] }, ...rest]
    };
  });
}

export function applyEditorialPass(lesson: TutorLesson): TutorLesson {
  const overlay = overlays[lesson.courseId]?.[lesson.day];
  if (!overlay) return lesson;
  return {
    ...lesson,
    anchorSentences: dedupeAnchors([...lesson.anchorSentences, ...overlay.extraAnchors]),
    drills: enrichSubstitutions(lesson, overlay.extraSubstitutions),
    takeaway: overlay.takeaway,
    usageNote: overlay.usageNote
  };
}
