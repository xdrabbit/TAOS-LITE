import { assertCourseConfig, type CourseConfig, type CourseId } from "./course";

const courses: Record<CourseId, CourseConfig> = {
  "tom-spanish-1": assertCourseConfig({
    id: "tom-spanish-1",
    learnerId: "tom",
    learnerName: "Tom",
    title: "Spanish 1",
    nativeLanguage: "en",
    targetLanguage: "es",
    explanationLanguage: "en",
    pronunciationLocale: "es-US",
    teacher: {
      id: "spanish-1-guide",
      displayName: "Your Spanish teacher",
      explanationLanguage: "en",
      targetLanguage: "es",
      targetLocale: "es-US",
      voiceHint: "warm-latin-american-spanish",
      avatarHint: "attentive-bilingual-teacher"
    }
  }),
  "liz-english-1": assertCourseConfig({
    id: "liz-english-1",
    learnerId: "liz",
    learnerName: "Liz",
    title: "English 1",
    nativeLanguage: "es",
    targetLanguage: "en",
    explanationLanguage: "es",
    pronunciationLocale: "en-US",
    teacher: {
      id: "english-1-guide",
      displayName: "Tu profesora de inglés",
      explanationLanguage: "es",
      targetLanguage: "en",
      targetLocale: "en-US",
      voiceHint: "clear-american-english",
      avatarHint: "attentive-bilingual-teacher"
    }
  })
};

export function listCourses(): CourseConfig[] {
  return Object.values(courses);
}

export function getCourse(courseId: CourseId): CourseConfig {
  return courses[courseId];
}
