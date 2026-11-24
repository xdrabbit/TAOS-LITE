"use client";

import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { authHeaders } from "@/lib/authClient";
import { useLanguagePair } from "@/lib/translate/useLanguagePair";
import { languageNative } from "@/lib/languages/catalog";
import { requestSpeech } from "@/lib/tts/speech";
import { AUDIO_BITS_PER_SECOND, MIN_TURN_DURATION_MS, fileNameFor, pickMimeType } from "@/lib/translate/recorder";
import {
  DEFAULT_SCENARIO_ID,
  MAX_HISTORY_TURNS,
  PRACTICE_SCENARIOS,
  scenarioById,
  type PracticeTurn
} from "@/lib/practice/practice";
import type { TutorLevel } from "@/lib/tutor/types";
import { LanguagePillRow, LanguageSheet } from "./LanguagePicker";
import { ExitHome } from "./ExitHome";
import { SignIn } from "./SignIn";

// /practice — Practice with Claude (lib/practice/practice.ts).
//
// For someone with nobody to practise on. Pick the language you are learning
// and a scene; Claude opens it, in character, in that language. Tap to talk
// (or type), and each reply comes back spoken, with its meaning in your own
// language underneath and, when you slipped, one short tip.
//
// Deliberately small: no minutes meter, no realtime socket. One turn is one
// POST /api/practice (transcribe + one Claude reply) and one /api/tts line.

interface Line extends PracticeTurn {
  /** Partner lines: the meaning in the learner's language. */
  translation?: string;
  /** Learner lines: Claude's correction of this line, if any. */
  tip?: string;
}

type Phase = "idle" | "recording" | "thinking";

const LEVELS: ReadonlyArray<{ level: TutorLevel; label: string }> = [
  { level: "beginner", label: "Beginner · Principiante" },
  { level: "intermediate", label: "Intermediate · Intermedio" },
  { level: "advanced", label: "Advanced · Avanzado" }
];

const CAPTION = "I want to practice · Quiero practicar";

export function PracticeShell(): JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, next) => {
      setSession(next);
      setReady(true);
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
  if (!session) return <SignIn redirectPath="/practice" />;
  return <Practice key={session.user.id} />;
}

function Practice(): JSX.Element {
  const { mine, theirs, pills, sheetOpen, setSheetOpen, selectLanguage } = useLanguagePair();
  const [scenarioId, setScenarioId] = useState(DEFAULT_SCENARIO_ID);
  const [level, setLevel] = useState<TutorLevel>("beginner");
  const [lines, setLines] = useState<Line[]>([]);
  const [started, setStarted] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notSetUp, setNotSetUp] = useState(false);
  const [draft, setDraft] = useState("");
  const [voiceOn, setVoiceOn] = useState(true);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef("");
  const recordStartedRef = useRef(0);
  const linesRef = useRef<Line[]>([]);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    linesRef.current = lines;
    bottomRef.current?.scrollIntoView?.({ behavior: "smooth", block: "end" });
  }, [lines]);

  // Leaving the screen mid-recording must let go of the mic.
  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((tr) => tr.stop());
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    },
    []
  );

  const scenario = scenarioById(scenarioId);

  /** iOS only plays audio a user gesture unlocked — call this inside a tap. */
  function unlockAudio(): void {
    const a = audioRef.current;
    if (!a) return;
    a.play().catch(() => {});
    a.pause();
  }

  async function speak(text: string): Promise<void> {
    const a = audioRef.current;
    if (!a || !voiceOn) return;
    try {
      // Source = target picks nobody's clone (lib/tts/voice.ts speakerClone):
      // the practice partner is not Tom or Liz, so it speaks in the stock voice.
      const blob = await requestSpeech({ text, sourceLanguage: theirs, targetLanguage: theirs }, { surface: "tutor" });
      if (!blob) return;
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      const url = URL.createObjectURL(blob);
      audioUrlRef.current = url;
      a.src = url;
      await a.play();
    } catch {
      /* the text is on screen; a missed voice line is not an error */
    }
  }

  /** One round trip. `text`/`audio` empty with no history is the opening. */
  async function turn(input: { text?: string; audio?: Blob }): Promise<void> {
    setError(null);
    setPhase("thinking");
    const history: PracticeTurn[] = linesRef.current
      .slice(-MAX_HISTORY_TURNS)
      .map(({ role, text }) => ({ role, text }));
    const form = new FormData();
    form.append(
      "payload",
      JSON.stringify({ target: theirs, learner: mine, scenario: scenario.id, level, history, text: input.text ?? "" })
    );
    if (input.audio) form.append("audio", input.audio, fileNameFor(mimeRef.current));
    try {
      const res = await fetch("/api/practice", { method: "POST", headers: await authHeaders(), body: form });
      const p = (await res.json().catch(() => ({}))) as {
        heard?: string;
        reply?: string;
        translation?: string;
        tip?: string;
        error?: string;
        configured?: boolean;
      };
      if (res.status === 503 && p.configured === false) {
        setNotSetUp(true);
        return;
      }
      const heard = p.heard?.trim();
      if (!res.ok || !p.reply) {
        // Keep what they said on screen even when the reply failed, so a
        // retry by typing doesn't mean remembering it.
        if (heard) setLines((prev) => [...prev, { role: "learner", text: heard }]);
        setError(p.error || "Something went wrong — please try that again. · Algo falló; inténtalo de nuevo.");
        return;
      }
      const reply = p.reply;
      setLines((prev) => [
        ...prev,
        ...(heard ? [{ role: "learner" as const, text: heard, tip: p.tip || undefined }] : []),
        { role: "partner" as const, text: reply, translation: p.translation }
      ]);
      void speak(reply);
    } catch {
      setError("No connection — please try again. · Sin conexión; inténtalo de nuevo.");
    } finally {
      setPhase("idle");
    }
  }

  function start(): void {
    unlockAudio();
    setLines([]);
    setStarted(true);
    void turn({});
  }

  function restart(): void {
    setLines([]);
    setStarted(false);
    setError(null);
  }

  async function startRecording(): Promise<void> {
    unlockAudio();
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Microphone not available — you can type instead. · Micrófono no disponible; puedes escribir.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = pickMimeType();
      mimeRef.current = mime;
      const recorder = new MediaRecorder(
        stream,
        mime ? { mimeType: mime, audioBitsPerSecond: AUDIO_BITS_PER_SECOND } : { audioBitsPerSecond: AUDIO_BITS_PER_SECOND }
      );
      chunksRef.current = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      recorder.onstop = () => {
        streamRef.current?.getTracks().forEach((tr) => tr.stop());
        streamRef.current = null;
        const tooShort = Date.now() - recordStartedRef.current < MIN_TURN_DURATION_MS;
        const blob = new Blob(chunksRef.current, { type: mime || "audio/webm" });
        if (tooShort || blob.size === 0) {
          setPhase("idle");
          return;
        }
        void turn({ audio: blob });
      };
      // An interrupted mic sends what it caught rather than hanging the turn.
      recorder.onerror = () => stopRecording();
      for (const track of stream.getAudioTracks()) track.onended = () => stopRecording();
      recordStartedRef.current = Date.now();
      recorder.start(1000);
      recorderRef.current = recorder;
      setPhase("recording");
    } catch {
      setError("Microphone permission denied — you can type instead. · Permiso de micrófono denegado; puedes escribir.");
    }
  }

  function stopRecording(): void {
    const r = recorderRef.current;
    recorderRef.current = null;
    if (r && r.state !== "inactive") r.stop();
  }

  function send(): void {
    const text = draft.trim();
    if (!text || phase !== "idle") return;
    unlockAudio();
    setDraft("");
    void turn({ text });
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col px-4 pb-6 pt-4">
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ExitHome lang={mine} />
          <h1 className="text-lg font-semibold tracking-tight text-amber-200">Practice · Práctica</h1>
        </div>
        <button
          type="button"
          onClick={() => setVoiceOn((v) => !v)}
          aria-pressed={voiceOn}
          className="min-h-[44px] rounded-full border border-white/10 px-3 text-xs text-amber-100/80"
        >
          {voiceOn ? "Voice on · Voz" : "Voice off · Sin voz"}
        </button>
      </header>
      {/* One element for every line: iOS lets an element play once a tap
          has unlocked it, so reuse beats a new Audio() per reply. */}
      <audio ref={audioRef} className="hidden" />

      {notSetUp ? (
        <p className="mt-6 rounded-2xl border border-amber-300/30 bg-amber-400/10 p-4 text-sm text-amber-100">
          Practice isn&apos;t set up yet. · La práctica aún no está lista.
        </p>
      ) : !started ? (
        <section className="mt-5 flex flex-col gap-5">
          <p className="text-sm text-amber-100/80">
            No one to practice with? Talk with Claude. · ¿No tienes con quién practicar? Habla con Claude.
          </p>
          <LanguagePillRow
            pills={pills}
            selected={theirs}
            paired={mine}
            caption={CAPTION}
            sheetOpen={sheetOpen}
            onSelect={selectLanguage}
            onOpenSheet={() => setSheetOpen(true)}
          />
          <div>
            <p className="mb-2 text-xs uppercase tracking-wide text-amber-100/60">Scene · Escena</p>
            <div className="flex flex-wrap gap-2">
              {PRACTICE_SCENARIOS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setScenarioId(s.id)}
                  aria-pressed={s.id === scenarioId}
                  className={`min-h-[44px] rounded-full border px-3 text-sm transition ${
                    s.id === scenarioId
                      ? "border-amber-300/60 bg-amber-400 text-stone-950"
                      : "border-white/10 bg-white/[0.03] text-amber-100/85"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-2 text-xs uppercase tracking-wide text-amber-100/60">Level · Nivel</p>
            <div className="flex flex-wrap gap-2">
              {LEVELS.map((l) => (
                <button
                  key={l.level}
                  type="button"
                  onClick={() => setLevel(l.level)}
                  aria-pressed={l.level === level}
                  className={`min-h-[44px] rounded-full border px-3 text-sm transition ${
                    l.level === level
                      ? "border-amber-300/60 bg-amber-400 text-stone-950"
                      : "border-white/10 bg-white/[0.03] text-amber-100/85"
                  }`}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            onClick={start}
            className="min-h-[52px] rounded-full bg-emerald-400 px-6 text-base font-semibold text-stone-950 transition active:scale-[0.98]"
          >
            Start · Empezar ({languageNative(theirs)})
          </button>
        </section>
      ) : (
        <>
          <div className="mt-3 flex items-center justify-between gap-2 text-xs text-amber-100/70">
            <span>
              {scenario.label} · {languageNative(theirs)}
            </span>
            <button type="button" onClick={restart} className="min-h-[44px] rounded-full px-3 underline">
              New scene · Nueva escena
            </button>
          </div>
          <ol className="mt-2 flex flex-1 flex-col gap-3" aria-live="polite">
            {lines.map((line, i) =>
              line.role === "partner" ? (
                <li key={i} className="max-w-[90%] self-start rounded-2xl bg-white/[0.06] p-3">
                  <p className="text-base text-amber-50">{line.text}</p>
                  {line.translation ? <p className="mt-1 text-sm text-amber-100/60">{line.translation}</p> : null}
                  <button
                    type="button"
                    onClick={() => {
                      unlockAudio();
                      void speak(line.text);
                    }}
                    className="mt-1 min-h-[44px] text-xs text-amber-300"
                  >
                    ▶ Play · Escuchar
                  </button>
                </li>
              ) : (
                <li key={i} className="max-w-[90%] self-end rounded-2xl bg-amber-400/15 p-3 text-right">
                  <p className="text-base text-amber-50">{line.text}</p>
                  {line.tip ? <p className="mt-1 text-sm text-emerald-300">💡 {line.tip}</p> : null}
                </li>
              )
            )}
            {phase === "thinking" ? (
              <li className="self-start animate-pulse text-sm text-amber-100/60">…</li>
            ) : null}
          </ol>
          <div ref={bottomRef} />
          {error ? <p className="mt-3 text-sm text-rose-300">{error}</p> : null}
          <div className="sticky bottom-0 mt-4 flex flex-col gap-2 bg-stone-950/90 pb-2 pt-2">
            <button
              type="button"
              disabled={phase === "thinking"}
              onClick={() => (phase === "recording" ? stopRecording() : void startRecording())}
              className={`min-h-[56px] rounded-full px-6 text-base font-semibold transition active:scale-[0.98] disabled:opacity-50 ${
                phase === "recording" ? "animate-pulse bg-rose-400 text-stone-950" : "bg-emerald-400 text-stone-950"
              }`}
            >
              {phase === "recording" ? "Tap to send · Toca para enviar" : "Tap to talk · Toca para hablar"}
            </button>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
            >
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={600}
                placeholder="…or type · …o escribe"
                className="min-h-[44px] flex-1 rounded-full border border-white/10 bg-white/5 px-4 text-sm text-amber-50 placeholder:text-amber-100/40"
              />
              <button
                type="submit"
                disabled={!draft.trim() || phase !== "idle"}
                className="min-h-[44px] rounded-full border border-white/10 px-4 text-sm text-amber-100 disabled:opacity-40"
              >
                Send · Enviar
              </button>
            </form>
          </div>
        </>
      )}

      <LanguageSheet
        open={sheetOpen}
        selected={theirs}
        paired={mine}
        caption={CAPTION}
        onSelect={selectLanguage}
        onClose={() => setSheetOpen(false)}
      />
    </main>
  );
}
