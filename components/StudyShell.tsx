"use client";

// /study — lessons from your own conversations.
//
// Tutor teaches someone else's curriculum. Study has no curriculum: the
// material is what you and the person across the table actually said. Pick a
// line, get the breakdown (lib/study/lesson.ts), hear it in the speaker's
// voice, and build it back up out loud.
//
// What this first cut deliberately does NOT do: score your pronunciation.
// The app's Azure scoring (/api/tutor/assess) is metered through tutor minutes
// and gated by tutorEnabled(); wiring Study into it is a decision about
// billing, not a wiring job, and it is noted in ENHANCEMENTS.md rather than
// smuggled in here.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  deleteStudyLesson,
  listHistory,
  listStudyLessons,
  supabase,
  type HistoryRow,
  type StudyLessonRow
} from "@/lib/supabase";
import { jsonAuthHeaders } from "@/lib/authClient";
import { requestSpeech } from "@/lib/tts/speech";
import { languageNative } from "@/lib/languages/catalog";
import { conversationTitle, groupConversations, sideIn, type Conversation } from "@/lib/study/group";
import type { StudyLessonResponse } from "@/lib/study/types";
import { StudyLessonCard } from "./study/StudyLessonCard";
import { SignIn } from "./SignIn";

const LEARN_KEY = "taos.study.learn";
const EXPLAIN_KEY = "taos.study.explain";
const HISTORY_LIMIT = 400;

type View = "pick" | "lesson" | "library";

function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

/** Languages present in the history, most common first. */
function languagesPresent(rows: HistoryRow[]): string[] {
  const count = new Map<string, number>();
  for (const r of rows) {
    for (const code of [r.source_lang, r.target_lang]) {
      if (code) count.set(code, (count.get(code) ?? 0) + 1);
    }
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([code]) => code);
}

function dayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
function timeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

const btn =
  "min-h-[44px] rounded-full border px-4 text-sm transition disabled:opacity-50 " +
  "border-amber-300/30 bg-amber-400/10 text-amber-100 hover:bg-amber-400/20";
const ghost =
  "min-h-[44px] rounded-full border px-4 text-sm transition disabled:opacity-50 " +
  "border-white/15 bg-white/[0.04] text-amber-100/85 hover:bg-amber-400/10";
const select =
  "min-h-[44px] rounded-xl border border-white/15 bg-white/[0.04] px-3 text-sm text-amber-100";

export function StudyShell(): JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [library, setLibrary] = useState<StudyLessonRow[]>([]);
  const [learn, setLearn] = useState<string>("");
  const [explain, setExplain] = useState<string>("");
  const [view, setView] = useState<View>("pick");
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lesson, setLesson] = useState<StudyLessonResponse | null>(null);
  const playing = useRef<HTMLAudioElement | null>(null);

  // ── auth ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      if (active) setSession(next);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  // ── history + library ────────────────────────────────────────────────────
  const reload = useCallback(async () => {
    try {
      const [h, l] = await Promise.all([listHistory(HISTORY_LIMIT), listStudyLessons()]);
      setRows(h);
      setLibrary(l);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your history.");
    }
  }, []);
  useEffect(() => {
    if (session) void reload();
  }, [session, reload]);

  // ── languages ────────────────────────────────────────────────────────────
  const present = useMemo(() => languagesPresent(rows), [rows]);
  useEffect(() => {
    if (!present.length || (learn && explain)) return;
    // Default: learn the most common non-English language; explain in English.
    // Liz's phone is the mirror image: learn English, explained in Spanish.
    const storedLearn = readPref(LEARN_KEY);
    const storedExplain = readPref(EXPLAIN_KEY);
    const nonEn = present.find((c) => c !== "en") ?? "es";
    const l = storedLearn && present.includes(storedLearn) ? storedLearn : nonEn;
    const x = storedExplain && storedExplain !== l ? storedExplain : l === "en" ? nonEn : "en";
    setLearn(l);
    setExplain(x);
  }, [present, learn, explain]);

  const conversations = useMemo(() => groupConversations(rows), [rows]);
  const options = useMemo(() => {
    const set = new Set([...present, "en", "es"]);
    return [...set];
  }, [present]);

  // ── actions ──────────────────────────────────────────────────────────────
  const makeLesson = useCallback(
    async (id: string, force = false) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/study/lesson", {
          method: "POST",
          headers: await jsonAuthHeaders(),
          body: JSON.stringify({ ids: [id], target: learn, explain, force })
        });
        const data = (await res.json().catch(() => ({}))) as StudyLessonResponse & { error?: string };
        if (!res.ok) throw new Error(data.error || "Could not make that lesson.");
        setLesson(data);
        setView("lesson");
        void listStudyLessons().then(setLibrary).catch(() => undefined);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not make that lesson.");
      } finally {
        setBusy(false);
      }
    },
    [learn, explain]
  );

  const openSaved = useCallback((row: StudyLessonRow) => {
    setLesson({
      id: row.id,
      key: row.lesson_key,
      lesson: row.lesson,
      cached: true,
      model: row.model,
      target: row.target_lang,
      explain: row.explain_lang,
      sources: []
    });
    setView("lesson");
  }, []);

  const remove = useCallback(async (id: string) => {
    try {
      await deleteStudyLesson(id);
      setLibrary((l) => l.filter((r) => r.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete that lesson.");
    }
  }, []);

  // Voice follows the SPEAKER (lib/tts/voice.ts): a sentence in the language
  // being learned was said by the person who speaks it, so asking for that
  // language as the source picks their clone — Liz's for Spanish, Tom's for
  // English — on a phone that holds the personal-voice code. Anyone else gets
  // the standard voice, quietly, which is the rule everywhere in the app.
  const hear = useCallback(
    async (text: string, slow: boolean) => {
      const lang = lesson?.target ?? learn;
      // Made inside the tap, so Safari lets it play.
      const audio = new Audio();
      if (playing.current) playing.current.pause();
      playing.current = audio;
      setSpeaking(true);
      try {
        const blob = await requestSpeech({ text, sourceLanguage: lang, targetLanguage: lang, engine: "elevenlabs" });
        if (!blob) return;
        audio.src = URL.createObjectURL(blob);
        audio.playbackRate = slow ? 0.75 : 1;
        audio.onended = () => URL.revokeObjectURL(audio.src);
        await audio.play();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Voice playback failed.");
      } finally {
        setSpeaking(false);
      }
    },
    [lesson, learn]
  );

  // ── render ───────────────────────────────────────────────────────────────
  if (!ready) return <main className="min-h-screen" />;
  if (!session) {
    return (
      <SignIn
        redirectPath="/study"
        title="Study · Estudio"
        blurb="Lessons from your own conversations. · Lecciones de tus propias conversaciones."
      />
    );
  }

  const name = (code: string): string => languageNative(code) || code;

  return (
    <main className="min-h-screen px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-[calc(env(safe-area-inset-top)+1rem)]">
      <div className="mx-auto flex max-w-md flex-col gap-4">
        <header className="flex items-center gap-3">
          <a href="/" className={ghost} aria-label="Back to TAOS · Volver">
            ←
          </a>
          <h1 className="text-base font-semibold tracking-tight text-amber-200">Study · Estudio</h1>
          <span className="flex-1" />
          <button type="button" className={ghost} onClick={() => setView(view === "library" ? "pick" : "library")}>
            {view === "library" ? "Pick a line · Elegir" : `Lessons · Lecciones${library.length ? ` (${library.length})` : ""}`}
          </button>
        </header>

        <section className="flex flex-wrap items-end gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3">
          <label className="flex flex-col gap-1 text-[11px] uppercase tracking-[0.04em] text-amber-100/55">
            Learning · Aprendiendo
            <select
              className={select}
              value={learn}
              onChange={(e) => {
                setLearn(e.target.value);
                writePref(LEARN_KEY, e.target.value);
                if (e.target.value === explain) {
                  const other = options.find((c) => c !== e.target.value) ?? "en";
                  setExplain(other);
                  writePref(EXPLAIN_KEY, other);
                }
              }}
            >
              {options.map((c) => (
                <option key={c} value={c}>
                  {name(c)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] uppercase tracking-[0.04em] text-amber-100/55">
            Explained in · Explicado en
            <select
              className={select}
              value={explain}
              onChange={(e) => {
                setExplain(e.target.value);
                writePref(EXPLAIN_KEY, e.target.value);
              }}
            >
              {options
                .filter((c) => c !== learn)
                .map((c) => (
                  <option key={c} value={c}>
                    {name(c)}
                  </option>
                ))}
            </select>
          </label>
        </section>

        {error ? (
          <div role="alert" className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
            {error}
          </div>
        ) : null}

        {view === "lesson" && lesson ? (
          <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <button type="button" className={ghost} onClick={() => setView("pick")}>
                ← Back · Volver
              </button>
              <span className="flex-1" />
              {lesson.sources[0] ? (
                <button type="button" className={ghost} disabled={busy} onClick={() => void makeLesson(lesson.sources[0].id, true)}>
                  {busy ? "…" : "Again · Otra vez"}
                </button>
              ) : null}
            </div>
            <StudyLessonCard lesson={lesson.lesson} target={lesson.target} explain={lesson.explain} onHear={hear} busy={speaking} />
          </section>
        ) : view === "library" ? (
          <section className="flex flex-col gap-2">
            {library.length === 0 ? (
              <p className="px-1 text-sm text-amber-100/60">No lessons yet. · Aún no hay lecciones.</p>
            ) : null}
            {library.map((row) => (
              <div key={row.id} className="flex items-start gap-2 rounded-2xl border border-white/10 bg-white/[0.03] p-3">
                <button type="button" className="min-h-[44px] flex-1 text-left" onClick={() => openSaved(row)}>
                  <div className="text-base font-semibold text-white">{row.lesson.sentences[0]?.target ?? ""}</div>
                  <div className="text-sm text-amber-100/65">{row.lesson.sentences[0]?.english ?? ""}</div>
                  <div className="mt-1 text-[11px] text-amber-100/45">
                    {name(row.target_lang)} · {dayLabel(Date.parse(row.created_at))}
                  </div>
                </button>
                <button type="button" className={ghost} aria-label="Delete · Borrar" onClick={() => void remove(row.id)}>
                  ✕
                </button>
              </div>
            ))}
          </section>
        ) : (
          <section className="flex flex-col gap-2">
            {rows.length === 0 ? (
              <p className="px-1 text-sm text-amber-100/60">
                Nothing to study yet — translate something first. · Nada que estudiar aún — traduce algo primero.
              </p>
            ) : null}
            {conversations.map((c: Conversation) => {
              const isOpen = open === c.key;
              const title = conversationTitle(c, learn) || c.turns[0]?.original_text || "";
              return (
                <div key={c.key} className="rounded-2xl border border-white/10 bg-white/[0.03]">
                  <button
                    type="button"
                    className="flex min-h-[44px] w-full flex-col items-start gap-0.5 px-3 py-2.5 text-left"
                    aria-expanded={isOpen}
                    onClick={() => setOpen(isOpen ? null : c.key)}
                  >
                    <div className="flex w-full items-center gap-2 text-[11px] text-amber-100/50">
                      <span>{dayLabel(c.startedAt)}</span>
                      <span>{timeLabel(c.startedAt)}</span>
                      <span className="flex-1" />
                      <span>
                        {c.turns.length} {c.turns.length === 1 ? "line" : "lines"}
                        {c.reconstructed ? " · ~" : ""}
                      </span>
                    </div>
                    <div className="line-clamp-2 text-[15px] text-amber-100/90">{title}</div>
                  </button>
                  {isOpen ? (
                    <ol className="flex flex-col gap-1 border-t border-white/10 px-3 py-2">
                      {c.turns.map((t) => {
                        const line = sideIn(t, learn);
                        return (
                          <li key={t.id} className="flex items-start gap-2 py-1">
                            <div className="flex-1 text-[15px] leading-snug text-white">
                              {line ?? <span className="text-amber-100/45">{t.original_text}</span>}
                            </div>
                            <button
                              type="button"
                              className={btn}
                              disabled={busy || line === null}
                              onClick={() => void makeLesson(t.id)}
                              aria-label={`Make a lesson from: ${line ?? t.original_text}`}
                            >
                              {busy ? "…" : "Lesson · Lección"}
                            </button>
                          </li>
                        );
                      })}
                    </ol>
                  ) : null}
                </div>
              );
            })}
          </section>
        )}

        {busy ? (
          <p className="px-1 text-center text-xs text-amber-100/50">
            Making your lesson — about 15 seconds. · Preparando tu lección — unos 15 segundos.
          </p>
        ) : null}
      </div>
    </main>
  );
}
