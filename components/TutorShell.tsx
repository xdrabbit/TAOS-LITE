"use client";

import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  endTutorSession,
  getProfile,
  hasAccess,
  saveTutorAttempt,
  startTutorSession,
  supabase,
  type Profile
} from "@/lib/supabase";
import { blobToWav16k } from "@/lib/tutor/wav";
import {
  startConversation,
  type ActiveConversation,
  type ConvState,
  type LearnLang,
  type Level,
  type StopReason
} from "@/lib/tutor/conversation";
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
type Mode = "drills" | "conversation";

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
  return <TutorModes />;
}

function TutorModes(): JSX.Element {
  const [mode, setMode] = useState<Mode>("drills");
  return mode === "drills" ? (
    <Drills mode={mode} onMode={setMode} />
  ) : (
    <Conversation mode={mode} onMode={setMode} />
  );
}

function ModeToggle({ mode, onMode }: { mode: Mode; onMode: (m: Mode) => void }): JSX.Element {
  return (
    <div className="flex rounded-full border border-white/10 bg-white/5 p-0.5 text-xs">
      <button
        type="button"
        onClick={() => onMode("drills")}
        className={`rounded-full px-3 py-1.5 transition ${
          mode === "drills" ? "bg-amber-400 text-stone-950" : "text-amber-100/70"
        }`}
      >
        Drills
      </button>
      <button
        type="button"
        onClick={() => onMode("conversation")}
        className={`rounded-full px-3 py-1.5 transition ${
          mode === "conversation" ? "bg-amber-400 text-stone-950" : "text-amber-100/70"
        }`}
      >
        Conversation
      </button>
    </div>
  );
}

function TutorHeader({ mode, onMode }: { mode: Mode; onMode: (m: Mode) => void }): JSX.Element {
  return (
    <header className="flex items-center justify-between gap-2">
      <h1 className="text-lg font-semibold tracking-tight text-amber-200">TAOS·TUTOR</h1>
      <div className="flex items-center gap-2">
        <ModeToggle mode={mode} onMode={onMode} />
        <a
          href="/"
          className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-amber-100/70"
        >
          ← Translator
        </a>
      </div>
    </header>
  );
}

function Drills({ mode, onMode }: { mode: Mode; onMode: (m: Mode) => void }): JSX.Element {
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
        <TutorHeader mode={mode} onMode={onMode} />

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

// ── Conversation mode ───────────────────────────────────────────────────────

interface Line {
  role: "user" | "tutor";
  text: string;
}

const CONV_MAX_MS = 10 * 60 * 1000; // hard session cap
const CONV_IDLE_MS = 20 * 1000; // silence auto-off

const STEER_CHIPS: { label: string; directive: string }[] = [
  { label: "Slower", directive: "Please speak more slowly." },
  { label: "More English", directive: "Use a bit more English to help me when I'm stuck." },
  { label: "Kitchen words", directive: "Let's focus on kitchen and cooking vocabulary." },
  { label: "Baseball", directive: "Let's talk about baseball." },
  { label: "Travel", directive: "Let's focus on travel and getting around." },
  { label: "Correct me more", directive: "Be stricter — correct even my small mistakes." }
];

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function Conversation({ mode, onMode }: { mode: Mode; onMode: (m: Mode) => void }): JSX.Element {
  const [learn, setLearn] = useState<LearnLang>("es");
  const [level, setLevel] = useState<Level>("intermediate");
  const [focus, setFocus] = useState("");

  const [convState, setConvState] = useState<ConvState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [live, setLive] = useState(""); // streaming tutor text buffer
  const [elapsed, setElapsed] = useState(0);
  const [muted, setMuted] = useState(false);
  const [steerText, setSteerText] = useState("");

  const sessRef = useRef<ActiveConversation | null>(null);
  const meterRef = useRef<string | null>(null);
  const liveRef = useRef("");
  const feedRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return () => {
      void sessRef.current?.stop("user");
    };
  }, []);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [lines, live]);

  const active = convState === "connected";
  const connecting =
    convState === "requesting_mic" || convState === "minting" || convState === "connecting";

  async function start() {
    setError(null);
    setNotice(null);
    setLines([]);
    setLive("");
    liveRef.current = "";
    setElapsed(0);
    setMuted(false);

    meterRef.current = await startTutorSession({
      learn_lang: learn,
      level,
      focus: focus.trim() || null
    });

    try {
      const sess = await startConversation(
        { learn, level, focus: focus.trim(), maxDurationMs: CONV_MAX_MS, idleTimeoutMs: CONV_IDLE_MS },
        {
          onState: setConvState,
          onError: (m) => setError(m),
          onUserTranscript: (t) => setLines((prev) => [...prev, { role: "user", text: t }]),
          onAssistantDelta: (d) => {
            liveRef.current += d;
            setLive(liveRef.current);
          },
          onAssistantDone: () => {
            const text = liveRef.current.trim();
            liveRef.current = "";
            setLive("");
            if (text) setLines((prev) => [...prev, { role: "tutor", text }]);
          },
          onTick: (e) => setElapsed(e),
          onStopped: (reason: StopReason, secs: number) => {
            sessRef.current = null;
            if (meterRef.current) {
              void endTutorSession(meterRef.current, secs);
              meterRef.current = null;
            }
            if (reason === "cap") setNotice("Session ended at the 10-minute limit.");
            else if (reason === "idle") setNotice("Paused after a quiet stretch. Tap Start to keep going.");
          }
        }
      );
      sessRef.current = sess;
    } catch {
      // onError/onStopped already fired; nothing more to do.
    }
  }

  function end() {
    void sessRef.current?.stop("user");
  }

  function sendSteer(directive: string) {
    sessRef.current?.steer(directive);
  }

  function submitSteer() {
    const t = steerText.trim();
    if (!t) return;
    sendSteer(t);
    setSteerText("");
  }

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    sessRef.current?.setMicEnabled(!next);
  }

  const remaining = Math.max(0, Math.round(CONV_MAX_MS / 1000) - elapsed);
  const targetName = learn === "es" ? "Spanish" : "English";

  return (
    <main className="min-h-screen px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-[calc(env(safe-area-inset-top)+1rem)]">
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-md flex-col gap-4">
        <TutorHeader mode={mode} onMode={onMode} />

        {!active && !connecting ? (
          // ── Setup ──
          <section className="flex flex-1 flex-col gap-4">
            <div className="rounded-3xl border border-white/10 bg-[rgba(18,44,36,0.7)] p-5">
              <h2 className="text-xl font-semibold text-white">Talk with your tutor</h2>
              <p className="mt-1 text-sm text-amber-50/70">
                A hands-free voice conversation. The tutor listens, talks back, and corrects your
                pronunciation as you go. Just start talking.
              </p>

              <label className="mt-5 block text-xs uppercase tracking-[0.18em] text-emerald-100/50">
                I want to practice
              </label>
              <div className="mt-2 flex gap-2">
                {(["es", "en"] as LearnLang[]).map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => setLearn(l)}
                    className={`flex-1 rounded-2xl border px-3 py-3 text-sm font-medium transition ${
                      learn === l
                        ? "border-amber-300/50 bg-amber-400 text-stone-950"
                        : "border-white/10 bg-white/5 text-amber-100/80"
                    }`}
                  >
                    {l === "es" ? "Spanish · Español" : "English · Inglés"}
                  </button>
                ))}
              </div>

              <label className="mt-4 block text-xs uppercase tracking-[0.18em] text-emerald-100/50">
                Level
              </label>
              <div className="mt-2 flex gap-2">
                {(["beginner", "intermediate", "advanced"] as Level[]).map((lv) => (
                  <button
                    key={lv}
                    type="button"
                    onClick={() => setLevel(lv)}
                    className={`flex-1 rounded-2xl border px-2 py-2.5 text-xs font-medium capitalize transition ${
                      level === lv
                        ? "border-amber-300/50 bg-amber-400 text-stone-950"
                        : "border-white/10 bg-white/5 text-amber-100/80"
                    }`}
                  >
                    {lv}
                  </button>
                ))}
              </div>

              <label className="mt-4 block text-xs uppercase tracking-[0.18em] text-emerald-100/50">
                Topic (optional)
              </label>
              <input
                value={focus}
                onChange={(e) => setFocus(e.target.value)}
                placeholder="e.g. ordering at a restaurant, baseball"
                className="mt-2 w-full rounded-2xl border border-white/10 bg-[rgba(36,30,24,0.8)] px-3 py-3 text-base text-white outline-none placeholder:text-amber-100/30 focus:border-amber-300/50"
              />
            </div>

            {error ? (
              <p className="rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                {error}
              </p>
            ) : null}
            {notice ? (
              <p className="rounded-2xl border border-amber-400/20 bg-amber-400/5 px-4 py-3 text-sm text-amber-100/80">
                {notice}
              </p>
            ) : null}

            <button
              type="button"
              onClick={() => void start()}
              className="flex h-16 items-center justify-center gap-3 rounded-2xl border border-amber-300/30 bg-stone-50 text-lg font-semibold text-stone-900 transition active:scale-[0.99] hover:bg-white"
            >
              <span className="inline-block h-5 w-5 rounded-full bg-emerald-500" />
              Start talking · {targetName}
            </button>
            <p className="text-center text-xs text-amber-100/40">
              Hands-free · auto-pauses after 20s of silence · 10-min sessions
            </p>
          </section>
        ) : (
          // ── Live call ──
          <section className="flex flex-1 flex-col gap-3">
            <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-[rgba(20,16,14,0.86)] px-4 py-3">
              <span className="flex items-center gap-2 text-sm">
                <span
                  className={`inline-block h-2.5 w-2.5 rounded-full ${
                    active ? "animate-pulse bg-emerald-400" : "bg-amber-300"
                  }`}
                />
                <span className="text-amber-100/80">
                  {connecting ? "Connecting…" : `Live · ${targetName}`}
                </span>
              </span>
              <span className="font-mono text-sm text-amber-100/70">
                {fmt(elapsed)} <span className="text-amber-100/30">/ {fmt(remaining)} left</span>
              </span>
            </div>

            <div
              ref={feedRef}
              className="flex-1 space-y-2 overflow-y-auto rounded-3xl border border-white/10 bg-[rgba(18,44,36,0.5)] p-4"
              style={{ maxHeight: "46vh" }}
            >
              {lines.length === 0 && !live ? (
                <p className="py-8 text-center text-sm text-amber-100/40">
                  Say hello to get started…
                </p>
              ) : null}
              {lines.map((ln, i) => (
                <div
                  key={i}
                  className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm ${
                    ln.role === "tutor"
                      ? "bg-white/5 text-emerald-50"
                      : "ml-auto bg-amber-400/15 text-amber-50"
                  }`}
                >
                  {ln.text}
                </div>
              ))}
              {live ? (
                <div className="max-w-[85%] rounded-2xl bg-white/5 px-3.5 py-2 text-sm text-emerald-50/80">
                  {live}
                </div>
              ) : null}
            </div>

            {error ? (
              <p className="rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-2.5 text-sm text-rose-200">
                {error}
              </p>
            ) : null}

            {/* Steering */}
            <div className="flex flex-wrap gap-1.5">
              {STEER_CHIPS.map((c) => (
                <button
                  key={c.label}
                  type="button"
                  onClick={() => sendSteer(c.directive)}
                  disabled={!active}
                  className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-amber-100/80 transition active:scale-95 disabled:opacity-40"
                >
                  {c.label}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                value={steerText}
                onChange={(e) => setSteerText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitSteer()}
                placeholder="Tell the tutor what to do…"
                disabled={!active}
                className="flex-1 rounded-2xl border border-white/10 bg-[rgba(36,30,24,0.8)] px-3 py-2.5 text-sm text-white outline-none placeholder:text-amber-100/30 focus:border-amber-300/50 disabled:opacity-50"
              />
              <button
                type="button"
                onClick={submitSteer}
                disabled={!active || !steerText.trim()}
                className="rounded-2xl border border-amber-300/30 bg-amber-400/90 px-4 text-sm font-medium text-stone-950 disabled:opacity-40"
              >
                Send
              </button>
            </div>

            {/* Controls */}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={toggleMute}
                disabled={!active}
                className={`flex-1 rounded-2xl border px-3 py-3 text-sm font-medium transition disabled:opacity-40 ${
                  muted
                    ? "border-rose-400/40 bg-rose-500/15 text-rose-200"
                    : "border-white/10 bg-white/5 text-amber-100/80"
                }`}
              >
                {muted ? "🔇 Mic off" : "🎙️ Mic on"}
              </button>
              <button
                type="button"
                onClick={end}
                className="flex-1 rounded-2xl border border-rose-400/40 bg-rose-500/20 px-3 py-3 text-sm font-semibold text-rose-100 transition active:scale-[0.99]"
              >
                End conversation
              </button>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
