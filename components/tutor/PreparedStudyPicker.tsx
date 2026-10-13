"use client";

import { useEffect, useState } from "react";
import { listStudyLessons, type StudyLessonRow } from "@/lib/supabase";
import { studyContextKey, type StudyPracticeRef } from "@/lib/tutor/studyPractice";

/** Partner can use an owned prepared sentence without arriving via a Study link. */
export function PreparedStudyPicker({ target, learner, selected, onSelect }: {
  target: string;
  learner: string;
  selected?: StudyPracticeRef;
  onSelect: (ref: StudyPracticeRef | undefined, phrase: string) => void;
}): JSX.Element {
  const [lessons, setLessons] = useState<StudyLessonRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  useEffect(() => {
    let live = true;
    void listStudyLessons().then((rows) => {
      if (live) setLessons(rows);
    }).catch(() => { if (live) setError(true); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);
  const options = lessons.filter((row) => row.target_lang === target && row.explain_lang === learner)
    .flatMap((row) => row.lesson.sentences.map((sentence, sentenceIndex) => ({
      ref: { lessonKey: row.lesson_key, sentenceIndex, contextKey: studyContextKey(sentence) },
      phrase: sentence.target
    })));
  const current = options.findIndex((option) => option.ref.lessonKey === selected?.lessonKey && option.ref.sentenceIndex === selected.sentenceIndex);
  return <div className="mt-4 text-sm text-amber-100">
    <label className="block" htmlFor="prepared-study-sentence">Prepared Study sentence</label>
    <select id="prepared-study-sentence" className="mt-2 min-h-[44px] w-full rounded-xl border border-white/15 bg-stone-900 px-3" disabled={loading || error} value={current < 0 ? "" : String(current)} onChange={(e) => {
      const option = e.target.value === "" ? undefined : options[Number(e.target.value)];
      onSelect(option?.ref, option?.phrase ?? "");
    }}>
      <option value="">{loading ? "Loading saved sentences…" : "Free conversation"}</option>
      {options.map((option, i) => <option key={`${option.ref.lessonKey}-${option.ref.sentenceIndex}`} value={i}>{option.phrase}</option>)}
    </select>
    {selected ? <p className="mt-2">The tutor will teach this sentence, then help you build and vary it.</p> : null}
    {!loading && !options.length && !error ? <p className="mt-2">No saved sentences for this language direction. <a href="/study" className="underline">Prepare one in Study</a>.</p> : null}
    {error ? <p role="alert" className="mt-2">Could not load saved sentences. <a href="/study" className="underline">Open Study</a> to try again.</p> : null}
  </div>;
}
