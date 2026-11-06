"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { authHeaders, jsonAuthHeaders } from "@/lib/authClient";
import { ExitHome } from "@/components/ExitHome";
import { copyFor, fill } from "@/lib/chrome/copy";
import { languageLabel, languageLabelEs } from "@/lib/languages/catalog";
import { FLAG_NOTE_MAX, FLAG_REASONS, type FlagReason } from "@/lib/review/flag";
import type { ReviewSpeaker, ReviewTurnRow } from "@/lib/review/store";
import { useLanguagePair } from "@/lib/translate/useLanguagePair";
import { OpinionPanel, TranscriptWithDiff } from "./SecondOpinion";

// /review — the founder translation review screen (Tom, 2026-11-04).
//
// One page, responsive. On a laptop each turn is three columns side by side:
// the audio with its facts, the transcript, the translation — Tom's question
// is "which of the two went wrong?", and the three have to be in one glance.
// On a phone the same row stacks, and the flag buttons are thumb-sized so
// Liz can work through a day's turns one-handed.
//
// Data: GET /api/review/turns (newest first, filtered by day and speaker),
// POST /api/review/flag (one tap = one reason, saved at once), GET/POST
// /api/review/settings (the opt-in), GET /api/review/export (the tar).
// Second opinion (2026-11-04 20:27 MT): POST /api/review/opinion (one turn)
// and POST /api/review/opinion/batch (a day's unreviewed turns, capped);
// `?sort=suspects` puts the lowest grade / lowest agreement first. The
// grader only highlights — the flag buttons stay the founder's.
// POST /api/review/redo (Redo · Rehacer: the kept clip through the fallback
// transcriber + the same translation, shown beside the first result).

type Turn = ReviewTurnRow & { audio_url: string | null };

interface Props {
  retentionDays?: number;
  /** TAOS_REVIEW_BATCH_MAX — how many turns "check all" sends per click. */
  batchMax?: number;
}

/** Local midnight to local midnight, as instants, for the chosen day. */
export function dayBounds(day: string): { from: string; to: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(start.getTime())) return null;
  const end = new Date(start.getTime());
  end.setDate(end.getDate() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

/** Today, as the <input type="date"> value, in the phone's own timezone. */
export function todayValue(now: Date = new Date()): string {
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

/**
 * A language's name in the CHROME's language — "Inglés" on Liz's phone,
 * "English" on Tom's. The catalog carries both (label / labelEs); an unknown
 * code comes back upper-cased from either, never blank.
 */
function langLabel(code: string, chrome: string): string {
  return chrome === "es" ? languageLabelEs(code) : languageLabel(code);
}

function ms(n: unknown): string {
  return typeof n === "number" ? `${(n / 1000).toFixed(1)}s` : "–";
}

export function ReviewShell({ retentionDays = 14, batchMax = 50 }: Props): JSX.Element {
  const { mine } = useLanguagePair();
  const s = copyFor(mine);

  const [keepAudio, setKeepAudio] = useState<boolean | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [speakers, setSpeakers] = useState<ReviewSpeaker[]>([]);
  const [day, setDay] = useState<string>(() => todayValue());
  const [speaker, setSpeaker] = useState<string>("");
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [redoing, setRedoing] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [suspectsFirst, setSuspectsFirst] = useState(false);
  const [opinionBusy, setOpinionBusy] = useState<string | null>(null);
  const [checkingAll, setCheckingAll] = useState(false);
  const [batchResult, setBatchResult] = useState<{ checked: number; failed: number; more: boolean } | null>(null);

  const reasonLabel: Record<FlagReason, string> = useMemo(
    () => ({ words: s.reviewFlagWords, meaning: s.reviewFlagMeaning, tone: s.reviewFlagTone, other: s.reviewFlagOther }),
    [s]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      const bounds = day ? dayBounds(day) : null;
      if (bounds) {
        params.set("from", bounds.from);
        params.set("to", bounds.to);
      }
      if (speaker) params.set("speaker", speaker);
      if (flaggedOnly) params.set("flagged", "1");
      if (suspectsFirst) params.set("sort", "suspects");
      const res = await fetch(`/api/review/turns?${params.toString()}`, { headers: await authHeaders(), cache: "no-store" });
      const payload = (await res.json().catch(() => ({}))) as { turns?: Turn[]; speakers?: ReviewSpeaker[] };
      if (!res.ok) throw new Error("load");
      setTurns(Array.isArray(payload.turns) ? payload.turns : []);
      setSpeakers(Array.isArray(payload.speakers) ? payload.speakers : []);
    } catch {
      setError(s.reviewFailed);
    } finally {
      setLoading(false);
    }
  }, [day, speaker, flaggedOnly, suspectsFirst, s.reviewFailed]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/review/settings", { headers: await authHeaders(), cache: "no-store" });
        const payload = (await res.json().catch(() => ({}))) as { keepAudio?: unknown };
        if (active && res.ok && typeof payload.keepAudio === "boolean") setKeepAudio(payload.keepAudio);
      } catch {
        // The toggle stays hidden until the setting can be read.
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  async function toggleKeepAudio(): Promise<void> {
    if (keepAudio === null) return;
    const next = !keepAudio;
    setKeepAudio(next);
    try {
      const res = await fetch("/api/review/settings", {
        method: "POST",
        headers: await jsonAuthHeaders(),
        body: JSON.stringify({ keepAudio: next })
      });
      if (!res.ok) setKeepAudio(!next);
    } catch {
      setKeepAudio(!next);
    }
  }

  async function flag(turn: Turn, reason: FlagReason | null): Promise<void> {
    setBusy(turn.id);
    try {
      const note = reason ? (notes[turn.id] ?? turn.flag_note ?? "") : "";
      const res = await fetch("/api/review/flag", {
        method: "POST",
        headers: await jsonAuthHeaders(),
        body: JSON.stringify({ id: turn.id, reason, note })
      });
      const payload = (await res.json().catch(() => ({}))) as { turn?: ReviewTurnRow };
      if (res.ok && payload.turn) {
        const saved = payload.turn;
        setTurns((list) => list.map((t) => (t.id === saved.id ? { ...t, ...saved } : t)));
        if (!reason) setNotes((n) => ({ ...n, [turn.id]: "" }));
      } else {
        setError(s.reviewFailed);
      }
    } catch {
      setError(s.reviewFailed);
    } finally {
      setBusy(null);
    }
  }

  async function secondOpinion(turn: Turn): Promise<void> {
    setOpinionBusy(turn.id);
    setError(null);
    try {
      const res = await fetch("/api/review/opinion", {
        method: "POST",
        headers: await jsonAuthHeaders(),
        body: JSON.stringify({ id: turn.id, explain: mine })
      });
      const payload = (await res.json().catch(() => ({}))) as { turn?: ReviewTurnRow };
      if (res.ok && payload.turn) {
        const saved = payload.turn;
        setTurns((list) => list.map((t) => (t.id === saved.id ? { ...t, ...saved } : t)));
      } else {
        setError(s.reviewOpinionFailed);
      }
    } catch {
      setError(s.reviewOpinionFailed);
    } finally {
      setOpinionBusy(null);
    }
  }

  async function checkAll(): Promise<void> {
    const bounds = day ? dayBounds(day) : null;
    if (!bounds) return;
    setCheckingAll(true);
    setBatchResult(null);
    setError(null);
    try {
      const res = await fetch("/api/review/opinion/batch", {
        method: "POST",
        headers: await jsonAuthHeaders(),
        body: JSON.stringify({ from: bounds.from, to: bounds.to, speaker: speaker || undefined, explain: mine })
      });
      const payload = (await res.json().catch(() => ({}))) as { checked?: number; failed?: number; more?: boolean };
      if (!res.ok) throw new Error("batch");
      setBatchResult({ checked: payload.checked ?? 0, failed: payload.failed ?? 0, more: Boolean(payload.more) });
      await load();
    } catch {
      setError(s.reviewOpinionFailed);
    } finally {
      setCheckingAll(false);
    }
  }

  async function redo(turn: Turn): Promise<void> {
    setRedoing(turn.id);
    setError(null);
    try {
      const res = await fetch("/api/review/redo", {
        method: "POST",
        headers: await jsonAuthHeaders(),
        body: JSON.stringify({ id: turn.id })
      });
      const payload = (await res.json().catch(() => ({}))) as { turn?: ReviewTurnRow };
      if (res.ok && payload.turn) {
        const saved = payload.turn;
        setTurns((list) => list.map((t) => (t.id === saved.id ? { ...t, ...saved } : t)));
      } else {
        setError(s.redoFailed);
      }
    } catch {
      setError(s.redoFailed);
    } finally {
      setRedoing(null);
    }
  }

  async function exportClips(): Promise<void> {
    setExporting(true);
    try {
      const res = await fetch("/api/review/export", { headers: await authHeaders(), cache: "no-store" });
      if (!res.ok) throw new Error("export");
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "review-clips.tar";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setError(s.reviewFailed);
    } finally {
      setExporting(false);
    }
  }

  const speakerLabel = (id: string): string => speakers.find((p) => p.id === id)?.email.split("@")[0] ?? "?";
  const flaggedCount = turns.filter((t) => t.flag_reason).length;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-4 px-3 pb-24 pt-4 text-amber-50 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <ExitHome lang={mine} />
          <div>
            <h1 className="text-2xl font-semibold text-amber-200">{s.reviewTitle}</h1>
            <p className="text-sm text-amber-100/60">{s.reviewTagline}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="min-h-[44px] rounded-2xl border border-white/10 bg-white/5 px-4 text-sm text-amber-100/80 transition hover:bg-amber-400/10"
        >
          {s.reviewRefresh}
        </button>
      </header>

      {/* ── The opt-in ─────────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-amber-300/20 bg-amber-400/5 p-4">
        {keepAudio !== null ? (
          <label className="flex min-h-[44px] cursor-pointer items-center justify-between gap-4">
            <span className="text-sm">
              <span className="font-medium text-amber-100">{s.reviewKeepAudio}</span>
              <br />
              <span className="text-xs text-amber-100/60">{fill(s.reviewKeepAudioHint, { days: retentionDays })}</span>
              {!keepAudio ? (
                <>
                  <br />
                  <span className="text-xs text-amber-200/80">{s.reviewKeepAudioOff}</span>
                </>
              ) : null}
            </span>
            <input
              type="checkbox"
              data-review-keep-audio=""
              checked={keepAudio}
              onChange={() => void toggleKeepAudio()}
              className="h-6 w-6 shrink-0 accent-amber-400"
            />
          </label>
        ) : (
          <p className="text-xs text-amber-100/50">{s.reviewLoading}</p>
        )}
      </section>

      {/* ── Filters ────────────────────────────────────────────────────── */}
      <section className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-amber-100/60">{s.reviewDay}</span>
          <span className="flex gap-2">
            <input
              type="date"
              value={day}
              onChange={(e) => setDay(e.target.value)}
              className="min-h-[44px] rounded-xl border border-white/10 bg-white/5 px-3 text-amber-50"
            />
            <button
              type="button"
              onClick={() => setDay(day ? "" : todayValue())}
              className={`min-h-[44px] rounded-xl border px-3 text-xs transition ${
                day ? "border-white/10 bg-white/5 text-amber-100/70" : "border-amber-300/50 bg-amber-400/15 text-amber-100"
              }`}
            >
              {s.reviewAllDays}
            </button>
          </span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-amber-100/60">{s.reviewSpeaker}</span>
          <select
            value={speaker}
            onChange={(e) => setSpeaker(e.target.value)}
            className="min-h-[44px] rounded-xl border border-white/10 bg-white/5 px-3 text-amber-50"
          >
            <option value="">{s.reviewAllSpeakers}</option>
            {speakers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.email.split("@")[0]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-h-[44px] items-center gap-2">
          <input type="checkbox" checked={flaggedOnly} onChange={(e) => setFlaggedOnly(e.target.checked)} className="h-5 w-5 accent-amber-400" />
          <span>{s.reviewFlaggedOnly}</span>
        </label>
        <label className="flex min-h-[44px] items-center gap-2">
          <input
            type="checkbox"
            data-review-suspects-first=""
            checked={suspectsFirst}
            onChange={(e) => setSuspectsFirst(e.target.checked)}
            className="h-5 w-5 accent-amber-400"
          />
          <span>{s.reviewSuspectsFirst}</span>
        </label>
        <span className="ml-auto text-xs text-amber-100/50">{fill(s.reviewCount, { count: turns.length, flagged: flaggedCount })}</span>
      </section>

      {/* ── Second opinion, the whole day ───────────────────────────────── */}
      <section className="flex flex-wrap items-center gap-3 text-sm">
        <button
          type="button"
          data-review-opinion-all=""
          disabled={checkingAll || !day || turns.length === 0}
          onClick={() => void checkAll()}
          className="min-h-[44px] rounded-2xl border border-amber-300/40 bg-amber-400/15 px-4 text-sm text-amber-100 transition hover:bg-amber-400/25 disabled:opacity-50"
        >
          {checkingAll ? s.reviewOpinionWorking : s.reviewOpinionAll}
        </button>
        <span className="text-xs text-amber-100/50">
          {!day ? s.reviewOpinionPickDay : fill(s.reviewOpinionAllHint, { max: batchMax })}
          {batchResult ? (
            <>
              {" · "}
              <span className="text-amber-100/80">{fill(s.reviewOpinionAllDone, { checked: batchResult.checked, failed: batchResult.failed })}</span>
              {batchResult.more ? ` ${s.reviewOpinionAllMore}` : ""}
            </>
          ) : null}
        </span>
      </section>

      {error ? <p className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-100">{error}</p> : null}

      {/* ── The turns ──────────────────────────────────────────────────── */}
      {loading ? (
        <p className="text-sm text-amber-100/50">{s.reviewLoading}</p>
      ) : turns.length === 0 ? (
        <p className="text-sm text-amber-100/50">{s.reviewNothing}</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {turns.map((turn) => {
            const when = new Date(turn.created_at);
            const note = notes[turn.id] ?? turn.flag_note ?? "";
            return (
              <li
                key={turn.id}
                data-review-turn={turn.id}
                className={`rounded-2xl border p-3 sm:p-4 ${
                  turn.flag_reason ? "border-rose-400/40 bg-rose-500/5" : "border-white/10 bg-white/[0.03]"
                }`}
              >
                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1.4fr)]">
                  {/* Column 1: who, when, the audio, the facts. */}
                  <div className="flex flex-col gap-2 text-xs text-amber-100/70">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-sm font-medium text-amber-100">{speakerLabel(turn.user_id)}</span>
                      <span>{when.toLocaleDateString()} {when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                      <span className="rounded-full border border-white/10 px-2 py-0.5">{turn.surface}{turn.mode === "auto" ? " · auto" : ""}</span>
                    </div>
                    {turn.audio_url ? (
                      <audio controls preload="none" src={turn.audio_url} className="w-full max-w-full" />
                    ) : (
                      <span className="text-amber-100/40">–</span>
                    )}
                    <div>
                      <span className="text-amber-100/50">{s.reviewModels}: </span>
                      {turn.transcribe_model ?? "?"} → {turn.translate_model ?? "?"}
                    </div>
                    <div>
                      <span className="text-amber-100/50">{s.reviewTiming}: </span>
                      {typeof turn.rec_ms === "number" ? `rec ${ms(turn.rec_ms)} · ` : ""}
                      stt {ms(turn.timings?.transcribe_ms)} · tr {ms(turn.timings?.translate_ms)}
                      {typeof turn.timings?.tts_ms === "number" ? ` · tts ${ms(turn.timings.tts_ms)}` : ""}
                      {typeof turn.timings?.total_ms === "number" ? ` · ${s.reviewTimingTotal} ${ms(turn.timings.total_ms)}` : ""}
                    </div>
                  </div>
                  {/* Column 2: what the transcriber heard. */}
                  <div className="flex flex-col gap-1">
                    <span className="text-xs text-amber-100/50">{s.reviewHeard} · {langLabel(turn.source_lang, mine)}</span>
                    <TranscriptWithDiff text={turn.original_text} opinion={turn.opinion} />
                  </div>
                  {/* Column 3: what the translator made of it. */}
                  <div className="flex flex-col gap-1">
                    <span className="text-xs text-amber-100/50">{s.reviewTranslated} · {langLabel(turn.target_lang, mine)}</span>
                    <p className="whitespace-pre-wrap text-base leading-snug text-amber-50">{turn.translation_text}</p>
                    <OpinionPanel opinion={turn.opinion} score={turn.opinion_score} s={s} />
                  </div>
                </div>

                {/* Redo · Rehacer: the same clip through the fallback transcriber,
                    kept beside the first result and marked. Both stay. */}
                <div className="mt-3 flex flex-col gap-2 border-t border-white/10 pt-3" data-review-redo={turn.id}>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      data-review-redo-button=""
                      disabled={redoing === turn.id}
                      onClick={() => void redo(turn)}
                      className="min-h-[44px] rounded-xl border border-sky-300/40 bg-sky-400/10 px-3 text-sm text-sky-100 transition hover:bg-sky-400/20 disabled:opacity-50"
                    >
                      {redoing === turn.id ? s.redoBusy : `↻ ${s.redo}`}
                    </button>
                    {turn.redo ? (
                      <span className="text-xs text-amber-100/50">
                        {s.redoFirst}: {turn.transcribe_model ?? "?"} · {s.redoSecond}: {turn.redo.model}
                        {turn.redo.language_hint ? ` (${langLabel(turn.redo.language_hint)})` : ""}
                        {typeof turn.redo.norm_gain_db === "number" ? ` · +${turn.redo.norm_gain_db} dB` : ""}
                        {" · "}stt {ms(turn.redo.timings?.transcribe_ms)} · tr {ms(turn.redo.timings?.translate_ms)}
                      </span>
                    ) : null}
                  </div>
                  {turn.redo ? (
                    <div className="grid gap-3 rounded-xl border border-sky-300/20 bg-sky-400/5 p-3 md:grid-cols-2">
                      <div className="flex flex-col gap-1">
                        <span className="text-xs text-sky-100/60">
                          {s.redoSecond} · {s.reviewHeard} · {langLabel(turn.redo.source_lang)}
                        </span>
                        <p className="whitespace-pre-wrap text-base leading-snug text-amber-50">{turn.redo.original_text || "–"}</p>
                      </div>
                      <div className="flex flex-col gap-1">
                        <span className="text-xs text-sky-100/60">
                          {s.redoSecond} · {s.reviewTranslated} · {langLabel(turn.redo.target_lang)}
                        </span>
                        <p className="whitespace-pre-wrap text-base leading-snug text-amber-50">{turn.redo.translation_text || "–"}</p>
                      </div>
                    </div>
                  ) : null}
                </div>

                {/* The flag: one tap saves it; the note is optional. */}
                <div className="mt-3 flex flex-col gap-2 border-t border-white/10 pt-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      data-review-opinion-one={turn.id}
                      disabled={opinionBusy === turn.id || checkingAll}
                      onClick={() => void secondOpinion(turn)}
                      className="min-h-[44px] rounded-xl border border-amber-300/30 bg-amber-400/10 px-3 text-sm text-amber-100 transition hover:bg-amber-400/20 disabled:opacity-50"
                    >
                      {opinionBusy === turn.id ? s.reviewOpinionWorking : turn.opinion_at ? s.reviewOpinionAgain : s.reviewOpinion}
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2" role="group" aria-label={s.reviewFlag}>
                    {FLAG_REASONS.map((reason) => {
                      const on = turn.flag_reason === reason;
                      return (
                        <button
                          key={reason}
                          type="button"
                          data-review-flag={reason}
                          aria-pressed={on}
                          disabled={busy === turn.id}
                          onClick={() => void flag(turn, on ? null : reason)}
                          className={`min-h-[44px] min-w-[44px] flex-1 rounded-xl border px-3 text-sm transition active:scale-[0.99] sm:flex-none ${
                            on
                              ? "border-rose-300/60 bg-rose-500/25 text-rose-50"
                              : "border-white/10 bg-white/5 text-amber-100/80 hover:bg-amber-400/10"
                          }`}
                        >
                          {reasonLabel[reason]}
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <input
                      type="text"
                      value={note}
                      maxLength={FLAG_NOTE_MAX}
                      placeholder={turn.flag_reason === "words" ? s.reviewFlagNoteWords : s.reviewFlagNote}
                      onChange={(e) => setNotes((n) => ({ ...n, [turn.id]: e.target.value }))}
                      className="min-h-[44px] min-w-0 flex-1 rounded-xl border border-white/10 bg-white/5 px-3 text-sm text-amber-50 placeholder:text-amber-100/30"
                    />
                    {turn.flag_reason ? (
                      <>
                        <button
                          type="button"
                          disabled={busy === turn.id}
                          onClick={() => void flag(turn, turn.flag_reason)}
                          className="min-h-[44px] rounded-xl border border-amber-300/40 bg-amber-400/15 px-3 text-sm text-amber-100"
                        >
                          {s.reviewFlagSave}
                        </button>
                        <button
                          type="button"
                          disabled={busy === turn.id}
                          onClick={() => void flag(turn, null)}
                          className="min-h-[44px] rounded-xl border border-white/10 bg-white/5 px-3 text-sm text-amber-100/70"
                        >
                          {s.reviewFlagClear}
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {/* ── Export ─────────────────────────────────────────────────────── */}
      <section className="mt-2 flex flex-col gap-1">
        <button
          type="button"
          disabled={exporting}
          onClick={() => void exportClips()}
          className="min-h-[44px] self-start rounded-2xl border border-white/10 bg-white/5 px-4 text-sm text-amber-100/80 transition hover:bg-amber-400/10 disabled:opacity-50"
        >
          {s.reviewExport}
        </button>
        <p className="text-xs text-amber-100/40">{s.reviewExportHint}</p>
        {mine === "es" ? <p className="text-xs text-amber-100/30">Textos en español pendientes de revisión por Liz.</p> : null}
      </section>
    </main>
  );
}
