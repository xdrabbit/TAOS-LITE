"use client";

import { useEffect, useRef, useState } from "react";
import type { CourseConfig, LessonDrill } from "@/lib/tutor/course";
import { blobToWav16k } from "@/lib/tutor/wav";

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

type SpeechStatus = "idle" | "recording" | "scoring";

function scoreTone(score: number | null | undefined): string {
  if (typeof score !== "number") return "text-amber-100/55";
  if (score >= 80) return "text-emerald-300";
  if (score >= 60) return "text-amber-300";
  return "text-rose-300";
}

export function TutorSpeechAttempt({ course, drill }: { course: CourseConfig; drill: LessonDrill }): JSX.Element {
  const [status, setStatus] = useState<SpeechStatus>("idle");
  const [result, setResult] = useState<AssessResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const spanishUi = course.explanationLanguage === "es";

  useEffect(() => {
    setResult(null);
    setError(null);
    setStatus("idle");
  }, [course.id, drill.id]);

  useEffect(() => () => streamRef.current?.getTracks().forEach((track) => track.stop()), []);

  function cleanupStream() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }

  async function hear(speed: number) {
    setError(null);
    try {
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: drill.targetText,
          engine: "openai",
          targetLanguage: course.targetLanguage,
          speed
        })
      });
      if (!response.ok) throw new Error(spanishUi ? "No se pudo reproducir la voz." : "Voice playback failed.");
      const url = URL.createObjectURL(await response.blob());
      if (!audioRef.current) audioRef.current = new Audio();
      audioRef.current.src = url;
      await audioRef.current.play();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Voice playback failed.");
    }
  }

  async function startRecording() {
    setError(null);
    setResult(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError(spanishUi ? "El micrófono no está disponible. Abre esta página con HTTPS." : "The microphone is unavailable. Open this page over HTTPS.");
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
      chunksRef.current = [];
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      recorder.ondataavailable = (event) => event.data.size > 0 && chunksRef.current.push(event.data);
      recorder.onstop = () => void scoreAttempt();
      recorder.onerror = () => stopRecording();
      for (const track of stream.getAudioTracks()) track.onended = () => stopRecording();
      recorder.start();
      recorderRef.current = recorder;
      setStatus("recording");
    } catch {
      cleanupStream();
      setError(spanishUi ? "No se permitió usar el micrófono." : "Microphone permission was denied.");
    }
  }

  function stopRecording() {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      setStatus("scoring");
      recorder.stop();
    }
    cleanupStream();
  }

  async function scoreAttempt() {
    const blob = new Blob(chunksRef.current, { type: mimeRef.current || "audio/webm" });
    recorderRef.current = null;
    chunksRef.current = [];
    if (!blob.size) {
      setStatus("idle");
      return;
    }
    try {
      const wav = await blobToWav16k(blob);
      const form = new FormData();
      form.append("audio", wav, "attempt.wav");
      form.append("referenceText", drill.targetText);
      form.append("language", course.pronunciationLocale);
      form.append("targetLanguage", course.targetLanguage);
      form.append("explanationLanguage", course.explanationLanguage);
      const response = await fetch("/api/tutor/assess", { method: "POST", body: form });
      const payload = (await response.json().catch(() => ({}))) as AssessResult;
      if (!response.ok) throw new Error(payload.error || "Pronunciation scoring failed.");
      setResult(payload);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : spanishUi ? "No se pudo evaluar la pronunciación." : "Pronunciation scoring failed.");
    } finally {
      setStatus("idle");
    }
  }

  const recording = status === "recording";
  const scoring = status === "scoring";

  return (
    <section className="rounded-3xl border border-white/10 bg-white/[0.035] p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.16em] text-emerald-100/45">
            {spanishUi ? "Escucha y habla" : "Hear and speak"}
          </p>
          <p className="mt-1 text-sm text-amber-50/65">
            {spanishUi ? "Escucha el modelo, luego di la misma frase." : "Hear the model, then say the same phrase."}
          </p>
        </div>
        {result?.configured && typeof result.pron === "number" ? (
          <span className={`text-3xl font-bold ${scoreTone(result.pron)}`}>{Math.round(result.pron)}</span>
        ) : null}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <button type="button" onClick={() => void hear(1)} className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3 text-sm text-emerald-100">
          🔊 {spanishUi ? "Normal" : "Normal"}
        </button>
        <button type="button" onClick={() => void hear(0.72)} className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3 text-sm text-emerald-100">
          🐢 {spanishUi ? "Despacio" : "Slow"}
        </button>
      </div>

      <button
        type="button"
        disabled={scoring}
        onClick={recording ? stopRecording : () => void startRecording()}
        className={`mt-3 w-full rounded-2xl px-4 py-4 text-base font-semibold transition active:scale-[0.99] disabled:opacity-60 ${
          recording ? "bg-rose-400 text-stone-950" : "bg-emerald-300 text-stone-950"
        }`}
      >
        {recording
          ? spanishUi
            ? "Detener y evaluar"
            : "Stop and score"
          : scoring
            ? spanishUi
              ? "Evaluando…"
              : "Scoring…"
            : spanishUi
              ? "🎙️ Hablar"
              : "🎙️ Speak"}
      </button>

      {error ? <p className="mt-3 text-sm text-rose-200">{error}</p> : null}
      {result?.configured === false ? (
        <p className="mt-3 rounded-2xl border border-amber-300/20 bg-amber-300/5 p-3 text-sm text-amber-100/70">{result.message}</p>
      ) : null}
      {result?.configured ? (
        <div className="mt-4 space-y-3">
          {result.transcript ? (
            <p className="text-sm text-amber-50/60"><span className="text-amber-100/40">{spanishUi ? "Escuché: " : "I heard: "}</span>{result.transcript}</p>
          ) : null}
          {result.words?.length ? (
            <div className="flex flex-wrap gap-1.5">
              {result.words.map((word, index) => (
                <span key={`${word.word}-${index}`} className={`rounded-md bg-black/20 px-2 py-1 text-sm ${scoreTone(word.accuracy)}`}>{word.word}</span>
              ))}
            </div>
          ) : null}
          {result.coaching ? (
            <p className="rounded-2xl border border-white/10 bg-black/15 p-3 text-sm leading-relaxed text-amber-50/75">{result.coaching}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
