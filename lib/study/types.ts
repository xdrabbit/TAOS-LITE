// Shapes shared by the Study route, its store, and the screen.
//
// Client-safe on purpose: nothing in here imports Node. lib/study/lesson.ts
// (the prompt and the OpenAI call) is server-only and imports from here, never
// the other way round, so the screen can type a lesson without dragging
// node:crypto into the browser bundle.

/** One row of taos_lite_translations as the lesson sees it. */
export interface StudySource {
  id: string;
  created_at: string;
  session_id: string | null;
  source_lang: string;
  target_lang: string;
  original_text: string;
  translation_text: string;
}

export interface StudyWord {
  text: string;
  lemma: string;
  /** Its meaning here, in the explain language. */
  gloss: string;
  /** Shortest stand-in for the word-for-word line, in the explain language. */
  literal: string;
  role: string;
  note: string;
}

export interface StudyOrderPoint {
  rule: string;
  explanation: string;
  example: string;
}

export interface StudySentence {
  /** The clean, natural sentence being taught, in the target language. */
  target: string;
  /** What speech-to-text captured, when it differed from `target`; else "". */
  as_said: string;
  /** The sentence's meaning, in the explain language. */
  english: string;
  words: StudyWord[];
  /** Assembled from each word's `literal` in target order — never model-written. */
  literal: string;
  /** The mistake an explain-language speaker would make; "" when order is flexible. */
  english_order_trap: string;
  order_points: StudyOrderPoint[];
  context_meaning: string;
  register: string;
  /** Build-up practice, shortest first, always ending on the whole sentence. */
  chunks: string[];
}

export interface StudyLesson {
  target_language: string;
  explain_language: string;
  caveats: string;
  sentences: StudySentence[];
}

/** What POST /api/study/lesson answers with. */
export interface StudyLessonResponse {
  id: string;
  key: string;
  lesson: StudyLesson;
  cached: boolean;
  model: string | null;
  target: string;
  explain: string;
  sources: StudySource[];
}
