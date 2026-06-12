"use client";

import { useEffect, useRef, useState } from "react";

type LangCode = "en" | "es";
type Tone = "casual" | "detailed";
type Engine = "elevenlabs" | "openai";
type Status = "idle" | "recording" | "processing" | "done" | "error";

interface Speaker {
  code: LangCode;
  who: string;
  label: string; // language name in its own language
}

const SPEAKERS: Record<LangCode, Speaker> = {
  es: { code: "es", who: "Liz", label: "Español" },
  en: { code: "en", who: "Tom", label: "English" }
};

function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac"];
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return "";
}

function fileNameFor(mime: string): string {
  if (mime.includes("webm")) return "audio.webm";
  if (mime.includes("mp4") || mime.includes("aac")) return "audio.mp4";
  return "audio.webm";
}

export function TranslatorShell(): JSX.Element {
  const [source, setSource] = useState<LangCode>("es"); // who is speaking right now
  const [tone, setTone] = useState<Tone>("casual");
  const [engine, setEngine] = useState<Engine>("elevenlabs");
  const [autoPlay, setAutoPlay] = useState(true);

  const [status, setStatus] = useState<Status>("idle");
  const [original, setOriginal] = useState("");
  const [translation, setTranslation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef<string>("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  const target: LangCode = source === "es" ? "en" : "es";
  const speaker = SPEAKERS[source];
  const listener = SPEAKERS[target];

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  function ensureAudioEl(): HTMLAudioElement | null {
    if (!audioRef.current) {
      audioRef.current = typeof Audio !== "undefined" ? new Audio() : null;
    }
    return audioRef.current;
  }

  // Calling play() inside the user gesture "blesses" the element so later
  // programmatic play() (after async fetch) is allowed on iOS Safari.
  function blessAudio() {
    const a = ensureAudioEl();
    if (!a) return;
    a.play().catch(() => {});
    a.pause();
  }

  async function speak(text: string) {
    if (!text) return;
    const a = ensureAudioEl();
    if (!a) return;
    try {
      setIsSpeaking(true);
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, engine })
      });
      if (!res.ok) {
        const p = (await res.json().catch(() => ({}))) as { error?: string; details?: string };
        throw new Error(p.details || p.error || "Voice playback failed.");
      }
      const blob = await res.blob();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      a.src = url;
      a.onended = () => setIsSpeaking(false);
      await a.play();
    } catch (e) {
      setIsSpeaking(false);
      setError(e instanceof Error ? e.message : "Voice playback failed.");
    }
  }

  async function startRecording() {
    setError(null);
    blessAudio();

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setStatus("error");
      setError("Microphone not available. Open this page over HTTPS in Safari and allow mic access.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = pickMimeType();
      mimeRef.current = mime;
      const recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      recorder.onstop = () => void handleRecordingStopped();
      recorder.start();
      recorderRef.current = recorder;
      setStatus("recording");
    } catch {
      setStatus("error");
      setError("Microphone permission was denied. Enable it in Safari settings and retry.");
    }
  }

  function stopRecording() {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      setStatus("processing");
      recorder.stop();
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  async function handleRecordingStopped() {
    const mime = mimeRef.current || "audio/webm";
    const blob = new Blob(chunksRef.current, { type: mime });
    recorderRef.current = null;
    if (blob.size === 0) {
      setStatus("idle");
      return;
    }

    setOriginal("");
    setTranslation("");

    try {
      const form = new FormData();
      form.append("audio", blob, fileNameFor(mime));
      form.append("sourceLanguage", source);
      form.append("targetLanguage", target);
      form.append("tone", tone);

      const res = await fetch("/api/translate", { method: "POST", body: form });
      const payload = (await res.json().catch(() => ({}))) as {
        original?: string;
        translation?: string;
        error?: string;
        details?: string;
      };
      if (!res.ok) {
        throw new Error(payload.details || payload.error || "Translation failed.");
      }
      setOriginal(typeof payload.original === "string" ? payload.original : "");
      setTranslation(typeof payload.translation === "string" ? payload.translation : "");
      setStatus("done");
      if (autoPlay && payload.translation) {
        void speak(payload.translation);
      }
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Translation failed.");
    }
  }

  function toggleRecord() {
    if (status === "recording") {
      stopRecording();
    } else if (status !== "processing") {
      void startRecording();
    }
  }

  function swap() {
    blessAudio();
    setSource((s) => (s === "es" ? "en" : "es"));
    setOriginal("");
    setTranslation("");
    setError(null);
    if (status !== "recording") setStatus("idle");
  }

  const recording = status === "recording";
  const processing = status === "processing";

  return (
    <main className="min-h-screen px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-[calc(env(safe-area-inset-top)+1rem)]">
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-md flex-col gap-4">
        <header className="flex items-center justify-between">
          <h1 className="text-lg font-semibold tracking-tight text-amber-200">TAOS·LITE</h1>
          <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-amber-100/70">
            {speaker.label} → {listener.label}
          </span>
        </header>

        {/* Who is speaking */}
        <button
          onClick={swap}
          type="button"
          className="flex items-center justify-between rounded-3xl border border-white/10 bg-[rgba(36,30,24,0.8)] p-4 text-left transition active:scale-[0.99]"
        >
          <div>
            <div className="text-xs uppercase tracking-[0.2em] text-amber-100/50">Speaking now</div>
            <div className="text-2xl font-semibold text-white">
              {speaker.who} · {speaker.label}
            </div>
          </div>
          <div className="flex flex-col items-center gap-1 text-amber-300">
            <span className="text-2xl">⇄</span>
            <span className="text-[10px] uppercase tracking-wider text-amber-100/50">Swap</span>
          </div>
        </button>

        {/* Tone toggle */}
        <div className="grid grid-cols-2 gap-2 rounded-2xl border border-white/10 bg-white/5 p-1">
          {(["casual", "detailed"] as Tone[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTone(t)}
              className={`rounded-xl px-3 py-2 text-sm font-medium capitalize transition ${
                tone === t ? "bg-amber-400 text-stone-950" : "text-amber-100/70"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Result */}
        <section className="flex flex-1 flex-col gap-3">
          <div className="flex min-h-[34vh] flex-1 flex-col rounded-3xl border border-white/10 bg-[rgba(18,44,36,0.7)] p-5">
            <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-[0.18em] text-emerald-100/50">
              <span>
                For {listener.who} · {listener.label}
              </span>
              {translation ? (
                <button
                  type="button"
                  onClick={() => {
                    blessAudio();
                    void speak(translation);
                  }}
                  className={`flex items-center gap-1 rounded-full border border-white/10 px-3 py-1 text-emerald-100 transition ${
                    isSpeaking ? "bg-emerald-400/30" : "bg-white/5"
                  }`}
                  aria-label="Read translation aloud"
                >
                  <span className="text-base">{isSpeaking ? "🔊" : "🔈"}</span>
                  <span className="text-[11px]">Play</span>
                </button>
              ) : null}
            </div>
            <div className="flex flex-1 items-center">
              <p className="text-pretty text-[clamp(1.8rem,7vw,2.8rem)] font-semibold leading-tight tracking-tight text-white">
                {translation ||
                  (processing
                    ? "Translating…"
                    : recording
                      ? "Listening…"
                      : "Tap the mic, speak a full thought, tap again.")}
              </p>
            </div>
            {original ? (
              <p className="mt-4 border-t border-white/10 pt-3 text-sm text-emerald-50/55">
                <span className="uppercase tracking-wider text-emerald-100/40">Heard:</span> {original}
              </p>
            ) : null}
          </div>

          {error ? (
            <p className="rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
              {error}
            </p>
          ) : null}
        </section>

        {/* Controls */}
        <section className="flex flex-col gap-3 rounded-3xl border border-white/10 bg-[rgba(20,16,14,0.86)] p-4">
          <button
            type="button"
            onClick={toggleRecord}
            disabled={processing}
            className={`flex h-20 items-center justify-center gap-3 rounded-2xl text-xl font-semibold text-white transition active:scale-[0.99] disabled:opacity-60 ${
              recording
                ? "animate-pulse bg-red-400 shadow-[0_0_34px_rgba(248,113,113,0.65)]"
                : "bg-red-600 hover:bg-red-500"
            }`}
          >
            <span className="text-2xl">{recording ? "⏹" : "🎙"}</span>
            {recording ? "Stop & Translate" : processing ? "Working…" : `Speak ${speaker.label}`}
          </button>

          <div className="flex items-center justify-between gap-3 text-sm">
            <label className="flex items-center gap-2 text-amber-100/70">
              <input
                type="checkbox"
                checked={autoPlay}
                onChange={(e) => setAutoPlay(e.target.checked)}
                className="h-4 w-4 accent-amber-400"
              />
              Auto-play voice
            </label>
            <div className="flex items-center gap-1 rounded-full border border-white/10 bg-white/5 p-1">
              {(["elevenlabs", "openai"] as Engine[]).map((eng) => (
                <button
                  key={eng}
                  type="button"
                  onClick={() => setEngine(eng)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                    engine === eng ? "bg-amber-400 text-stone-950" : "text-amber-100/60"
                  }`}
                >
                  {eng === "elevenlabs" ? "ElevenLabs" : "OpenAI"}
                </button>
              ))}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
