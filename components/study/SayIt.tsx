"use client";

// ● Say it — record yourself saying a line, get it scored.
//
// A port of the viewer prototype's practice leg onto the app's own scoring
// route. The route is /api/tutor/assess: Azure Pronunciation Assessment,
// metered through tutor minutes, now gated by EITHER the tutor flag or the
// study flag (lib/release.ts). Study attempts spend the same minutes the tutor
// does, because it is the same Azure spend — one meter, one allowance rule.
//
// Three things learned the hard way are kept:
//   - a silent recording is caught HERE, by peak level, before Azure is paid
//     to score nothing (iOS can hand over a live graph that carries silence);
//   - an interrupted mic (track ended, recorder error) scores what it got
//     instead of hanging the button (TranslatorShell, 7/27);
//   - what pulled the score down is NAMED — flow, missed words, or the words
//     themselves — because a 61 under all-green words reads as a bug.

import { useCallback, useEffect, useRef, useState } from "react";
import { authHeaders } from "@/lib/authClient";
import { saveTutorAttempt } from "@/lib/supabase";
import { blobToWav16kWithLevel } from "@/lib/tutor/wav";
import { canAssessPronunciation } from "@/lib/tutor/pronunciation";
import {
  SILENCE_PEAK,
  band,
  costHint,
  isMissed,
  overallOf,
  visibleWords,
  type ScoredWord
} from "@/lib/study/practice";

/** What /api/tutor/assess answers with, in every shape it has. */
interface AssessResponse {
  configured?: boolean;
  supported?: boolean;
  message?: string;
  error?: string;
  details?: string;
  transcript?: string;
  accuracy?: number | null;
  fluency?: number | null;
  completeness?: number | null;
  prosody?: number | null;
  pron?: number | null;
  words?: ScoredWord[];
  coaching?: string;
}

const LABELS: Record<string, Record<string, string>> = {
  en: {
    say: "Say it",
    stop: "Stop",
    scoring: "Scoring…",
    best: "best",
    pron: "pronunciation",
    flow: "flow",
    comp: "completeness",
    silence: "The microphone recorded silence — check it's the right mic and not muted.",
    noMic: "Microphone not available. Use HTTPS and allow mic access.",
    denied: "Microphone permission denied.",
    unsupported: "Pronunciation scoring isn't available for this language yet.",
    failed: "Scoring failed."
  },
  es: {
    say: "Dilo",
    stop: "Parar",
    scoring: "Calificando…",
    best: "mejor",
    pron: "pronunciación",
    flow: "fluidez",
    comp: "completitud",
    silence: "El micrófono grabó silencio — revisa que sea el micrófono correcto y no esté silenciado.",
    noMic: "Micrófono no disponible. Usa HTTPS y permite el acceso al micrófono.",
    denied: "Permiso de micrófono denegado.",
    unsupported: "La calificación de pronunciación aún no está disponible para este idioma.",
    failed: "No se pudo calificar."
  }
};

const MAX_RECORD_MS = 20_000;

type Status = "idle" | "recording" | "scoring";

const bandClass = (n: number | null | undefined): string => {
  const b = band(n);
  return b === "good" ? "text-emerald-300" : b === "ok" ? "text-amber-300" : b === "poor" ? "text-rose-300" : "text-amber-100/60";
};
const bandBg = (n: number | null | undefined): string => {
  const b = band(n);
  return b === "good" ? "bg-emerald-400/15" : b === "ok" ? "bg-amber-400/20" : b === "poor" ? "bg-rose-400/15" : "bg-white/5";
};

export function SayIt({
  text,
  lang,
  explain,
  lessonKey,
  best,
  onScored
}: {
  /** The line to say, in the language being learned. */
  text: string;
  /** Catalog code of the language being learned — what Azure scores against. */
  lang: string;
  /** The lesson's own language — the words the feedback is written in. */
  explain: string;
  /** Saved under this in tutor_attempts, so "best" survives a reload. */
  lessonKey: string;
  /** The learner's best score on this line so far, if any. */
  best?: number | null;
  onScored?: (text: string, pron: number) => void;
}): JSX.Element {
  const L = LABELS[explain] ?? LABELS.en;
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<AssessResponse | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef<string>("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const supported = canAssessPronunciation(lang);

  const stop = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      setStatus("scoring");
      recorder.stop();
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // Leaving the card mid-recording must not leave a mic open.
  useEffect(() => () => stop(), [stop]);

  const score = useCallback(async () => {
    const blob = new Blob(chunksRef.current, { type: mimeRef.current || "audio/webm" });
    recorderRef.current = null;
    if (blob.size === 0) {
      setStatus("idle");
      return;
    }
    try {
      const converted = await blobToWav16kWithLevel(blob);
      if (converted.peak < SILENCE_PEAK) {
        setNote(L.silence);
        return;
      }
      const form = new FormData();
      form.append("audio", converted.wav, "attempt.wav");
      form.append("referenceText", text);
      form.append("language", lang);
      form.append("learner", explain);
      form.append("moduleId", `study:${lessonKey}`);
      const res = await fetch("/api/tutor/assess", {
        method: "POST",
        headers: await authHeaders(),
        body: form
      });
      const payload = (await res.json().catch(() => ({}))) as AssessResponse;
      if (!res.ok && !payload.configured) {
        throw new Error(payload.details || payload.error || L.failed);
      }
      if (!res.ok) {
        // 402 quota exhausted, or a 502 from Azure, both arrive configured:true.
        setNote(payload.details || payload.error || L.failed);
        return;
      }
      if (payload.configured === false || payload.supported === false) {
        setNote(payload.message || L.unsupported);
        return;
      }
      setResult(payload);
      if (typeof payload.pron === "number") {
        onScored?.(text, payload.pron);
        void saveTutorAttempt({
          course: "study",
          lesson_id: lessonKey,
          target_phrase: text,
          transcript: payload.transcript ?? null,
          target_lang: lang,
          accuracy_score: payload.accuracy ?? null,
          fluency_score: payload.fluency ?? null,
          completeness_score: payload.completeness ?? null,
          prosody_score: payload.prosody ?? null,
          pron_score: payload.pron ?? null,
          word_scores: payload.words ?? null
        }).catch(() => undefined);
      }
    } catch (e) {
      setNote(e instanceof Error ? e.message : L.failed);
    } finally {
      setStatus("idle");
    }
  }, [text, lang, explain, lessonKey, onScored, L]);

  const start = useCallback(async () => {
    setNote(null);
    setResult(null);
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setNote(L.noMic);
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
      recorder.onerror = () => stop();
      for (const track of stream.getAudioTracks()) track.onended = () => stop();
      recorder.start();
      recorderRef.current = recorder;
      setStatus("recording");
      timerRef.current = setTimeout(stop, MAX_RECORD_MS);
    } catch {
      setNote(L.denied);
    }
  }, [score, stop, L]);

  const base = "min-h-[36px] rounded-full border px-3 text-[13px] transition disabled:opacity-50";
  const recording = status === "recording";
  const scoring = status === "scoring";
  const overall = result ? overallOf(result) : null;

  return (
    <div className="mt-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          className={`${base} ${
            recording ? "border-rose-400 bg-rose-500 text-white" : "border-rose-400/50 bg-transparent text-rose-200 hover:bg-rose-500/10"
          }`}
          disabled={scoring || !supported}
          title={supported ? undefined : L.unsupported}
          onClick={() => (recording ? stop() : void start())}
          aria-label={`${recording ? L.stop : L.say}: ${text}`}
          aria-pressed={recording}
        >
          {scoring ? L.scoring : recording ? `■ ${L.stop}` : `● ${L.say}`}
        </button>
        {typeof best === "number" ? (
          <span className="text-[11px] text-amber-100/55">
            {L.best} {best}
          </span>
        ) : null}
      </div>

      {note ? <div className="mt-1.5 text-xs text-amber-100/70">{note}</div> : null}

      {result && overall !== null ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className={`min-w-[42px] text-lg font-bold ${bandClass(overall)}`}>{overall}</span>
          {visibleWords(result.words).map((w, i) => (
            <span
              key={`${w.word}-${i}`}
              className={`rounded-md px-1.5 py-0.5 text-[13px] ${isMissed(w) ? "text-rose-300 line-through" : bandClass(w.accuracy)} ${isMissed(w) ? "bg-rose-400/15" : bandBg(w.accuracy)}`}
              title={isMissed(w) ? "missed" : `${w.accuracy ?? "—"}${w.errorType && w.errorType !== "None" ? " · " + w.errorType : ""}`}
            >
              {w.word}
            </span>
          ))}
          <div className="basis-full text-xs text-amber-100/60">
            {L.pron} {Math.round(result.accuracy ?? 0)} · {L.flow} {Math.round(result.fluency ?? 0)} · {L.comp}{" "}
            {Math.round(result.completeness ?? 0)} — {costHint(result, explain)}
          </div>
          {result.coaching ? <div className="basis-full text-xs text-amber-50/80">{result.coaching}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
