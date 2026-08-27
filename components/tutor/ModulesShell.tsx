"use client";

// The curriculum screen: fourteen modules, and the crawl / walk / run loop
// that teaches one.
//
// docs/tutor-curriculum-plan.md is the shape. The three phases are three
// different machines and they are wired to three different pieces of plumbing
// that already existed in this app:
//
//   Crawl — /api/tts to hear it, then MediaRecorder → 16k WAV → Azure via
//           /api/tutor/assess. No realtime session, so it is the cheap phase
//           and the one that works even when the minutes are gone.
//   Walk  — a realtime session (lib/tutor/conversation.ts) with the tutor
//           playing the counterpart from the lesson's roleplay. The learner's
//           lines are on screen; the tutor is told NOT to say them.
//   Run   — the same realtime machinery with the script taken away.
//
// The lesson itself comes from /api/tutor/lesson, which generates once per
// (module, target, learner) and caches — so this screen asks for it on every
// visit without thinking about the bill.
//
// Language pair: `mine` is the learner's own language and `theirs` is the one
// being learned, which is the same reading /translate gives the pair (the
// other side of the conversation). A phone left on [en, it] after dinner in
// Italy opens the tutor ready to teach Italian, which is the correct guess.

import { useCallback, useEffect, useRef, useState } from "react";
import { LanguagePillRow, LanguageSheet } from "@/components/LanguagePicker";
import { useLanguagePair } from "@/lib/translate/useLanguagePair";
import { languageNative, languageLabel } from "@/lib/languages/catalog";
import { requestSpeech, isTextOnlyLanguage, TEXT_ONLY_TITLE } from "@/lib/tts/speech";
import { authHeaders, jsonAuthHeaders } from "@/lib/authClient";
import { blobToWav16k } from "@/lib/tutor/wav";
import { supabase, isSubscriber, saveTutorAttempt, type Profile } from "@/lib/supabase";
import {
  TUTOR_MODULES,
  getTutorModule,
  tutorModuleNumber,
  type TutorModule
} from "@/lib/tutor/modules";
import type { Lesson, LessonPronunciationItem } from "@/lib/tutor/lesson";
import type { TutorLevel, TutorPhase } from "@/lib/tutor/types";
import {
  completedPhases,
  markPhaseDone,
  nextPhase,
  progressKey,
  readStoredProgress,
  recordScore,
  writeStoredProgress,
  type TutorProgress
} from "@/lib/tutor/progress";
import {
  startConversation,
  type ActiveConversation,
  type ConvState,
  type StopReason
} from "@/lib/tutor/conversation";

/** Walk is a scene, not a chat: shorter cap than free conversation. */
const WALK_MAX_MS = 6 * 60 * 1000;
const RUN_MAX_MS = 8 * 60 * 1000;
const IDLE_MS = 25 * 1000;

interface LessonResponse {
  lesson?: Lesson;
  cached?: boolean;
  source?: string;
  capabilities?: { speech: boolean; pronunciationScoring: boolean };
  error?: string;
  details?: string;
}

interface AssessResult {
  configured: boolean;
  supported?: boolean;
  message?: string;
  error?: string;
  transcript?: string;
  pron?: number | null;
  accuracy?: number | null;
  fluency?: number | null;
  words?: Array<{ word: string; accuracy: number | null }>;
  coaching?: string;
}

function scoreColor(n: number | null | undefined): string {
  if (typeof n !== "number") return "text-amber-100/60";
  if (n >= 80) return "text-emerald-300";
  if (n >= 60) return "text-amber-300";
  return "text-rose-300";
}

export function ModulesShell({
  header,
  profile
}: {
  header: JSX.Element;
  profile: Profile | null;
}): JSX.Element {
  const { mine, theirs, pills, sheetOpen, setSheetOpen, selectLanguage } = useLanguagePair();
  const [moduleId, setModuleId] = useState<string | null>(null);
  const [level, setLevel] = useState<TutorLevel>("beginner");
  const [progress, setProgress] = useState<TutorProgress>({});

  useEffect(() => {
    setProgress(readStoredProgress());
  }, []);

  const saveProgress = useCallback((next: TutorProgress) => {
    setProgress(next);
    writeStoredProgress(next);
  }, []);

  const mod = moduleId ? getTutorModule(moduleId) : undefined;

  if (mod) {
    return (
      <ModuleLoop
        header={header}
        module={mod}
        target={theirs}
        learner={mine}
        level={level}
        profile={profile}
        progress={progress}
        onProgress={saveProgress}
        onBack={() => setModuleId(null)}
      />
    );
  }

  return (
    <main className="min-h-screen px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-[calc(env(safe-area-inset-top)+1rem)]">
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-md flex-col gap-4">
        {header}

        <LanguagePillRow
          pills={pills}
          selected={theirs}
          paired={mine}
          caption="Learning · Aprendiendo"
          sheetOpen={sheetOpen}
          onSelect={selectLanguage}
          onOpenSheet={() => setSheetOpen(true)}
        />
        <p className="-mt-2 text-xs text-amber-100/50">
          {languageNative(theirs)} · explained in {languageNative(mine)}
          {isTextOnlyLanguage(theirs) ? ` · ${TEXT_ONLY_TITLE}` : ""}
        </p>

        <div className="flex gap-2">
          {(["beginner", "intermediate", "advanced"] as TutorLevel[]).map((lv) => (
            <button
              key={lv}
              type="button"
              onClick={() => setLevel(lv)}
              className={`flex-1 rounded-2xl border px-2 py-2 text-xs font-medium capitalize transition ${
                level === lv
                  ? "border-amber-300/50 bg-amber-400 text-stone-950"
                  : "border-white/10 bg-white/5 text-amber-100/80"
              }`}
            >
              {lv}
            </button>
          ))}
        </div>

        <ul className="flex flex-col gap-2 pb-4">
          {TUTOR_MODULES.map((m) => {
            const done = completedPhases(progress[progressKey(m.id, theirs, mine)]);
            return (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => setModuleId(m.id)}
                  className="flex w-full items-center gap-3 rounded-2xl border border-white/10 bg-[rgba(18,44,36,0.6)] px-4 py-3 text-left transition active:scale-[0.99]"
                >
                  <span className="w-6 shrink-0 text-sm font-mono text-amber-100/40">
                    {tutorModuleNumber(m.id)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-white">{m.title}</span>
                    <span className="block truncate text-xs text-amber-50/50">{m.titleEs}</span>
                  </span>
                  <span className="flex shrink-0 gap-1" aria-label={`${done} of 3 done`}>
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        className={`inline-block h-1.5 w-1.5 rounded-full ${
                          i < done ? "bg-emerald-400" : "bg-white/15"
                        }`}
                      />
                    ))}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <LanguageSheet
        open={sheetOpen}
        selected={theirs}
        paired={mine}
        caption="Learning · Aprendiendo"
        onSelect={selectLanguage}
        onClose={() => setSheetOpen(false)}
      />
    </main>
  );
}

// ── One module, three phases ───────────────────────────────────────────────

function ModuleLoop({
  header,
  module: mod,
  target,
  learner,
  level,
  profile,
  progress,
  onProgress,
  onBack
}: {
  header: JSX.Element;
  module: TutorModule;
  target: string;
  learner: string;
  level: TutorLevel;
  profile: Profile | null;
  progress: TutorProgress;
  onProgress: (next: TutorProgress) => void;
  onBack: () => void;
}): JSX.Element {
  const key = progressKey(mod.id, target, learner);
  const [phase, setPhase] = useState<TutorPhase>(() => nextPhase(progress[key]) ?? "crawl");
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [capabilities, setCapabilities] = useState<LessonResponse["capabilities"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The lesson is fetched once per (module, target, learner). The route serves
  // it from cache on every visit after the first, so re-entering a module is
  // free — that is the whole reason the cache exists.
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setLesson(null);
    void (async () => {
      try {
        const res = await fetch("/api/tutor/lesson", {
          method: "POST",
          headers: await jsonAuthHeaders(),
          body: JSON.stringify({ moduleId: mod.id, target, learner })
        });
        const payload = (await res.json().catch(() => ({}))) as LessonResponse;
        if (!active) return;
        if (!res.ok || !payload.lesson) {
          setError(payload.details || payload.error || "Could not build that lesson.");
        } else {
          setLesson(payload.lesson);
          setCapabilities(payload.capabilities ?? null);
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Could not build that lesson.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [mod.id, target, learner]);

  const markDone = (which: TutorPhase) => {
    onProgress(markPhaseDone(progress, key, which, new Date().toISOString()));
  };

  return (
    <main className="min-h-screen px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-[calc(env(safe-area-inset-top)+1rem)]">
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-md flex-col gap-4">
        {header}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-amber-100/70"
          >
            ← Modules
          </button>
          <span className="min-w-0 flex-1 truncate text-sm text-amber-100/70">
            {tutorModuleNumber(mod.id)}. {mod.title} · {languageNative(target)}
          </span>
        </div>

        <div className="flex rounded-full border border-white/10 bg-white/5 p-0.5 text-xs">
          {(["crawl", "walk", "run"] as TutorPhase[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPhase(p)}
              className={`flex-1 rounded-full px-3 py-1.5 capitalize transition ${
                phase === p ? "bg-amber-400 text-stone-950" : "text-amber-100/70"
              }`}
            >
              {p}
              {progress[key]?.[p as "crawl" | "walk" | "run"] ? " ✓" : ""}
            </button>
          ))}
        </div>

        {loading ? (
          <p className="animate-pulse rounded-2xl border border-white/10 bg-white/5 px-4 py-6 text-center text-sm text-amber-100/70">
            Building your {languageLabel(target)} lesson…
          </p>
        ) : error ? (
          <p className="rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            {error}
          </p>
        ) : lesson ? (
          phase === "crawl" ? (
            <Crawl
              lesson={lesson}
              module={mod}
              target={target}
              learner={learner}
              profile={profile}
              scoringAvailable={capabilities?.pronunciationScoring !== false}
              bestScore={progress[key]?.bestScore}
              onScore={(score) => onProgress(recordScore(progress, key, score))}
              onDone={() => {
                markDone("crawl");
                setPhase("walk");
              }}
            />
          ) : (
            <RealtimePhase
              key={phase}
              phase={phase}
              lesson={lesson}
              module={mod}
              target={target}
              learner={learner}
              level={level}
              onDone={() => {
                markDone(phase);
                if (phase === "walk") setPhase("run");
              }}
            />
          )
        ) : null}
      </div>
    </main>
  );
}

// ── Crawl ──────────────────────────────────────────────────────────────────

function Crawl({
  lesson,
  module: mod,
  target,
  learner,
  profile,
  scoringAvailable,
  bestScore,
  onScore,
  onDone
}: {
  lesson: Lesson;
  module: TutorModule;
  target: string;
  learner: string;
  profile: Profile | null;
  scoringAvailable: boolean;
  bestScore?: number;
  onScore: (score: number) => void;
  onDone: () => void;
}): JSX.Element {
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState<"idle" | "recording" | "scoring">("idle");
  const [result, setResult] = useState<AssessResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef("");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const items = lesson.pronunciation;
  const item: LessonPronunciationItem | undefined = items[index];
  const engine = isSubscriber(profile) ? "elevenlabs" : "openai";

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function hear(text: string) {
    if (!audioRef.current && typeof Audio !== "undefined") audioRef.current = new Audio();
    const a = audioRef.current;
    if (!a) return;
    try {
      // Unlock the element inside the tap, the same dance /translate does.
      a.play().catch(() => {});
      a.pause();
      // No `sourceLanguage` on purpose. That field picks the CLONE under the
      // voice-follows-speaker rule (lib/tts/voice.ts), and the speaker here is
      // the tutor — neither Tom nor Liz. Omitting it lands on the default
      // multilingual voice, which is what a Hindi lesson should sound like.
      const blob = await requestSpeech({ text, engine, targetLanguage: target });
      if (!blob) return; // tier 2 — the page says so already
      a.src = URL.createObjectURL(blob);
      await a.play();
    } catch {
      /* a phrase that won't speak is not an error worth a banner */
    }
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
      // Interrupted mic scores what was captured instead of hanging the drill
      // (the 7/27 TranslatorShell fix, carried over).
      recorder.onerror = () => stopRecording();
      for (const track of stream.getAudioTracks()) track.onended = () => stopRecording();
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
    if (!item || blob.size === 0) {
      setStatus("idle");
      return;
    }
    try {
      const wav = await blobToWav16k(blob);
      const form = new FormData();
      form.append("audio", wav, "attempt.wav");
      form.append("referenceText", item.phrase);
      // Catalog codes, both of them: the route maps the target to an Azure
      // locale and names both languages to the coach.
      form.append("language", target);
      form.append("learner", learner);
      const res = await fetch("/api/tutor/assess", {
        method: "POST",
        headers: await authHeaders(),
        body: form
      });
      const payload = (await res.json().catch(() => ({}))) as AssessResult;
      if (!res.ok && !payload.configured) throw new Error(payload.error || "Scoring failed.");
      setResult(payload);
      if (payload.configured && typeof payload.pron === "number") {
        onScore(payload.pron);
        void saveTutorAttempt({
          course: "modules",
          lesson_id: `${mod.id}:${target}`,
          target_phrase: item.phrase,
          transcript: payload.transcript ?? null,
          target_lang: target,
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
  const hook = lesson.contrastHook;

  return (
    <section className="flex flex-col gap-3 pb-4">
      {/* The contrast hook — the lesson's headline, not a footnote. */}
      <div className="rounded-3xl border border-amber-300/25 bg-[rgba(46,34,18,0.6)] p-4">
        <p className="text-[10px] uppercase tracking-[0.2em] text-amber-200/60">
          {languageLabel(target)} vs {languageLabel(learner)}
        </p>
        <p className="mt-1 text-base font-semibold text-amber-100">{hook.headline}</p>
        <p className="mt-2 text-sm leading-relaxed text-amber-50/80">{hook.explanation}</p>
        {hook.example ? (
          <div className="mt-3 rounded-2xl bg-black/25 p-3">
            <p className="text-lg text-white">{hook.example.target}</p>
            {hook.example.romanization ? (
              <p className="text-sm text-amber-100/60">{hook.example.romanization}</p>
            ) : null}
            {hook.example.literal ? (
              <p className="mt-1 text-xs italic text-emerald-200/70">{hook.example.literal}</p>
            ) : null}
            <p className="mt-1 text-sm text-amber-50/70">{hook.example.meaning}</p>
          </div>
        ) : null}
        {hook.sameAsLearner ? (
          <p className="mt-2 text-xs text-emerald-200/70">
            This one maps across cleanly — the structure is the same as {languageLabel(learner)}.
          </p>
        ) : null}
      </div>

      {/* The phrases */}
      <div className="rounded-3xl border border-white/10 bg-[rgba(18,44,36,0.6)] p-4">
        <p className="text-[10px] uppercase tracking-[0.2em] text-emerald-100/50">The phrases</p>
        <ul className="mt-2 flex flex-col gap-3">
          {lesson.phrases.map((p, i) => (
            <li key={`${p.move}-${i}`} className="border-b border-white/5 pb-3 last:border-0 last:pb-0">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-lg leading-snug text-white">{p.target}</p>
                  {p.romanization ? (
                    <p className="text-sm text-amber-100/55">{p.romanization}</p>
                  ) : null}
                  <p className="mt-0.5 text-sm text-amber-50/70">{p.meaning}</p>
                  {p.literal ? (
                    <p className="mt-0.5 text-xs italic text-emerald-200/60">{p.literal}</p>
                  ) : null}
                  {p.note ? <p className="mt-0.5 text-xs text-amber-100/45">{p.note}</p> : null}
                </div>
                {!isTextOnlyLanguage(target) ? (
                  <button
                    type="button"
                    onClick={() => void hear(p.target)}
                    aria-label={`Hear ${p.target}`}
                    className="shrink-0 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-emerald-100"
                  >
                    🔊
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* Repeat-after-me, scored */}
      {item ? (
        <div className="rounded-3xl border border-white/10 bg-[rgba(20,16,14,0.86)] p-4">
          <div className="flex items-baseline justify-between text-xs uppercase tracking-[0.18em] text-emerald-100/50">
            <span>Say it</span>
            <span>
              {index + 1} / {items.length}
            </span>
          </div>
          <p className="mt-2 text-[clamp(1.5rem,6vw,2.2rem)] font-semibold leading-tight text-white">
            {item.phrase}
          </p>
          {item.romanization ? (
            <p className="text-base text-amber-100/60">{item.romanization}</p>
          ) : null}
          {item.meaning ? <p className="mt-1 text-sm text-amber-50/70">{item.meaning}</p> : null}
          {item.why ? <p className="mt-2 text-xs text-amber-100/50">{item.why}</p> : null}

          {!isTextOnlyLanguage(target) ? (
            <button
              type="button"
              onClick={() => void hear(item.phrase)}
              className="mt-3 self-start rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-emerald-100"
            >
              🔊 Hear it
            </button>
          ) : (
            <p className="mt-3 text-xs text-amber-100/50">{TEXT_ONLY_TITLE}</p>
          )}

          {!scoringAvailable ? (
            // The third tier (lib/tutor/pronunciation.ts): the lesson works,
            // the score does not exist for this language. Say so where the
            // button would be rather than letting a tap do nothing.
            <p className="mt-3 rounded-2xl border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-xs text-amber-100/80">
              Pronunciation scoring isn&apos;t available for {languageLabel(target)} yet. Repeat it
              after the audio and move on when it feels close.
            </p>
          ) : (
            <>
              <button
                type="button"
                onClick={() => (recording ? stopRecording() : void startRecording())}
                disabled={scoring}
                className={`mt-3 flex h-14 w-full items-center justify-center gap-3 rounded-2xl text-base font-semibold transition active:scale-[0.99] disabled:opacity-60 ${
                  recording
                    ? "animate-pulse bg-amber-400 text-stone-950"
                    : "border border-amber-300/30 bg-stone-50 text-stone-900"
                }`}
              >
                <span
                  className={`inline-block rounded-[6px] ${recording ? "h-4 w-4 bg-stone-900/85" : "h-5 w-5 bg-amber-500"}`}
                />
                {recording ? "Stop" : scoring ? "Scoring…" : "Hold-to-talk: say it"}
              </button>

              {result ? (
                result.configured === false || result.supported === false ? (
                  <p className="mt-3 rounded-2xl border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-xs text-amber-100/80">
                    {result.message}
                  </p>
                ) : (
                  <div className="mt-3 rounded-2xl border border-white/10 bg-white/5 p-3">
                    <div className="flex items-baseline justify-between">
                      <span className="text-sm text-amber-100/60">Pronunciation</span>
                      <span className={`text-3xl font-bold ${scoreColor(result.pron ?? null)}`}>
                        {typeof result.pron === "number" ? Math.round(result.pron) : "—"}
                      </span>
                    </div>
                    {result.words?.length ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
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
                      <p className="mt-2 text-sm text-amber-50/85">{result.coaching}</p>
                    ) : null}
                  </div>
                )
              ) : null}
            </>
          )}

          {error ? (
            <p className="mt-3 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
              {error}
            </p>
          ) : null}

          <div className="mt-3 flex items-center justify-between text-sm">
            <span className="text-amber-100/40">
              {typeof bestScore === "number" ? `Best ${bestScore}` : ""}
            </span>
            {index + 1 < items.length ? (
              <button
                type="button"
                onClick={() => {
                  setIndex(index + 1);
                  setResult(null);
                  setError(null);
                }}
                className="font-medium text-amber-300"
              >
                Next phrase →
              </button>
            ) : (
              <button type="button" onClick={onDone} className="font-medium text-amber-300">
                Done · go to Walk →
              </button>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

// ── Walk and Run ───────────────────────────────────────────────────────────
// Both are a realtime session with a different persona and a different thing
// on screen beside it, so they are one component with two headers.

function RealtimePhase({
  phase,
  lesson,
  module: mod,
  target,
  learner,
  level,
  onDone
}: {
  phase: TutorPhase;
  lesson: Lesson;
  module: TutorModule;
  target: string;
  learner: string;
  level: TutorLevel;
  onDone: () => void;
}): JSX.Element {
  const [state, setState] = useState<ConvState>("idle");
  const [lines, setLines] = useState<Array<{ role: "user" | "tutor"; text: string }>>([]);
  const [live, setLive] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);

  const sessRef = useRef<ActiveConversation | null>(null);
  const liveRef = useRef("");
  const feedRef = useRef<HTMLDivElement | null>(null);

  const maxMs = phase === "walk" ? WALK_MAX_MS : RUN_MAX_MS;
  const active = state === "connected";
  const connecting = state === "requesting_mic" || state === "minting" || state === "connecting";

  useEffect(() => {
    return () => {
      void sessRef.current?.stop("user");
    };
  }, []);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [lines, live]);

  async function start() {
    setError(null);
    setNotice(null);
    setLines([]);
    setLive("");
    liveRef.current = "";
    setElapsed(0);
    setMuted(false);
    const { data } = await supabase.auth.getSession();
    try {
      sessRef.current = await startConversation(
        {
          target,
          learner,
          level,
          phase,
          moduleId: mod.id,
          maxDurationMs: maxMs,
          idleTimeoutMs: IDLE_MS,
          authToken: data.session?.access_token
        },
        {
          onState: setState,
          onError: setError,
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
          onTick: setElapsed,
          onStopped: (reason: StopReason) => {
            sessRef.current = null;
            if (reason === "cap") setNotice("That's the time limit for this scene.");
            else if (reason === "idle") setNotice("Paused after a quiet stretch. Tap Start to keep going.");
          }
        }
      );
    } catch {
      /* onError/onStopped already fired */
    }
  }

  const rp = lesson.roleplay;

  return (
    <section className="flex flex-col gap-3 pb-4">
      {phase === "walk" ? (
        <div className="rounded-3xl border border-white/10 bg-[rgba(18,44,36,0.6)] p-4">
          <p className="text-[10px] uppercase tracking-[0.2em] text-emerald-100/50">The scene</p>
          <p className="mt-1 text-sm text-amber-50/80">{rp.setting}</p>
          <p className="mt-1 text-xs text-amber-100/50">
            The tutor plays {rp.tutorRole}. You are {rp.learnerRole}.
          </p>
          <p className="mt-3 text-[10px] uppercase tracking-[0.2em] text-emerald-100/50">
            Your lines
          </p>
          <ol className="mt-1 flex flex-col gap-2">
            {rp.learnerLines.map((l, i) => (
              <li key={i} className="text-sm">
                <span className="text-amber-100/40">{l.cue}</span>
                <p className="text-base text-white">{l.target}</p>
                {l.romanization ? (
                  <p className="text-xs text-amber-100/55">{l.romanization}</p>
                ) : null}
                <p className="text-xs text-amber-50/60">{l.meaning}</p>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <div className="rounded-3xl border border-white/10 bg-[rgba(18,44,36,0.6)] p-4">
          <p className="text-[10px] uppercase tracking-[0.2em] text-emerald-100/50">Free talk</p>
          <p className="mt-1 text-sm text-amber-50/80">{lesson.runGoal}</p>
          <p className="mt-2 text-xs text-amber-100/50">
            No script. The tutor stays in character and keeps you inside{" "}
            {mod.title.toLowerCase()} — wander off and it will bring you back.
          </p>
        </div>
      )}

      {active || connecting ? (
        <>
          <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-[rgba(20,16,14,0.86)] px-4 py-3">
            <span className="flex items-center gap-2 text-sm">
              <span
                className={`inline-block h-2.5 w-2.5 rounded-full ${
                  active ? "animate-pulse bg-emerald-400" : "bg-amber-300"
                }`}
              />
              <span className="text-amber-100/80">
                {connecting ? "Connecting…" : `Live · ${languageNative(target)}`}
              </span>
            </span>
            <span className="font-mono text-sm text-amber-100/70">
              {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
            </span>
          </div>

          <div
            ref={feedRef}
            className="flex-1 space-y-2 overflow-y-auto rounded-3xl border border-white/10 bg-[rgba(18,44,36,0.5)] p-4"
            style={{ maxHeight: "40vh" }}
          >
            {lines.length === 0 && !live ? (
              <p className="py-6 text-center text-sm text-amber-100/40">
                {phase === "walk" ? "The scene is starting…" : "Say something to get going…"}
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

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                const next = !muted;
                setMuted(next);
                sessRef.current?.setMicEnabled(!next);
              }}
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
              onClick={() => void sessRef.current?.stop("user")}
              className="flex-1 rounded-2xl border border-rose-400/40 bg-rose-500/20 px-3 py-3 text-sm font-semibold text-rose-100 transition active:scale-[0.99]"
            >
              End
            </button>
          </div>
        </>
      ) : (
        <button
          type="button"
          onClick={() => void start()}
          className="flex h-16 items-center justify-center gap-3 rounded-2xl border border-amber-300/30 bg-stone-50 text-lg font-semibold text-stone-900 transition active:scale-[0.99]"
        >
          <span className="inline-block h-5 w-5 rounded-full bg-emerald-500" />
          {phase === "walk" ? "Start the scene" : "Start talking"}
        </button>
      )}

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
        onClick={onDone}
        className="self-end text-sm font-medium text-amber-300"
      >
        {phase === "walk" ? "Mark Walk done · go to Run →" : "Mark Run done →"}
      </button>
    </section>
  );
}
