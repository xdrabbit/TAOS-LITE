"use client";

import { useEffect, useRef, useState } from "react";
import { LANGUAGE_OPTIONS } from "@/lib/realtime/languages";

function labelFor(code: string): string {
  return LANGUAGE_OPTIONS.find((o) => o.code === code)?.label ?? code.toUpperCase();
}

// Free anonymous "hand it to a friend" translator. Text-only (no TTS), no
// account, no saved history. One 10-minute session, then a sign-up wall.
const SESSION_MS = 10 * 60 * 1000;
const MAX_TURN_MS = 5 * 60 * 1000; // matches /api/translate maxDuration (300s)
const STORAGE_KEY = "taos_atom_session_v1";

type Status = "idle" | "recording" | "processing" | "error";

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
  if (mime.includes("mp4") || mime.includes("aac")) return "audio.mp4";
  return "audio.webm";
}

function fmtClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function AtomShell(): JSX.Element {
  const [source, setSource] = useState("en");
  const [target, setTarget] = useState("es");

  const [status, setStatus] = useState<Status>("idle");
  const [original, setOriginal] = useState("");
  const [translation, setTranslation] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [walled, setWalled] = useState(false);
  const [remaining, setRemaining] = useState(SESSION_MS);

  const [isSpeaking, setIsSpeaking] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef("");
  const tickRef = useRef<number | null>(null);
  const turnTimerRef = useRef<number | null>(null);
  const lastBlobRef = useRef<Blob | null>(null);
  const lastMimeRef = useRef("");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const sourceLabel = labelFor(source);
  const targetLabel = labelFor(target);

  // On load, resume any session already in progress (or wall if it's spent).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const startedAt = Number(JSON.parse(raw).startedAt);
        if (Number.isFinite(startedAt)) {
          const left = SESSION_MS - (Date.now() - startedAt);
          if (left <= 0) {
            setWalled(true);
            setRemaining(0);
          } else {
            setRemaining(left);
            startTicking(startedAt);
          }
        }
      }
    } catch {
      /* ignore */
    }
    return () => {
      stopTicking();
      stopTurnTimer();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startTicking(startedAt: number) {
    stopTicking();
    tickRef.current = window.setInterval(() => {
      const left = SESSION_MS - (Date.now() - startedAt);
      setRemaining(Math.max(0, left));
      if (left <= 0) {
        endSession();
      }
    }, 1000);
  }

  function stopTicking() {
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }

  function stopTurnTimer() {
    if (turnTimerRef.current !== null) {
      window.clearTimeout(turnTimerRef.current);
      turnTimerRef.current = null;
    }
  }

  function ensureSessionStarted(): boolean {
    // Returns false if the session is already spent.
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const startedAt = Number(JSON.parse(raw).startedAt);
        if (Number.isFinite(startedAt) && SESSION_MS - (Date.now() - startedAt) <= 0) {
          setWalled(true);
          return false;
        }
        return true;
      }
      const startedAt = Date.now();
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ startedAt }));
      startTicking(startedAt);
      return true;
    } catch {
      return true; // if storage is blocked, don't hard-block the user
    }
  }

  function endSession() {
    stopTicking();
    stopTurnTimer();
    setRemaining(0);
    setWalled(true);
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStatus("idle");
  }

  function swap() {
    setSource(target);
    setTarget(source);
    setOriginal("");
    setTranslation("");
  }

  function onPickSource(next: string) {
    setSource(next);
    if (next === target) setTarget(source); // keep them different
  }
  function onPickTarget(next: string) {
    setTarget(next);
    if (next === source) setSource(target);
  }

  async function startRecording() {
    setError(null);
    if (!ensureSessionStarted()) return;

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setStatus("error");
      setError("Microphone not available. Open over HTTPS in Safari/Chrome and allow mic access.");
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
      recorder.onstop = () => void handleStopped();
      recorder.start(1000);
      recorderRef.current = recorder;
      setStatus("recording");
      stopTurnTimer();
      turnTimerRef.current = window.setTimeout(() => stopRecording(), MAX_TURN_MS);
    } catch {
      setStatus("error");
      setError("Microphone permission was denied. Enable it in your browser settings and retry.");
    }
  }

  function stopRecording() {
    stopTurnTimer();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      setStatus("processing");
      recorder.stop();
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  async function handleStopped() {
    const mime = mimeRef.current || "audio/webm";
    const blob = new Blob(chunksRef.current, { type: mime });
    recorderRef.current = null;
    if (blob.size === 0) {
      setStatus("idle");
      return;
    }
    lastBlobRef.current = blob;
    lastMimeRef.current = mime;
    await translateBlob(blob, mime, source, target);
  }

  async function translateBlob(blob: Blob, mime: string, src: string, tgt: string) {
    setOriginal("");
    setTranslation("");
    setStatus("processing");
    try {
      const form = new FormData();
      form.append("audio", blob, fileNameFor(mime));
      form.append("sourceLanguage", src);
      form.append("targetLanguage", tgt);
      form.append("tone", "casual");
      const res = await fetch("/api/translate", { method: "POST", body: form });
      const payload = (await res.json().catch(() => ({}))) as {
        original?: string;
        translation?: string;
        error?: string;
        details?: string;
      };
      if (!res.ok) throw new Error(payload.details || payload.error || "Translation failed.");
      setOriginal(typeof payload.original === "string" ? payload.original : "");
      setTranslation(typeof payload.translation === "string" ? payload.translation : "");
      setStatus("idle");
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Translation failed.");
    }
  }

  // Re-run the last recording the other way — no re-recording.
  function flipLast() {
    const blob = lastBlobRef.current;
    if (!blob || status === "recording" || status === "processing") return;
    const ns = target; // new source = old target
    const nt = source; // new target = old source
    setSource(ns);
    setTarget(nt);
    setError(null);
    void translateBlob(blob, lastMimeRef.current || "audio/webm", ns, nt);
  }

  // On-demand voice on the free tier: a plain OpenAI voice (the paid app uses
  // the cloned voices). Tap-to-hear keeps cost down vs auto-play.
  async function hear() {
    if (!translation) return;
    if (!audioRef.current && typeof Audio !== "undefined") audioRef.current = new Audio();
    const a = audioRef.current;
    if (!a) return;
    try {
      a.play().catch(() => {});
      a.pause();
      setIsSpeaking(true);
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: translation, engine: "openai" })
      });
      if (!res.ok) {
        setIsSpeaking(false);
        return;
      }
      a.src = URL.createObjectURL(await res.blob());
      a.onended = () => setIsSpeaking(false);
      await a.play();
    } catch {
      setIsSpeaking(false);
    }
  }

  function toggleRecord() {
    if (walled) return;
    if (status === "recording") stopRecording();
    else if (status !== "processing") void startRecording();
  }

  const recording = status === "recording";
  const processing = status === "processing";
  const low = remaining <= 60 * 1000;

  return (
    <main className="min-h-screen px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-[calc(env(safe-area-inset-top)+1rem)]">
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-md flex-col gap-4">
        <header className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold tracking-tight text-amber-200">TAOS·ATOM</h1>
            <span className="rounded-full border border-amber-300/30 bg-amber-400/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-amber-200/80">
              Free
            </span>
          </div>
          <span
            className={`rounded-full border px-3 py-1 text-xs tabular-nums ${
              low
                ? "border-rose-400/30 bg-rose-500/10 text-rose-200"
                : "border-white/10 bg-white/5 text-amber-100/70"
            }`}
          >
            {fmtClock(remaining)} left
          </span>
        </header>

        {/* Language pickers */}
        <div className="flex items-center gap-2">
          <Picker label="You speak" value={source} onChange={onPickSource} />
          <button
            type="button"
            onClick={swap}
            aria-label="Swap languages"
            className="mt-5 shrink-0 rounded-2xl border border-white/10 bg-white/5 px-3 py-3 text-amber-300"
          >
            ⇄
          </button>
          <Picker label="They speak" value={target} onChange={onPickTarget} />
        </div>

        {/* Result */}
        <section className="flex flex-1 flex-col">
          <div className="flex min-h-[34vh] flex-1 flex-col rounded-3xl border border-white/10 bg-[rgba(18,44,36,0.7)] p-5">
            <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-[0.18em] text-emerald-100/50">
              <span>In {targetLabel}</span>
              {translation ? (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={flipLast}
                    disabled={processing}
                    title="Wrong direction? Re-translate the same recording the other way"
                    className="flex items-center gap-1 rounded-full border border-amber-300/30 bg-amber-400/10 px-3 py-1 text-amber-200 disabled:opacity-50"
                  >
                    <span className="text-base">⇄</span>
                    <span className="text-[11px]">Flip</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void hear()}
                    className={`flex items-center gap-1 rounded-full border border-white/10 px-3 py-1 text-emerald-100 ${
                      isSpeaking ? "bg-emerald-400/30" : "bg-white/5"
                    }`}
                  >
                    <span className="text-base">{isSpeaking ? "🔊" : "🔈"}</span>
                    <span className="text-[11px]">Hear</span>
                  </button>
                </div>
              ) : null}
            </div>
            <div className="flex flex-1 items-center">
              <p className="text-pretty text-[clamp(1.8rem,7vw,2.8rem)] font-semibold leading-tight tracking-tight text-white">
                {translation ||
                  (processing
                    ? "Translating…"
                    : recording
                      ? "Listening…"
                      : "Pick languages, tap the mic, speak, tap again.")}
              </p>
            </div>
            {original ? (
              <p className="mt-4 border-t border-white/10 pt-3 text-sm text-emerald-50/55">
                <span className="uppercase tracking-wider text-emerald-100/40">Heard:</span> {original}
              </p>
            ) : null}
          </div>

          {error ? (
            <p className="mt-3 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
              {error}
            </p>
          ) : null}
        </section>

        {/* Control */}
        <section className="flex flex-col gap-2 rounded-3xl border border-white/10 bg-[rgba(20,16,14,0.86)] p-4">
          <button
            type="button"
            onClick={toggleRecord}
            disabled={processing || walled}
            className={`flex h-20 items-center justify-center gap-3 rounded-2xl text-xl font-semibold transition active:scale-[0.99] disabled:opacity-60 ${
              recording
                ? "animate-pulse bg-amber-400 text-stone-950 shadow-[0_0_34px_rgba(251,191,36,0.6)]"
                : "border border-amber-300/30 bg-stone-50 text-stone-900 hover:bg-white"
            }`}
          >
            <span
              className={`inline-block rounded-[6px] ${
                recording ? "h-5 w-5 bg-stone-900/85" : "h-6 w-6 bg-amber-500"
              }`}
            />
            {recording ? "Stop & Translate" : processing ? "Working…" : `Speak ${sourceLabel}`}
          </button>
          <p className="text-center text-[11px] text-amber-100/40">
            Free preview · tap 🔈 to hear · nothing saved
          </p>
        </section>
      </div>

      {walled ? (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-5 bg-[rgba(9,9,9,0.97)] px-6 backdrop-blur">
          <div className="w-full max-w-sm rounded-3xl border border-white/10 bg-[rgba(20,16,14,0.92)] p-6 text-center shadow-[0_24px_80px_rgba(0,0,0,0.4)]">
            <h2 className="text-2xl font-semibold tracking-tight text-amber-200">
              Your free 10 minutes are up
            </h2>
            <p className="mt-2 text-sm text-amber-100/70">
              Keep translating with the full TAOS-LITE — unlimited, with spoken voices and saved history.
            </p>
            <a
              href="/"
              className="mt-6 block rounded-2xl bg-amber-400 px-5 py-3 text-lg font-semibold text-stone-950 transition hover:bg-amber-300"
            >
              Start free trial →
            </a>
            <p className="mt-3 text-[11px] text-amber-100/40">
              7 days free, then $7.99/mo. Cancel anytime.
            </p>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function Picker({
  label,
  value,
  onChange
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
}): JSX.Element {
  return (
    <label className="flex flex-1 flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wider text-amber-100/50">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-2xl border border-white/10 bg-[rgba(36,30,24,0.8)] px-3 py-3 text-base text-white outline-none focus:border-amber-300/50"
      >
        {LANGUAGE_OPTIONS.map((opt) => (
          <option key={opt.code} value={opt.code} className="bg-stone-900">
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}
