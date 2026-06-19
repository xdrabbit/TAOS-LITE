"use client";

import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  getProfile,
  hasAccess,
  saveTutorAttempt,
  supabase,
  type Profile
} from "@/lib/supabase";
import { blobToWav16k } from "@/lib/tutor/wav";
import { SignIn } from "./SignIn";
import { Paywall } from "./Paywall";

interface Drill {
  en: string;
  es: string;
}
interface Lesson {
  id: string;
  day: number;
  title: string;
  drills: Drill[];
}
interface WordScore {
  word: string;
  accuracy: number | null;
}
interface AssessResult {
  configured: boolean;
  message?: string;
  error?: string;
  transcript?: string;
  pron?: number | null;
  accuracy?: number | null;
  fluency?: number | null;
  words?: WordScore[];
  coaching?: string;
}

type Status = "idle" | "recording" | "scoring";

function scoreColor(n: number | null | undefined): string {
  if (typeof n !== "number") return "text-amber-100/60";
  if (n >= 80) return "text-emerald-300";
  if (n >= 60) return "text-amber-300";
  return "text-rose-300";
}

export function TutorShell(): JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    async function load(next: Session | null) {
      setProfile(next ? await getProfile() : null);
      if (active) setReady(true);
    }
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      void load(data.session);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, next) => {
      setSession(next);
      void load(next);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  if (!ready) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="animate-pulse text-amber-200/70">Loading…</p>
      </main>
    );
  }
  if (!session) return <SignIn />;
  if (!hasAccess(profile)) {
    return (
      <Paywall
        email={session.user.email ?? ""}
        trialExpired={profile?.subscription_status === "trialing"}
        onSignOut={() => void supabase.auth.signOut()}
      />
    );
  }
  return <Drills />;
}

function Drills(): JSX.Element {
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [lessonIdx, setLessonIdx] = useState(0);
  const [drillIdx, setDrillIdx] = useState(0);
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<AssessResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef("");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/tutor/lessons")
      .then((r) => r.json())
      .then((d: { lessons?: Lesson[]; error?: string }) => {
        if (!active) return;
        setLessons(d.lessons ?? []);
        if (d.error) setLoadError(d.error);
      })
      .catch((e) => active && setLoadError(e instanceof Error ? e.message : "Could not load lessons."));
    return () => {
      active = false;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const lesson = lessons[lessonIdx];
  const drill = lesson?.drills[drillIdx];

  function audioEl(): HTMLAudioElement | null {
    if (!audioRef.current && typeof Audio !== "undefined") audioRef.current = new Audio();
    return audioRef.current;
  }

  async function hear() {
    if (!drill) return;
    const a = audioEl();
    if (!a) return;
    try {
      a.play().catch(() => {});
      a.pause();
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: drill.en, engine: "openai" })
      });
      if (!res.ok) return;
      const url = URL.createObjectURL(await res.blob());
      a.src = url;
      await a.play();
    } catch {
      /* ignore */
    }
  }

  function goto(nextLesson: number, nextDrill: number) {
    setLessonIdx(nextLesson);
    setDrillIdx(nextDrill);
    setResult(null);
    setError(null);
  }

  function nextDrillStep() {
    if (!lesson) return;
    if (drillIdx + 1 < lesson.drills.length) goto(lessonIdx, drillIdx + 1);
    else if (lessonIdx + 1 < lessons.length) goto(lessonIdx + 1, 0);
  }

  async function startRecording() {
    setError(null);
    setResult(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Microphone not available. Use HTTPS and allow mic access.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/mp4")
          ? "audio/mp4"
          : "";
      mimeRef.current = mime;
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (ev) => ev.data.size > 0 && chunksRef.current.push(ev.data);
      recorder.onstop = () => void score();
      recorder.start();
      recorderRef.current = recorder;
      setStatus("recording");
    } catch {
      setError("Microphone permission denied.");
    }
  }

  function stopRecording() {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      setStatus("scoring");
      recorder.stop();
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  async function score() {
    const blob = new Blob(chunksRef.current, { type: mimeRef.current || "audio/webm" });
    recorderRef.current = null;
    if (!drill || blob.size === 0) {
      setStatus("idle");
      return;
    }
    try {
      const wav = await blobToWav16k(blob);
      const form = new FormData();
      form.append("audio", wav, "attempt.wav");
      form.append("referenceText", drill.en);
      form.append("language", "en-US");
      const res = await fetch("/api/tutor/assess", { method: "POST", body: form });
      const payload = (await res.json().catch(() => ({}))) as AssessResult;
      if (!res.ok && !payload.configured) {
        throw new Error(payload.error || "Scoring failed.");
      }
      setResult(payload);
      if (payload.configured && typeof payload.pron === "number") {
        void saveTutorAttempt({
          course: "es-en-30day",
          lesson_id: lesson.id,
          target_phrase: drill.en,
          transcript: payload.transcript ?? null,
          target_lang: "en",
          accuracy_score: payload.accuracy ?? null,
          fluency_score: payload.fluency ?? null,
          pron_score: payload.pron ?? null,
          word_scores: payload.words ?? null
        }).catch(() => {});
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scoring failed.");
    } finally {
      setStatus("idle");
    }
  }

  const recording = status === "recording";
  const scoring = status === "scoring";

  return (
    <main className="min-h-screen px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-[calc(env(safe-area-inset-top)+1rem)]">
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-md flex-col gap-4">
        <header className="flex items-center justify-between gap-2">
          <h1 className="text-lg font-semibold tracking-tight text-amber-200">TAOS·TUTOR</h1>
          <a href="/" className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-amber-100/70">
            ← Translator
          </a>
        </header>

        {/* Lesson picker */}
        {lessons.length > 0 ? (
          <select
            value={lessonIdx}
            onChange={(e) => goto(Number(e.target.value), 0)}
            className="rounded-2xl border border-white/10 bg-[rgba(36,30,24,0.8)] px-3 py-3 text-base text-white outline-none focus:border-amber-300/50"
          >
            {lessons.map((l, i) => (
              <option key={l.id} value={i} className="bg-stone-900">
                Day {l.day} — {l.title}
              </option>
            ))}
          </select>
        ) : (
          <p className="text-amber-100/60">{loadError ?? "Loading lessons…"}</p>
        )}

        {/* Drill card */}
        {drill ? (
          <section className="flex flex-1 flex-col gap-3">
            <div className="flex min-h-[30vh] flex-1 flex-col justify-center rounded-3xl border border-white/10 bg-[rgba(18,44,36,0.7)] p-5">
              <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-[0.18em] text-emerald-100/50">
                <span>Say it in English</span>
                <span>
                  {drillIdx + 1} / {lesson.drills.length}
                </span>
              </div>
              <p className="text-pretty text-[clamp(1.8rem,7vw,2.8rem)] font-semibold leading-tight text-white">
                {drill.en}
              </p>
              <p className="mt-3 text-base text-amber-50/55">{drill.es}</p>
              <button
                type="button"
                onClick={() => void hear()}
                className="mt-4 self-start rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-emerald-100"
              >
                🔊 Hear it
              </button>
            </div>

            {/* Result */}
            {result ? (
              result.configured === false ? (
                <p className="rounded-2xl border border-amber-400/20 bg-amber-400/5 px-4 py-3 text-sm text-amber-100/80">
                  {result.message}
                </p>
              ) : (
                <div className="rounded-2xl border border-white/10 bg-[rgba(20,16,14,0.86)] p-4">
                  <div className="flex items-baseline justify-between">
                    <span className="text-sm text-amber-100/60">Pronunciation</span>
                    <span className={`text-3xl font-bold ${scoreColor(result.pron ?? null)}`}>
                      {typeof result.pron === "number" ? Math.round(result.pron) : "—"}
                    </span>
                  </div>
                  {result.words && result.words.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {result.words.map((w, i) => (
                        <span
                          key={`${w.word}-${i}`}
                          className={`rounded-md bg-white/5 px-2 py-1 text-sm ${scoreColor(w.accuracy)}`}
                        >
                          {w.word}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {result.coaching ? (
                    <p className="mt-3 text-sm text-amber-50/85">{result.coaching}</p>
                  ) : null}
                </div>
              )
            ) : null}

            {error ? (
              <p className="rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                {error}
              </p>
            ) : null}

            {/* Controls */}
            <div className="flex flex-col gap-2 rounded-3xl border border-white/10 bg-[rgba(20,16,14,0.86)] p-4">
              <button
                type="button"
                onClick={() => (recording ? stopRecording() : void startRecording())}
                disabled={scoring}
                className={`flex h-16 items-center justify-center gap-3 rounded-2xl text-lg font-semibold transition active:scale-[0.99] disabled:opacity-60 ${
                  recording
                    ? "animate-pulse bg-amber-400 text-stone-950"
                    : "border border-amber-300/30 bg-stone-50 text-stone-900 hover:bg-white"
                }`}
              >
                <span className={`inline-block rounded-[6px] ${recording ? "h-4 w-4 bg-stone-900/85" : "h-5 w-5 bg-amber-500"}`} />
                {recording ? "Stop" : scoring ? "Scoring…" : "Hold-to-talk: say it"}
              </button>
              <div className="flex justify-between text-sm">
                <button type="button" onClick={() => void startRecording()} disabled={recording || scoring} className="text-amber-100/60 disabled:opacity-40">
                  Try again
                </button>
                <button type="button" onClick={nextDrillStep} className="font-medium text-amber-300">
                  Next phrase →
                </button>
              </div>
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}
