"use client";

import { useEffect, useState } from "react";
import { getStudyLesson } from "@/lib/supabase";
import { resolveStudyContext, type StudyPracticeRef } from "@/lib/tutor/studyPractice";

/** A Study link must show its prepared text before acquiring the microphone. */
export function StudySentencePreview({ userId, selection, target, learner, onLoaded }: {
  userId: string;
  selection: StudyPracticeRef;
  target: string;
  learner: string;
  onLoaded: (phrase: string) => void;
}): JSX.Element {
  const [phrase, setPhrase] = useState("");
  const [meaning, setMeaning] = useState("");
  const [error, setError] = useState("");
  const { lessonKey, sentenceIndex, chunkIndex, contextKey } = selection;
  useEffect(() => {
    let live = true;
    setPhrase(""); setMeaning(""); setError("");
    void getStudyLesson(userId, lessonKey).then((saved) => {
      if (!live) return;
      if (!saved) throw new Error("This lesson is not saved in this account. Return to Study and open a saved lesson.");
      if (saved.target_lang !== target || saved.explain_lang !== learner) throw new Error("The lesson language direction changed. Return to Study and select the sentence again.");
      const context = resolveStudyContext(saved.lesson, { lessonKey, sentenceIndex, chunkIndex, contextKey });
      if (!context) throw new Error("This sentence has changed. Return to Study and select it again.");
      setPhrase(context.phrase);
      setMeaning(context.sentence.english);
      onLoaded(context.phrase);
    }).catch((reason) => {
      if (live) setError(reason instanceof Error ? reason.message : "Could not load the Study sentence. Return to Study and try again.");
    });
    return () => { live = false; };
  }, [userId, lessonKey, sentenceIndex, chunkIndex, contextKey, target, learner, onLoaded]);
  if (error) return <p role="alert" className="mt-2 text-rose-200">{error}</p>;
  if (!phrase) return <p role="status" className="mt-2">Loading your Study sentence…</p>;
  return <div className="mt-2"><p className="text-lg font-semibold">{phrase}</p><p className="mt-1 text-sm text-amber-100/70">{meaning}</p></div>;
}
