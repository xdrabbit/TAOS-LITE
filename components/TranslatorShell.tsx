"use client";

import { useEffect, useRef, useState } from "react";
import {
  getMonthlyUsage,
  getTier,
  isSubscriber,
  saveTranslation,
  translationsLeft,
  type MonthlyUsage,
  type Profile
} from "@/lib/supabase";
import { HistoryDrawer } from "./HistoryDrawer";
import { Paywall } from "./Paywall";

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

// Unobtrusive build marker so we can tell which deploy is live. Vercel injects
// the commit SHA at build time; falls back to "local" during dev.
const APP_VERSION = "0.4";
const BUILD_SHA = (process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7);
const BUILD_LABEL = `v${APP_VERSION}${BUILD_SHA ? ` · ${BUILD_SHA}` : " · local"}`;

// Speaker-facing copy flips to whoever is talking (Tom = en, Liz = es) so each
// person reads the controls they act on in their own language.
const STRINGS: Record<
  LangCode,
  {
    speak: string;
    stop: string;
    working: string;
    speakingNow: string;
    swap: string;
    listening: string;
    translating: string;
    idle: string;
    heard: string;
    forLabel: string;
    wrapUp: string;
    micUnavailable: string;
    micDenied: string;
    ttsFailed: string;
    translateFailed: string;
    noAudio: string;
  }
> = {
  en: {
    speak: "Speak",
    stop: "Stop & Translate",
    working: "Working…",
    speakingNow: "Speaking now",
    swap: "Swap",
    listening: "Listening…",
    translating: "Translating…",
    idle: "Tap the mic, speak a full thought, tap again.",
    heard: "Heard",
    forLabel: "For",
    wrapUp: "Wrapping up — auto stop & translate in a few seconds…",
    micUnavailable: "Microphone not available. Open this page over HTTPS in Safari and allow mic access.",
    micDenied: "Microphone permission was denied. Enable it in Safari settings and retry.",
    ttsFailed: "Voice playback failed.",
    translateFailed: "Translation failed.",
    noAudio: "No audio was captured. Check the mic and try again."
  },
  es: {
    speak: "Hablar",
    stop: "Detener y traducir",
    working: "Procesando…",
    speakingNow: "Hablando ahora",
    swap: "Cambiar",
    listening: "Escuchando…",
    translating: "Traduciendo…",
    idle: "Toca el micrófono, di una idea completa y toca otra vez.",
    heard: "Se escuchó",
    forLabel: "Para",
    wrapUp: "Terminando — se detiene y traduce en unos segundos…",
    micUnavailable: "Micrófono no disponible. Abre esta página con HTTPS en Safari y permite el micrófono.",
    micDenied: "Se denegó el permiso del micrófono. Actívalo en los ajustes de Safari e inténtalo de nuevo.",
    ttsFailed: "No se pudo reproducir la voz.",
    translateFailed: "No se pudo traducir.",
    noAudio: "No se captó audio. Revisa el micrófono e inténtalo de nuevo."
  }
};

// Bilingual labels for shared controls used by both people.
const TONE_LABEL: Record<Tone, string> = {
  casual: "Casual",
  detailed: "Detailed · Detallado"
};

// ── Per-turn safety cap ──────────────────────────────────────────────────
// Hard limit on a single recording. On reaching it we auto-stop and run the
// normal transcribe → translate → speak flow on whatever audio was captured
// (the audio is NEVER discarded). Keep this <= the /api/translate route's
// `maxDuration` (300s) — a longer turn can't be transcribed + paraphrased in
// time and the turn fails silently. Change to 150000 for a 2.5-minute cap.
const MAX_TURN_DURATION_MS = 300000; // 5 minutes

// Visual "wrap up" ramp on the record button. NO audio cues — the mic and
// speaker are both live during a turn, so the only safe signal is visual.
const RAMP_EARLY_MS = 30000; // T-30s remaining: gentle "breathing" glow begins
const RAMP_FAST_MS = 10000; // T-10s remaining: pulse starts accelerating
const PULSE_SLOW_MS = 600; // pulse period at the start of the fast ramp (T-10s)
const PULSE_FAST_MS = 150; // pulse period as it reaches T-0 (fastest)

// Keep the upload well under Vercel's ~4.5 MB request-body limit even on a
// full-length turn: cap MediaRecorder at a voice-friendly bitrate
// (32 kbps ≈ 1.2 MB for 5 min) so the audio buffer can't grow unbounded.
const AUDIO_BITS_PER_SECOND = 32000;

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

export function TranslatorShell({
  email,
  profile,
  onSignOut
}: {
  email: string;
  profile: Profile | null;
  onSignOut: () => void;
}): JSX.Element {
  const subscriber = isSubscriber(profile);
  const [usage, setUsage] = useState<MonthlyUsage | null>(null);
  const [showPaywall, setShowPaywall] = useState(false);
  const transLeft = translationsLeft(profile, usage);
  const trialBlocked = !subscriber && transLeft <= 0;

  const [source, setSource] = useState<LangCode>("es"); // who is speaking right now
  const [tone, setTone] = useState<Tone>("casual");
  const [engine, setEngine] = useState<Engine>("elevenlabs");
  const [autoPlay, setAutoPlay] = useState(true);
  const [autoDetect, setAutoDetect] = useState(true);

  const [status, setStatus] = useState<Status>("idle");
  const [original, setOriginal] = useState("");
  const [translation, setTranslation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [wrappingUp, setWrappingUp] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);

  // Avatar initial derived from the signed-in email (the only identity the
  // component receives — Profile has no name field). Falls back to a generic
  // user icon when the email yields no alphanumeric character.
  const avatarInitial = (email.match(/[a-z0-9]/i)?.[0] ?? "").toUpperCase();
  const accountMenuRef = useRef<HTMLDivElement | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef<string>("");
  const lastBlobRef = useRef<Blob | null>(null);
  const lastMimeRef = useRef<string>("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const maxStopTimerRef = useRef<number | null>(null);
  // Visual ramp state (drives the record button directly, no re-render per frame).
  const recordBtnRef = useRef<HTMLButtonElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const recordStartRef = useRef<number>(0);
  const pulsePhaseRef = useRef<number>(0);
  const lastTickRef = useRef<number>(0);

  const target: LangCode = source === "es" ? "en" : "es";
  const speaker = SPEAKERS[source];
  const listener = SPEAKERS[target];
  const s = STRINGS[source]; // speaker-facing copy (active speaker's language)

  useEffect(() => {
    return () => {
      clearRecordingTimers();
      releaseWakeLock();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load this month's usage (skip for subscribers — they're unlimited).
  useEffect(() => {
    if (subscriber) return;
    let active = true;
    getMonthlyUsage()
      .then((u) => active && setUsage(u))
      .catch(() => active && setUsage({ translations: 0, tutorSeconds: 0 }));
    return () => {
      active = false;
    };
  }, [subscriber]);

  // Close the account menu on outside pointer press or Escape. Only wired while
  // the menu is open so there's no idle global listener.
  useEffect(() => {
    if (!accountMenuOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (accountMenuRef.current && !accountMenuRef.current.contains(e.target as Node)) {
        setAccountMenuOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setAccountMenuOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [accountMenuOpen]);

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

  // Reset any inline ramp styling so the button returns to its normal look.
  function resetRecordButtonStyle() {
    const btn = recordBtnRef.current;
    if (btn) {
      btn.style.transform = "";
      btn.style.boxShadow = "";
    }
  }

  // Drives the purely-visual "wrap up" ramp on the record button each frame.
  // T-30s → T-10s: a gentle slow breathing glow (early heads-up).
  // T-10s → T-0:  a pulse that accelerates as the period shrinks 600ms → 150ms.
  // We mutate the button's style directly (via ref) to avoid a re-render per
  // frame, and respect prefers-reduced-motion by using a steady glow instead.
  function tickRamp() {
    const now = performance.now();
    const elapsed = now - recordStartRef.current;
    const remaining = MAX_TURN_DURATION_MS - elapsed;
    const btn = recordBtnRef.current;

    // Surface the textual heads-up once we enter the ramp window.
    setWrappingUp(remaining <= RAMP_EARLY_MS);

    if (btn) {
      const reduceMotion =
        typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

      if (remaining > RAMP_EARLY_MS) {
        resetRecordButtonStyle();
      } else {
        const urgent = remaining <= RAMP_FAST_MS;
        // Pulse period: constant & gentle in the early window, then shrinking
        // (faster and faster) through the final window.
        const period = urgent
          ? PULSE_FAST_MS +
            (PULSE_SLOW_MS - PULSE_FAST_MS) * (Math.max(0, remaining) / RAMP_FAST_MS)
          : 2400;

        let wave: number;
        if (reduceMotion) {
          // No oscillation; steady intensity that steps up when urgent.
          wave = urgent ? 1 : 0.5;
        } else {
          const dt = now - (lastTickRef.current || now);
          pulsePhaseRef.current += (dt / period) * Math.PI * 2;
          wave = (Math.sin(pulsePhaseRef.current) + 1) / 2; // 0..1
        }

        const scaleAmt = urgent ? 0.08 : 0.03;
        const glow = (urgent ? 80 : 36) * wave + 18;
        btn.style.transform = reduceMotion ? "" : `scale(${1 + wave * scaleAmt})`;
        btn.style.boxShadow = `0 0 ${glow}px rgba(251,191,36,${0.4 + wave * 0.5})`;
      }
    }

    lastTickRef.current = now;
    if (remaining <= 0) {
      // Hard cap reached — the maxStopTimer backstop also fires stopRecording().
      stopRecording();
      return;
    }
    rafRef.current = requestAnimationFrame(tickRamp);
  }

  function stopRamp() {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    resetRecordButtonStyle();
  }

  async function requestWakeLock() {
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinel> };
      };
      if (nav.wakeLock?.request) {
        wakeLockRef.current = await nav.wakeLock.request("screen");
      }
    } catch {
      /* ignore — wake lock is best-effort */
    }
  }

  function releaseWakeLock() {
    try {
      void wakeLockRef.current?.release();
    } catch {
      /* ignore */
    }
    wakeLockRef.current = null;
  }

  function clearRecordingTimers() {
    if (maxStopTimerRef.current !== null) {
      window.clearTimeout(maxStopTimerRef.current);
      maxStopTimerRef.current = null;
    }
    stopRamp();
  }

  async function speak(text: string, src: LangCode = source, tgt: LangCode = target) {
    if (!text) return;
    const a = ensureAudioEl();
    if (!a) return;
    try {
      setIsSpeaking(true);
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, engine, sourceLanguage: src, targetLanguage: tgt })
      });
      if (!res.ok) {
        const p = (await res.json().catch(() => ({}))) as { error?: string; details?: string };
        throw new Error(p.details || p.error || s.ttsFailed);
      }
      const blob = await res.blob();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      a.src = url;
      a.onended = () => setIsSpeaking(false);
      await a.play();
    } catch (e) {
      console.error("[tts] playback failed", e);
      setIsSpeaking(false);
      setError(e instanceof Error ? e.message : s.ttsFailed);
    }
  }

  async function startRecording() {
    setError(null);
    if (trialBlocked) return; // free translations used up — show upgrade instead
    blessAudio();

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setStatus("error");
      setError(s.micUnavailable);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = pickMimeType();
      mimeRef.current = mime;
      // Constrain the bitrate so even a full-length turn stays a small upload
      // (see AUDIO_BITS_PER_SECOND) — guards against unbounded buffer growth
      // and Vercel's ~4.5 MB request-body limit.
      const opts: MediaRecorderOptions = { audioBitsPerSecond: AUDIO_BITS_PER_SECOND };
      if (mime) opts.mimeType = mime;
      const recorder = new MediaRecorder(stream, opts);
      chunksRef.current = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      recorder.onstop = () => void handleRecordingStopped();
      // Flush audio into chunks every second so a long turn is never held in one
      // fragile buffer that could be lost if the page is suspended.
      recorder.start(1000);
      recorderRef.current = recorder;
      setStatus("recording");
      setWrappingUp(false);
      void requestWakeLock();

      // Start the per-turn cap: a setTimeout is the authoritative hard stop
      // (fires even if the rAF ramp is throttled in a background tab); the
      // rAF loop drives the visual wrap-up ramp.
      clearRecordingTimers();
      recordStartRef.current = performance.now();
      pulsePhaseRef.current = 0;
      lastTickRef.current = 0;
      maxStopTimerRef.current = window.setTimeout(stopRecording, MAX_TURN_DURATION_MS);
      rafRef.current = requestAnimationFrame(tickRamp);
    } catch {
      setStatus("error");
      setError(s.micDenied);
    }
  }

  function stopRecording() {
    clearRecordingTimers();
    setWrappingUp(false);
    releaseWakeLock();
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
    chunksRef.current = [];
    if (blob.size === 0) {
      // Previously this returned to idle silently — a long turn that lost its
      // audio (e.g. the page was suspended) produced no translation and no
      // error. Surface it instead so the turn never fails invisibly.
      console.error("[translate] no audio captured (empty recording blob)");
      setStatus("error");
      setError(s.noAudio);
      return;
    }
    // Keep the clip so "Flip" can re-run it the other way without re-recording.
    lastBlobRef.current = blob;
    lastMimeRef.current = mime;
    await translateBlob(blob, mime, autoDetect ? "auto" : source, autoDetect ? "auto" : target);
  }

  // Shared translate routine — used by a normal turn and by Flip (same audio,
  // opposite direction).
  async function translateBlob(blob: Blob, mime: string, src: string, tgt: string) {
    setOriginal("");
    setTranslation("");
    setStatus("processing");
    try {
      const form = new FormData();
      form.append("audio", blob, fileNameFor(mime));
      form.append("sourceLanguage", src);
      form.append("targetLanguage", tgt);
      form.append("tone", tone);

      const res = await fetch("/api/translate", { method: "POST", body: form });
      const payload = (await res.json().catch(() => ({}))) as {
        original?: string;
        translation?: string;
        sourceLanguage?: string;
        targetLanguage?: string;
        error?: string;
        details?: string;
      };
      if (!res.ok) {
        throw new Error(payload.details || payload.error || s.translateFailed);
      }
      // In auto mode the server resolves the real direction; use it for voice,
      // the on-screen direction, and history.
      const resolvedSrc: LangCode =
        payload.sourceLanguage === "es" || payload.sourceLanguage === "en"
          ? payload.sourceLanguage
          : src === "en"
            ? "en"
            : "es";
      const resolvedTgt: LangCode = resolvedSrc === "es" ? "en" : "es";
      if (src === "auto") setSource(resolvedSrc);

      setOriginal(typeof payload.original === "string" ? payload.original : "");
      setTranslation(typeof payload.translation === "string" ? payload.translation : "");
      setStatus("done");
      if (payload.translation) {
        void saveTranslation({
          source_lang: resolvedSrc,
          target_lang: resolvedTgt,
          tone,
          original_text: payload.original ?? "",
          translation_text: payload.translation,
          engine
        }).catch(() => {});
        // Count this translation toward the free-trial allowance.
        if (!subscriber) {
          setUsage((u) => ({
            translations: (u?.translations ?? 0) + 1,
            tutorSeconds: u?.tutorSeconds ?? 0
          }));
        }
      }
      if (autoPlay && payload.translation) {
        void speak(payload.translation, resolvedSrc, resolvedTgt);
      }
    } catch (e) {
      console.error("[translate] pipeline failed", e);
      setStatus("error");
      setError(e instanceof Error ? e.message : s.translateFailed);
    }
  }

  // Re-translate the LAST recording in the opposite direction — fixes the
  // "wrong person's side was selected" mix-up with no re-recording.
  function flipLast() {
    const blob = lastBlobRef.current;
    if (!blob || status === "recording" || status === "processing") return;
    blessAudio();
    const newSource: LangCode = source === "es" ? "en" : "es";
    const newTarget: LangCode = newSource === "es" ? "en" : "es";
    setSource(newSource);
    setError(null);
    void translateBlob(blob, lastMimeRef.current || "audio/webm", newSource, newTarget);
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
    setSource((prev) => (prev === "es" ? "en" : "es"));
    setOriginal("");
    setTranslation("");
    setError(null);
    if (status !== "recording") setStatus("idle");
  }

  const recording = status === "recording";
  const processing = status === "processing";

  if (showPaywall) {
    return (
      <Paywall
        email={email}
        currentTier={getTier(profile)}
        onClose={() => setShowPaywall(false)}
        onSignOut={onSignOut}
      />
    );
  }

  return (
    <main className="min-h-screen px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-[calc(env(safe-area-inset-top)+1rem)]">
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-md flex-col gap-4">
        <header className="flex items-center justify-between gap-2">
          <h1 className="text-lg font-semibold tracking-tight text-amber-200">TAOS·LITE</h1>
          <div className="flex items-center gap-2">
            <a
              href="/live"
              className="rounded-full border border-amber-300/30 bg-amber-400/10 px-3 py-1.5 text-xs text-amber-200"
            >
              Live
            </a>
            <a
              href="/translate"
              className="rounded-full border border-amber-300/30 bg-amber-400/10 px-3 py-1.5 text-xs text-amber-200"
            >
              Translate
            </a>
            <a
              href="/tutor"
              className="rounded-full border border-amber-300/30 bg-amber-400/10 px-3 py-1.5 text-xs text-amber-200"
            >
              Tutor
            </a>
            <div ref={accountMenuRef} className="relative">
              <button
                type="button"
                onClick={() => setAccountMenuOpen((o) => !o)}
                aria-label="Account menu"
                aria-haspopup="menu"
                aria-expanded={accountMenuOpen}
                title={email}
                className="flex h-8 w-8 items-center justify-center rounded-full border border-amber-300/30 bg-amber-400/10 text-xs font-semibold text-amber-200 transition active:scale-95"
              >
                {avatarInitial || (
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="h-4 w-4"
                  >
                    <circle cx="12" cy="8" r="4" />
                    <path d="M4 21c0-4 3.5-6 8-6s8 2 8 6" strokeLinecap="round" />
                  </svg>
                )}
              </button>
              {accountMenuOpen ? (
                <div
                  role="menu"
                  aria-label="Account"
                  className="absolute right-0 top-full z-20 mt-2 w-48 overflow-hidden rounded-2xl border border-amber-300/20 bg-[rgba(20,16,14,0.97)] shadow-[0_10px_34px_rgba(0,0,0,0.55)] backdrop-blur"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setAccountMenuOpen(false);
                      setHistoryOpen(true);
                    }}
                    className="block w-full px-4 py-2.5 text-left text-sm text-amber-100 transition hover:bg-amber-400/10"
                  >
                    History · Historial
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setAccountMenuOpen(false);
                      onSignOut();
                    }}
                    className="block w-full border-t border-white/10 px-4 py-2.5 text-left text-sm text-amber-100/70 transition hover:bg-amber-400/10"
                  >
                    Sign out · Salir
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </header>

        {/* Free-trial allowance banner (hidden for subscribers) */}
        {!subscriber && Number.isFinite(transLeft) ? (
          <div
            className={`flex items-center justify-between rounded-2xl border px-4 py-2.5 text-sm ${
              trialBlocked
                ? "border-rose-400/30 bg-rose-500/10 text-rose-100"
                : "border-amber-300/20 bg-amber-400/5 text-amber-100/80"
            }`}
          >
            <span>
              {trialBlocked
                ? "Free translations used up this month"
                : `Free · ${transLeft} translation${transLeft === 1 ? "" : "s"} left this month`}
            </span>
            <button
              type="button"
              onClick={() => setShowPaywall(true)}
              className="rounded-full bg-amber-400 px-3 py-1 text-xs font-semibold text-stone-950"
            >
              Upgrade
            </button>
          </div>
        ) : null}

        {/* Who is speaking — manual swap card, or an Auto-detect indicator */}
        {autoDetect ? (
          <div className="flex items-center justify-between rounded-3xl border border-amber-300/20 bg-amber-400/5 p-4">
            <div>
              <div className="text-xs uppercase tracking-[0.2em] text-amber-100/50">
                Auto-detect · Detección automática
              </div>
              <div className="text-2xl font-semibold text-white">
                {status === "done" ? `${speaker.who} · ${speaker.label}` : "EN ⇄ ES"}
              </div>
            </div>
            <span className="text-2xl text-amber-300">✨</span>
          </div>
        ) : (
          <button
            onClick={swap}
            type="button"
            className="flex items-center justify-between rounded-3xl border border-white/10 bg-[rgba(36,30,24,0.8)] p-4 text-left transition active:scale-[0.99]"
          >
            <div>
              <div className="text-xs uppercase tracking-[0.2em] text-amber-100/50">
                {s.speakingNow}
              </div>
              <div className="text-2xl font-semibold text-white">
                {speaker.who} · {speaker.label}
              </div>
            </div>
            <div className="flex flex-col items-center gap-1 text-amber-300">
              <span className="text-2xl">⇄</span>
              <span className="text-[10px] uppercase tracking-wider text-amber-100/50">{s.swap}</span>
            </div>
          </button>
        )}

        {/* Tone toggle (shared, bilingual) */}
        <div className="grid grid-cols-2 gap-2 rounded-2xl border border-white/10 bg-white/5 p-1">
          {(["casual", "detailed"] as Tone[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTone(t)}
              className={`rounded-xl px-3 py-2 text-sm font-medium transition ${
                tone === t ? "bg-amber-400 text-stone-950" : "text-amber-100/70"
              }`}
            >
              {TONE_LABEL[t]}
            </button>
          ))}
        </div>

        {/* Result — header in the listener's language */}
        <section className="flex flex-1 flex-col gap-3">
          <div className="flex min-h-[34vh] flex-1 flex-col rounded-3xl border border-white/10 bg-[rgba(18,44,36,0.7)] p-5">
            <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-[0.18em] text-emerald-100/50">
              <span>
                {STRINGS[target].forLabel} {listener.who} · {listener.label}
              </span>
              {translation ? (
                <div className="flex items-center gap-2">
                  {!autoDetect ? (
                    <button
                      type="button"
                      onClick={flipLast}
                      disabled={processing}
                      title="Wrong direction? Re-translate the same recording the other way"
                      aria-label="Flip direction / Voltear"
                      className="flex items-center gap-1 rounded-full border border-amber-300/30 bg-amber-400/10 px-3 py-1 text-amber-200 transition disabled:opacity-50"
                    >
                      <span className="text-base">⇄</span>
                      <span className="text-[11px]">Flip · Voltear</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      blessAudio();
                      void speak(translation);
                    }}
                    className={`flex items-center gap-1 rounded-full border border-white/10 px-3 py-1 text-emerald-100 transition ${
                      isSpeaking ? "bg-emerald-400/30" : "bg-white/5"
                    }`}
                    aria-label="Play translation / Reproducir traducción"
                  >
                    <span className="text-base">{isSpeaking ? "🔊" : "🔈"}</span>
                    <span className="text-[11px]">Play · Oír</span>
                  </button>
                </div>
              ) : null}
            </div>
            <div className="flex flex-1 items-center">
              <p className="text-pretty text-[clamp(1.8rem,7vw,2.8rem)] font-semibold leading-tight tracking-tight text-white">
                {translation || (processing ? s.translating : recording ? s.listening : s.idle)}
              </p>
            </div>
            {original ? (
              <p className="mt-4 border-t border-white/10 pt-3 text-sm text-emerald-50/55">
                <span className="uppercase tracking-wider text-emerald-100/40">{s.heard}:</span>{" "}
                {original}
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
            ref={recordBtnRef}
            type="button"
            onClick={toggleRecord}
            disabled={processing || trialBlocked}
            className={`flex h-20 items-center justify-center gap-3 rounded-2xl text-xl font-semibold transition active:scale-[0.99] disabled:opacity-60 ${
              recording
                ? `bg-amber-400 text-stone-950 shadow-[0_0_34px_rgba(251,191,36,0.6)] ${
                    wrappingUp ? "" : "animate-pulse"
                  }`
                : "border border-amber-300/30 bg-stone-50 text-stone-900 hover:bg-white"
            }`}
          >
            <span
              className={`inline-block rounded-[6px] ${
                recording ? "h-5 w-5 bg-stone-900/85" : "h-6 w-6 bg-amber-500"
              }`}
            />
            {recording
              ? s.stop
              : processing
                ? s.working
                : autoDetect
                  ? "Speak · Hablar"
                  : `${s.speak} ${speaker.label}`}
          </button>

          {wrappingUp && recording ? (
            <p role="status" aria-live="polite" className="text-center text-sm text-amber-300">
              {s.wrapUp}
            </p>
          ) : null}

          <label className="flex items-center gap-2 text-sm text-amber-100/70">
            <input
              type="checkbox"
              checked={autoDetect}
              onChange={(e) => setAutoDetect(e.target.checked)}
              className="h-4 w-4 accent-amber-400"
            />
            Auto-detect language · Detectar idioma
          </label>

          <div className="flex items-center justify-between gap-3 text-sm">
            <label className="flex items-center gap-2 text-amber-100/70">
              <input
                type="checkbox"
                checked={autoPlay}
                onChange={(e) => setAutoPlay(e.target.checked)}
                className="h-4 w-4 accent-amber-400"
              />
              Auto-play voice · Reproducir voz
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

        <p className="pt-1 text-center text-[10px] tracking-wider text-amber-100/25">{BUILD_LABEL}</p>
      </div>

      <HistoryDrawer open={historyOpen} onClose={() => setHistoryOpen(false)} />
    </main>
  );
}
