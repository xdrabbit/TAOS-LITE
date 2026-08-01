"use client";

import { useEffect, useMemo, useState } from "react";
import { TutorSpeechAttempt } from "@/components/TutorSpeechAttempt";
import type { CourseConfig, LessonDrill, TutorLesson } from "@/lib/tutor/course";

async function playTarget(text: string, targetLanguage: "en" | "es", speed: "normal" | "slow") {
  const response = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, engine: "openai", targetLanguage, speed })
  });
  if (!response.ok) return;
  const url = URL.createObjectURL(await response.blob());
  const audio = new Audio(url);
  audio.onended = () => URL.revokeObjectURL(url);
  await audio.play();
}

export function TutorGuidedDialogue({
  course,
  lesson
}: {
  course: CourseConfig;
  lesson: TutorLesson;
}): JSX.Element | null {
  const [turnIndex, setTurnIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const spanishUi = course.explanationLanguage === "es";

  useEffect(() => {
    setTurnIndex(0);
    setRevealed(false);
  }, [course.id, lesson.id]);

  const learnerTurns = useMemo(
    () => lesson.miniDialogue.filter((turn) => turn.speaker === "learner"),
    [lesson.miniDialogue]
  );
  if (!learnerTurns.length) return null;

  const learnerTurn = learnerTurns[turnIndex];
  const originalIndex = lesson.miniDialogue.findIndex(
    (turn, index) =>
      turn.speaker === "learner" &&
      turn.target === learnerTurn.target &&
      lesson.miniDialogue.slice(0, index).filter((item) => item.speaker === "learner").length === turnIndex
  );
  const teacherTurn = [...lesson.miniDialogue.slice(0, originalIndex)]
    .reverse()
    .find((turn) => turn.speaker === "teacher");

  const speechDrill: LessonDrill = {
    id: `${lesson.id}-dialogue-${turnIndex + 1}`,
    kind: "conversation",
    instruction: spanishUi ? "Responde a la profesora." : "Answer the teacher.",
    sourceText: learnerTurn.source,
    targetText: learnerTurn.target,
    reviewAfterDays: [1, 3, 7, 14]
  };

  const finalTurn = turnIndex === learnerTurns.length - 1;
  const heading =
    lesson.day === 10
      ? spanishUi
        ? "Conversación de desempeño"
        : "Performance conversation"
      : lesson.day === 7
        ? spanishUi
          ? "Conversación de repaso"
          : "Review conversation"
        : spanishUi
          ? "Mini conversación"
          : "Mini conversation";

  return (
    <section className="rounded-3xl border border-amber-300/20 bg-[rgba(18,44,36,0.55)] p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-amber-200/55">
            {heading}
          </p>
          <h3 className="mt-1 text-xl font-semibold text-white">
            {spanishUi ? "Ahora úsalo en una conversación." : "Now use it in a conversation."}
          </h3>
        </div>
        <span className="rounded-full bg-white/5 px-3 py-1 text-xs text-amber-100/65">
          {turnIndex + 1}/{learnerTurns.length}
        </span>
      </div>

      {teacherTurn ? (
        <div className="mt-5 rounded-2xl border border-white/10 bg-black/15 p-4">
          <p className="text-xs uppercase tracking-[0.14em] text-emerald-100/45">
            {spanishUi ? "La profesora pregunta" : "The teacher asks"}
          </p>
          <p className="mt-2 text-lg text-white">{teacherTurn.target}</p>
          <button
            type="button"
            onClick={() => void playTarget(teacherTurn.target, course.targetLanguage, "normal")}
            className="mt-3 rounded-full border border-white/10 bg-white/5 px-3 py-2 text-sm text-emerald-100"
          >
            🔊 {spanishUi ? "Escuchar pregunta" : "Hear question"}
          </button>
        </div>
      ) : null}

      <div className="mt-4 rounded-2xl border border-amber-300/20 bg-amber-300/5 p-4">
        <p className="text-xs uppercase tracking-[0.14em] text-amber-100/45">
          {spanishUi ? "Tu respuesta" : "Your answer"}
        </p>
        {learnerTurn.source ? (
          <p className="mt-2 text-base text-amber-50/65">{learnerTurn.source}</p>
        ) : null}
        {revealed ? (
          <p className="mt-2 text-2xl font-semibold text-white">{learnerTurn.target}</p>
        ) : (
          <button
            type="button"
            onClick={() => setRevealed(true)}
            className="mt-3 w-full rounded-2xl border border-amber-300/30 bg-amber-300/10 px-4 py-3 text-left text-amber-100"
          >
            {spanishUi ? "Mostrar respuesta modelo" : "Reveal model answer"}
          </button>
        )}
      </div>

      {revealed ? <TutorSpeechAttempt course={course} drill={speechDrill} /> : null}

      <button
        type="button"
        disabled={!revealed}
        onClick={() => {
          if (!finalTurn) {
            setTurnIndex((value) => value + 1);
            setRevealed(false);
          }
        }}
        className="mt-4 w-full rounded-2xl bg-amber-300 px-4 py-3 font-semibold text-stone-950 disabled:opacity-35"
      >
        {finalTurn
          ? spanishUi
            ? "Conversación completa"
            : "Conversation complete"
          : spanishUi
            ? "Siguiente turno"
            : "Next turn"}
      </button>
    </section>
  );
}
