"use client";

import { useEffect, useMemo, useState } from "react";
import type { CourseConfig, CourseId, LessonDrill, TutorLesson } from "@/lib/tutor/course";

interface CatalogResponse {
  courses?: CourseConfig[];
  course?: CourseConfig;
  lessons?: TutorLesson[];
  error?: string;
}

interface SavedPosition {
  day: number;
  drillIndex: number;
}

const DEFAULT_COURSE: CourseId = "tom-spanish-1";
const COURSE_STORAGE_KEY = "taos.tutor.preview.course";
const positionKey = (courseId: CourseId): string => `taos.tutor.preview.position.${courseId}`;

function readSavedCourse(): CourseId {
  if (typeof window === "undefined") return DEFAULT_COURSE;
  const value = window.localStorage.getItem(COURSE_STORAGE_KEY);
  return value === "liz-english-1" ? value : DEFAULT_COURSE;
}

function readSavedPosition(courseId: CourseId): SavedPosition {
  if (typeof window === "undefined") return { day: 1, drillIndex: 0 };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(positionKey(courseId)) ?? "{}") as Partial<SavedPosition>;
    return {
      day: Number.isInteger(parsed.day) ? Math.min(10, Math.max(1, parsed.day as number)) : 1,
      drillIndex: Number.isInteger(parsed.drillIndex) ? Math.max(0, parsed.drillIndex as number) : 0
    };
  } catch {
    return { day: 1, drillIndex: 0 };
  }
}

export function MirroredTutorPreview(): JSX.Element {
  const [courses, setCourses] = useState<CourseConfig[]>([]);
  const [courseId, setCourseId] = useState<CourseId>(DEFAULT_COURSE);
  const [course, setCourse] = useState<CourseConfig | null>(null);
  const [lessons, setLessons] = useState<TutorLesson[]>([]);
  const [lessonIndex, setLessonIndex] = useState(0);
  const [drillIndex, setDrillIndex] = useState(0);
  const [revealed, setRevealed] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    setCourseId(readSavedCourse());
    setRestored(true);
    fetch("/api/tutor/courses")
      .then((response) => response.json())
      .then((payload: CatalogResponse) => setCourses(payload.courses ?? []))
      .catch(() => setError("Could not load Tutor courses."));
  }, []);

  useEffect(() => {
    if (!restored) return;
    setError(null);
    fetch(`/api/tutor/courses?courseId=${encodeURIComponent(courseId)}`)
      .then((response) => response.json())
      .then((payload: CatalogResponse) => {
        if (payload.error || !payload.course || !payload.lessons?.length) {
          setError(payload.error ?? "This course has no lessons yet.");
          return;
        }
        const position = readSavedPosition(courseId);
        const nextLessonIndex = Math.max(
          0,
          payload.lessons.findIndex((item) => item.day === position.day)
        );
        const lesson = payload.lessons[nextLessonIndex];
        const nextDrillIndex = Math.min(position.drillIndex, Math.max(0, lesson.drills.length - 1));
        setCourse(payload.course);
        setLessons(payload.lessons);
        setLessonIndex(nextLessonIndex);
        setDrillIndex(nextDrillIndex);
        setRevealed(lesson.drills[nextDrillIndex]?.kind !== "recall");
      })
      .catch(() => setError("Could not load this Tutor course."));
  }, [courseId, restored]);

  const lesson = lessons[lessonIndex] ?? null;
  const drill = lesson?.drills[drillIndex] ?? null;
  const progress = useMemo(() => {
    if (!lesson) return 0;
    return ((drillIndex + 1) / lesson.drills.length) * 100;
  }, [drillIndex, lesson]);

  function savePosition(nextLessonIndex: number, nextDrillIndex: number) {
    const nextLesson = lessons[nextLessonIndex];
    if (!nextLesson || typeof window === "undefined") return;
    window.localStorage.setItem(
      positionKey(courseId),
      JSON.stringify({ day: nextLesson.day, drillIndex: nextDrillIndex })
    );
  }

  function chooseCourse(next: CourseId) {
    if (typeof window !== "undefined") window.localStorage.setItem(COURSE_STORAGE_KEY, next);
    setCourseId(next);
  }

  function chooseDay(nextLessonIndex: number) {
    const nextLesson = lessons[nextLessonIndex];
    if (!nextLesson) return;
    setLessonIndex(nextLessonIndex);
    setDrillIndex(0);
    setRevealed(nextLesson.drills[0]?.kind !== "recall");
    savePosition(nextLessonIndex, 0);
  }

  function move(delta: number) {
    if (!lesson) return;
    const nextDrillIndex = drillIndex + delta;
    if (nextDrillIndex >= 0 && nextDrillIndex < lesson.drills.length) {
      setDrillIndex(nextDrillIndex);
      setRevealed(lesson.drills[nextDrillIndex].kind !== "recall");
      savePosition(lessonIndex, nextDrillIndex);
      return;
    }
    const nextLessonIndex = lessonIndex + (delta > 0 ? 1 : -1);
    const nextLesson = lessons[nextLessonIndex];
    if (!nextLesson) return;
    const boundaryDrill = delta > 0 ? 0 : nextLesson.drills.length - 1;
    setLessonIndex(nextLessonIndex);
    setDrillIndex(boundaryDrill);
    setRevealed(nextLesson.drills[boundaryDrill]?.kind !== "recall");
    savePosition(nextLessonIndex, boundaryDrill);
  }

  async function hear(text: string) {
    try {
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, engine: "openai", targetLanguage: course?.targetLanguage })
      });
      if (!response.ok) return;
      const audio = new Audio(URL.createObjectURL(await response.blob()));
      await audio.play();
    } catch {
      // Voice is an enhancement; the lesson remains usable without it.
    }
  }

  const atBeginning = lessonIndex === 0 && drillIndex === 0;
  const atEnd = lessonIndex === lessons.length - 1 && Boolean(lesson) && drillIndex === lesson.drills.length - 1;

  return (
    <main className="min-h-screen px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-[calc(env(safe-area-inset-top)+1rem)]">
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-md flex-col gap-4">
        <header className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-amber-200/55">90-day framework preview</p>
            <h1 className="text-xl font-semibold text-amber-100">TAOS·TUTOR</h1>
          </div>
          <a href="/tutor" className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-xs text-amber-100/75">
            Existing Tutor
          </a>
        </header>

        <section className="grid grid-cols-2 gap-2">
          {(courses.length ? courses : fallbackCourses()).map((item) => {
            const selected = item.id === courseId;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => chooseCourse(item.id)}
                className={`rounded-2xl border p-3 text-left transition ${
                  selected ? "border-amber-300/60 bg-amber-300/15" : "border-white/10 bg-white/5"
                }`}
              >
                <span className="block text-sm font-semibold text-white">{item.learnerName}</span>
                <span className="block text-xs text-amber-100/65">{item.title}</span>
              </button>
            );
          })}
        </section>

        {lessons.length ? (
          <section aria-label="Course days" className="overflow-x-auto pb-1">
            <div className="flex min-w-max gap-2">
              {lessons.map((item, index) => {
                const selected = index === lessonIndex;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => chooseDay(index)}
                    aria-current={selected ? "step" : undefined}
                    className={`min-w-12 rounded-full border px-3 py-2 text-xs font-semibold transition ${
                      selected
                        ? "border-amber-300 bg-amber-300 text-stone-950"
                        : "border-white/10 bg-white/5 text-amber-100/70"
                    }`}
                  >
                    Day {item.day}
                  </button>
                );
              })}
            </div>
          </section>
        ) : null}

        {error ? <p className="rounded-2xl border border-rose-300/20 bg-rose-300/10 p-4 text-sm text-rose-100">{error}</p> : null}

        {course && lesson && drill ? (
          <>
            <section className="rounded-3xl border border-white/10 bg-[rgba(18,44,36,0.72)] p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.18em] text-emerald-100/55">
                    {course.learnerName} · Day {lesson.day} of {lessons.length}
                  </p>
                  <h2 className="mt-1 text-2xl font-semibold text-white">{lesson.title}</h2>
                </div>
                <span className="rounded-full bg-white/5 px-3 py-1 text-xs text-amber-100/70">
                  {drillIndex + 1}/{lesson.drills.length}
                </span>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-amber-50/65">{lesson.communicativeGoal}</p>
              <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-black/20">
                <div className="h-full rounded-full bg-amber-300" style={{ width: `${progress}%` }} />
              </div>
            </section>

            <DrillCard drill={drill} revealed={revealed} onReveal={() => setRevealed(true)} onHear={() => void hear(drill.targetText)} />

            <nav className="grid grid-cols-2 gap-3">
              <button
                type="button"
                disabled={atBeginning}
                onClick={() => move(-1)}
                className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-amber-100 disabled:opacity-30"
              >
                Back
              </button>
              <button
                type="button"
                disabled={atEnd}
                onClick={() => move(1)}
                className="rounded-2xl bg-amber-300 px-4 py-3 text-sm font-semibold text-stone-950 disabled:opacity-30"
              >
                {drillIndex === lesson.drills.length - 1 && lessonIndex < lessons.length - 1
                  ? `Start Day ${lessons[lessonIndex + 1].day}`
                  : atEnd
                    ? "Sprint preview complete"
                    : "Continue"}
              </button>
            </nav>
          </>
        ) : null}
      </div>
    </main>
  );
}

function DrillCard({
  drill,
  revealed,
  onReveal,
  onHear
}: {
  drill: LessonDrill;
  revealed: boolean;
  onReveal: () => void;
  onHear: () => void;
}): JSX.Element {
  const teacherLead =
    drill.kind === "model"
      ? "Listen first."
      : drill.kind === "repeat"
        ? "Now say it with me."
        : drill.kind === "substitution"
          ? "Keep the pattern and change one piece."
          : drill.kind === "recall"
            ? "Let’s try this without looking."
            : "Use what you know.";

  return (
    <section className="flex min-h-[45vh] flex-1 flex-col justify-center rounded-3xl border border-white/10 bg-[rgba(28,22,18,0.88)] p-5">
      <div className="flex items-center justify-between gap-3 text-xs uppercase tracking-[0.16em] text-amber-100/45">
        <span>{teacherLead}</span>
        {drill.reviewAfterDays ? <span>Review · {drill.reviewAfterDays.join(" · ")}</span> : null}
      </div>
      <p className="mt-4 text-base leading-relaxed text-amber-50/70">{drill.instruction}</p>
      {drill.sourceText ? <p className="mt-6 text-xl text-amber-100/65">{drill.sourceText}</p> : null}
      {revealed ? (
        <p className="mt-3 text-pretty text-[clamp(2rem,8vw,3.2rem)] font-semibold leading-tight text-white">{drill.targetText}</p>
      ) : (
        <button type="button" onClick={onReveal} className="mt-5 rounded-2xl border border-amber-300/30 bg-amber-300/10 px-4 py-4 text-left text-amber-100">
          Reveal answer
          {drill.hint ? <span className="mt-1 block text-sm text-amber-100/55">Hint: {drill.hint}</span> : null}
        </button>
      )}
      <button type="button" onClick={onHear} className="mt-5 self-start rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-emerald-100">
        🔊 Hear target
      </button>
      {drill.substitutions?.map((slot) => (
        <div key={slot.id} className="mt-5 rounded-2xl bg-white/5 p-3">
          <p className="text-sm text-amber-100/65">{slot.prompt}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {slot.values.map((value) => (
              <span key={`${slot.id}-${value.target}`} className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/75">
                {value.source} → {value.target}
              </span>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function fallbackCourses(): CourseConfig[] {
  return [
    {
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
        targetLocale: "es-US"
      }
    },
    {
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
        targetLocale: "en-US"
      }
    }
  ];
}
