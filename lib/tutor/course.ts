export type LanguageCode = "en" | "es";
export type LearnerId = "tom" | "liz";
export type CourseId = "tom-spanish-1" | "liz-english-1";

export type DrillKind =
  | "model"
  | "repeat"
  | "substitution"
  | "recall"
  | "listening"
  | "conversation";

export interface TeacherProfile {
  id: string;
  displayName: string;
  explanationLanguage: LanguageCode;
  targetLanguage: LanguageCode;
  targetLocale: "en-US" | "es-US";
  voiceHint?: string;
  avatarHint?: string;
}

export interface CourseConfig {
  id: CourseId;
  learnerId: LearnerId;
  learnerName: string;
  title: string;
  nativeLanguage: LanguageCode;
  targetLanguage: LanguageCode;
  explanationLanguage: LanguageCode;
  pronunciationLocale: "en-US" | "es-US";
  teacher: TeacherProfile;
}

export interface SubstitutionSlot {
  id: string;
  prompt: string;
  values: Array<{
    source: string;
    target: string;
  }>;
}

export interface LessonDrill {
  id: string;
  kind: DrillKind;
  instruction: string;
  sourceText?: string;
  targetText: string;
  hint?: string;
  substitutions?: SubstitutionSlot[];
  reviewAfterDays?: number[];
}

export interface TutorLesson {
  id: string;
  courseId: CourseId;
  day: number;
  title: string;
  communicativeGoal: string;
  grammarFocus: string[];
  vocabularyFocus: string[];
  anchorSentences: Array<{
    source: string;
    target: string;
  }>;
  drills: LessonDrill[];
  miniDialogue: Array<{
    speaker: "teacher" | "learner";
    source?: string;
    target: string;
  }>;
  completion: {
    minimumIndependentRecalls: number;
    minimumSpokenAttempts: number;
  };
}

export function assertCourseConfig(value: CourseConfig): CourseConfig {
  if (value.nativeLanguage === value.targetLanguage) {
    throw new Error(`Course ${value.id} must teach a different target language.`);
  }
  if (value.explanationLanguage !== value.nativeLanguage) {
    throw new Error(`Course ${value.id} explanations must use the learner's native language.`);
  }
  if (value.teacher.targetLanguage !== value.targetLanguage) {
    throw new Error(`Course ${value.id} teacher target language does not match the course.`);
  }
  return value;
}

export function assertTutorLesson(value: TutorLesson, course: CourseConfig): TutorLesson {
  if (value.courseId !== course.id) {
    throw new Error(`Lesson ${value.id} belongs to ${value.courseId}, not ${course.id}.`);
  }
  if (!Number.isInteger(value.day) || value.day < 1 || value.day > 90) {
    throw new Error(`Lesson ${value.id} has an invalid day.`);
  }
  if (value.anchorSentences.length === 0 || value.drills.length === 0) {
    throw new Error(`Lesson ${value.id} must contain anchors and drills.`);
  }
  const ids = new Set<string>();
  for (const drill of value.drills) {
    if (!drill.id || ids.has(drill.id)) {
      throw new Error(`Lesson ${value.id} has a missing or duplicate drill id.`);
    }
    ids.add(drill.id);
    if (!drill.targetText.trim()) {
      throw new Error(`Lesson ${value.id} drill ${drill.id} has no target text.`);
    }
  }
  return value;
}
