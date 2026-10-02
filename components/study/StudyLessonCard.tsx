"use client";

// One lesson, rendered. A port of the viewer prototype's renderLesson() into
// the app's own styling — the same sections in the same order, because that
// order was what the stress run judged: the sentence, its words, why they are
// in THAT order (with the explain-language order struck through), what it
// meant in context, and the build-up ladder to say out loud.

import type { StudyLesson, StudySentence } from "@/lib/study/types";

/** Section headings in the language the lesson is written in. */
const LABELS: Record<string, {
  words: string;
  why: string;
  literal: string;
  trap: (x: string) => string;
  right: (t: string) => string;
  context: string;
  build: string;
  captured: (s: string) => string;
  note: string;
  hear: string;
  slow: string;
}> = {
  en: {
    words: "The words",
    why: "Why this order",
    literal: "Word for word",
    trap: (x) => `${x} order ✗`,
    right: (t) => `${t} order ✓`,
    context: "In context",
    build: "Build it up — say each one out loud",
    captured: (s) => `Captured as: “${s}” — cleaned up above.`,
    note: "Note",
    hear: "Hear it",
    slow: "Slowly"
  },
  es: {
    words: "Las palabras",
    why: "Por qué este orden",
    literal: "Palabra por palabra",
    trap: (x) => `Orden del ${x} ✗`,
    right: (t) => `Orden del ${t} ✓`,
    context: "En contexto",
    build: "Constrúyelo — di cada una en voz alta",
    captured: (s) => `Capturado como: “${s}” — corregido arriba.`,
    note: "Nota",
    hear: "Escúchalo",
    slow: "Despacio"
  }
};

/** Language names in the lesson's own language: "inglés", not "English". */
function nameIn(code: string, inLang: string): string {
  try {
    return new Intl.DisplayNames([inLang], { type: "language" }).of(code) || code;
  } catch {
    return code;
  }
}

function H4({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <h4 className="mb-2 mt-5 text-[11px] font-semibold uppercase tracking-[0.05em] text-amber-100/55">
      {children}
    </h4>
  );
}

function Say({
  text,
  label,
  slowLabel,
  onHear,
  busy
}: {
  text: string;
  label: string;
  slowLabel: string;
  onHear: (text: string, slow: boolean) => void;
  busy: boolean;
}): JSX.Element {
  const base =
    "min-h-[36px] rounded-full border px-3 text-[13px] transition disabled:opacity-50 " +
    "border-white/15 bg-white/[0.04] text-amber-100/85 hover:bg-amber-400/10";
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      <button type="button" className={base} disabled={busy} onClick={() => onHear(text, false)} aria-label={`${label}: ${text}`}>
        ▶ {label}
      </button>
      <button type="button" className={base} disabled={busy} onClick={() => onHear(text, true)} aria-label={`${slowLabel}: ${text}`}>
        🐢 {slowLabel}
      </button>
    </div>
  );
}

function Sentence({
  s,
  tName,
  xName,
  L,
  onHear,
  busy
}: {
  s: StudySentence;
  tName: string;
  xName: string;
  L: (typeof LABELS)["en"];
  onHear: (text: string, slow: boolean) => void;
  busy: boolean;
}): JSX.Element {
  const notes = s.words.filter((w) => w.note);
  return (
    <section className="[&+&]:mt-7 [&+&]:border-t [&+&]:border-white/10 [&+&]:pt-5">
      <div className="text-2xl font-semibold leading-tight tracking-[-0.01em] text-white">{s.target}</div>
      <div className="mt-1 text-[15px] text-amber-100/65">{s.english}</div>
      <Say text={s.target} label={L.hear} slowLabel={L.slow} onHear={onHear} busy={busy} />
      {s.as_said ? <div className="mt-2 text-xs text-amber-100/50">{L.captured(s.as_said)}</div> : null}

      <H4>{L.words}</H4>
      <div className="flex flex-wrap gap-1.5">
        {s.words.map((w, i) => (
          <div
            key={`${w.text}-${i}`}
            className="min-w-[64px] rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5"
            title={w.lemma && w.lemma !== w.text ? `from ${w.lemma}` : undefined}
          >
            <div className="text-base text-white">{w.text}</div>
            <div className="text-xs text-amber-100/80">{w.gloss}</div>
            <div className="text-[10px] uppercase tracking-[0.04em] text-amber-100/45">{w.role}</div>
          </div>
        ))}
      </div>
      {notes.length ? (
        <ul className="mt-2 list-disc pl-5 text-[13px] text-amber-100/65">
          {notes.map((w, i) => (
            <li key={`${w.text}-note-${i}`}>
              <b className="text-amber-100/90">{w.text}</b> — {w.note}
            </li>
          ))}
        </ul>
      ) : null}

      <H4>{L.why}</H4>
      <div className="grid grid-cols-[max-content_1fr] items-baseline gap-x-3 gap-y-1.5">
        {s.literal ? (
          <>
            <span className="text-[11px] uppercase tracking-[0.04em] text-amber-100/50">{L.literal}</span>
            <span className="text-amber-100/85">{s.literal}</span>
          </>
        ) : null}
        {s.english_order_trap ? (
          <>
            <span className="text-[11px] uppercase tracking-[0.04em] text-amber-100/50">{L.trap(xName)}</span>
            <span className="text-rose-300 line-through decoration-rose-400">{s.english_order_trap}</span>
          </>
        ) : null}
        <span className="text-[11px] uppercase tracking-[0.04em] text-amber-100/50">{L.right(tName)}</span>
        <span className="font-semibold text-white">{s.target}</span>
      </div>
      {s.order_points.length ? (
        <ul className="mt-2.5 list-disc space-y-2 pl-5 text-[14px] text-amber-100/85">
          {s.order_points.map((p, i) => (
            <li key={`${p.rule}-${i}`}>
              <b className="text-white">{p.rule}</b> — {p.explanation}
              {p.example ? <div className="mt-0.5 italic text-amber-100/55">{p.example}</div> : null}
            </li>
          ))}
        </ul>
      ) : null}

      <H4>{L.context}</H4>
      <div className="text-[14px] text-amber-100/85">
        {s.context_meaning}{" "}
        {s.register ? (
          <span className="ml-1 inline-block rounded-full border border-white/15 px-2 py-0.5 text-[11px] text-amber-100/70">
            {s.register}
          </span>
        ) : null}
      </div>

      {s.chunks.length ? (
        <>
          <H4>{L.build}</H4>
          <ol className="list-decimal space-y-2 pl-6">
            {s.chunks.map((c, i) => (
              <li key={`${c}-${i}`} className="text-base text-white">
                <div>{c}</div>
                <Say text={c} label={L.hear} slowLabel={L.slow} onHear={onHear} busy={busy} />
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </section>
  );
}

export function StudyLessonCard({
  lesson,
  target,
  explain,
  onHear,
  busy = false
}: {
  lesson: StudyLesson;
  target: string;
  explain: string;
  /** Play `text` in the target language; `slow` asks for the slower read. */
  onHear: (text: string, slow: boolean) => void;
  busy?: boolean;
}): JSX.Element {
  const L = LABELS[explain] ?? LABELS.en;
  const tName = nameIn(target, explain);
  const xName = nameIn(explain, explain);
  return (
    <div>
      {lesson.sentences.map((s, i) => (
        <Sentence key={`${s.target}-${i}`} s={s} tName={tName} xName={xName} L={L} onHear={onHear} busy={busy} />
      ))}
      {lesson.caveats ? (
        <div className="mt-5 text-xs text-amber-100/50">
          {L.note}: {lesson.caveats}
        </div>
      ) : null}
    </div>
  );
}
