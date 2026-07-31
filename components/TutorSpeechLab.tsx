"use client";

import { useEffect, useState } from "react";
import type { CourseConfig, CourseId, TutorLesson } from "@/lib/tutor/course";
import { TutorSpeechAttempt } from "@/components/TutorSpeechAttempt";

interface CatalogResponse {
  course?: CourseConfig;
  lessons?: TutorLesson[];
  error?: string;
}

export function TutorSpeechLab(): JSX.Element {
  const [courseId, setCourseId] = useState<CourseId>("tom-spanish-1");
  const [course, setCourse] = useState<CourseConfig | null>(null);
  const [lessons, setLessons] = useState<TutorLesson[]>([]);
  const [lessonIndex, setLessonIndex] = useState(0);
  const [drillIndex, setDrillIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    fetch(`/api/tutor/courses?courseId=${encodeURIComponent(courseId)}`)
      .then((response) => response.json())
      .then((payload: CatalogResponse) => {
        if (!payload.course || !payload.lessons?.length) {
          setError(payload.error ?? "No speech lessons are available.");
          return;
        }
        setCourse(payload.course);
        setLessons(payload.lessons);
        setLessonIndex(0);
        setDrillIndex(0);
      })
      .catch(() => setError("Could not load the speech lab."));
  }, [courseId]);

  const lesson = lessons[lessonIndex];
  const drill = lesson?.drills[drillIndex];
  const spanishUi = course?.explanationLanguage === "es";

  return (
    <main className="min-h-screen px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-[calc(env(safe-area-inset-top)+1rem)]">
      <div className="mx-auto flex max-w-md flex-col gap-4">
        <header className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-amber-200/55">Sprint 1 speech lab</p>
            <h1 className="text-xl font-semibold text-amber-100">TAOS·TUTOR</h1>
          </div>
          <a href="/tutor/90day" className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-xs text-amber-100/75">
            Course
          </a>
        </header>

        <section className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setCourseId("tom-spanish-1")}
            className={`rounded-2xl border p-3 text-left ${courseId === "tom-spanish-1" ? "border-amber-300/60 bg-amber-300/15" : "border-white/10 bg-white/5"}`}
          >
            <span className="block font-semibold text-white">Tom</span>
            <span className="text-sm text-amber-100/60">Spanish 1</span>
          </button>
          <button
            type="button"
            onClick={() => setCourseId("liz-english-1")}
            className={`rounded-2xl border p-3 text-left ${courseId === "liz-english-1" ? "border-amber-300/60 bg-amber-300/15" : "border-white/10 bg-white/5"}`}
          >
            <span className="block font-semibold text-white">Liz</span>
            <span className="text-sm text-amber-100/60">English 1</span>
          </button>
        </section>

        {lessons.length ? (
          <select
            value={lessonIndex}
            onChange={(event) => {
              setLessonIndex(Number(event.target.value));
              setDrillIndex(0);
            }}
            className="rounded-2xl border border-white/10 bg-[rgba(36,30,24,0.9)] px-4 py-3 text-white"
          >
            {lessons.map((item, index) => (
              <option key={item.id} value={index} className="bg-stone-900">
                Day {item.day}: {item.title}
              </option>
            ))}
          </select>
        ) : null}

        {lesson ? (
          <select
            value={drillIndex}
            onChange={(event) => setDrillIndex(Number(event.target.value))}
            className="rounded-2xl border border-white/10 bg-[rgba(36,30,24,0.9)] px-4 py-3 text-white"
          >
            {lesson.drills.map((item, index) => (
              <option key={item.id} value={index} className="bg-stone-900">
                {index + 1}. {item.targetText}
              </option>
            ))}
          </select>
        ) : null}

        {error ? <p className="rounded-2xl bg-rose-300/10 p-4 text-rose-100">{error}</p> : null}

        {course && lesson && drill ? (
          <>
            <section className="rounded-3xl border border-white/10 bg-[rgba(18,44,36,0.72)] p-5">
              <p className="text-xs uppercase tracking-[0.16em] text-emerald-100/50">
                {course.learnerName} · Day {lesson.day}
              </p>
              <p className="mt-3 text-sm text-amber-50/65">{drill.sourceText}</p>
              <p className="mt-2 text-3xl font-semibold leading-tight text-white">{drill.targetText}</p>
              <p className="mt-3 text-sm text-amber-100/55">
                {spanishUi ? "Escucha, repite y deja que TAOS te corrija." : "Listen, repeat, and let TAOS coach the attempt."}
              </p>
            </section>
            <TutorSpeechAttempt course={course} drill={drill} />
          </>
        ) : null}
      </div>
    </main>
  );
}
