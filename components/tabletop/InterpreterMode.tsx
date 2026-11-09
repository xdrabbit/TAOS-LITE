"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authHeaders, jsonAuthHeaders } from "@/lib/authClient";
import { copyFor, fill } from "@/lib/chrome/copy";
import { languageNative } from "@/lib/languages/catalog";
import { ensureTabletopAudioContext } from "@/lib/tabletop/audio";
import { keepWake } from "@/lib/wakeLock";
import {
  applyCaption,
  paneLines,
  paneStreamingText,
  settleCaptions,
  type CaptionEntry
} from "@/lib/interpreter/captions";
import {
  InterpreterNotConfiguredError,
  startInterpreter,
  type ActiveInterpreter,
  type BriefingReceipt
} from "@/lib/interpreter/client";
import { estimateUsd, formatUsd, summarizeTally, type InterpreterStop } from "@/lib/interpreter/cost";
import {
  ENGINE_LABEL,
  ENGINE_STORAGE_KEY,
  engineTakesBriefing,
  INTERPRETER_ENGINES,
  resolveEngine,
  type InterpreterEngine
} from "@/lib/interpreter/engine";
import { formatClock, sessionVerdict, type SessionClock } from "@/lib/interpreter/limits";
import {
  DEFAULT_INTERPRETER_STYLE,
  INTERPRETER_STYLES,
  resolveStyle,
  STYLE_STORAGE_KEY,
  type InterpreterStyle
} from "@/lib/interpreter/mediator";
import {
  DIAG_STORAGE_KEY,
  resolveDiagnostics,
  summarizeLegDigest,
  timelineFileName,
  type TimelineExport
} from "@/lib/interpreter/timeline";
import { ExitHome } from "../ExitHome";
import { JumpToTail, useFollowTail } from "../FollowTail";

// ── /tabletop Interpreter mode (Tom, 2026-11-09) ───────────────────────────
// "An AI sitting between them that interprets continuously — no record
// button, no timer, no awkward wait — and that knows their context."
//
// The table's geometry is kept: the phone lies flat, the TOP half is rotated
// for the person across the table, the BOTTOM half faces the phone's owner.
// What changes is that nobody takes turns. One tap starts a session; both
// people just talk; each pane fills with the captions of the conversation in
// ITS reader's language — the other person's words interpreted (large), and
// your own as they were heard (small) — oldest first, following the line
// being written (#101). The Stop button is in the middle strip, which never
// scrolls (#117): the page is 100dvh and only the two feeds move.
//
// Founders only, behind TAOS_INTERPRETER_ENABLED. The shell decides whether
// this component is ever mounted; every route it calls re-asks on the server.
//
// Nothing a person says is stored: the captions live in this component's
// state and are gone when it unmounts. What leaves the phone at the end of a
// session is one line of NUMBERS (lib/interpreter/cost.ts) — and, with the
// Diagnostics chip on, one more line of numbers per leg: what kinds of events
// the provider sent and when (lib/interpreter/timeline.ts). The full timeline
// stays on the phone until a founder taps "Save timeline"; it has event types,
// times and byte counts in it and no word or sound of anybody's.

type Phase = "idle" | "connecting" | "live" | "stopping";
type EndedNotice = { kind: "cap"; minutes: number } | { kind: "idle" } | { kind: "error" } | null;
type ContextStatus = "loading" | "ok" | "missing_table" | "unavailable";

export interface InterpreterModeProps {
  /** The phone owner's language (bottom pane) and the far side's (top pane). */
  mine: string;
  theirs: string;
  /** TAOS_INTERPRETER_ENGINE, read on the server. */
  defaultEngine: InterpreterEngine;
  /** TAOS_INTERPRETER_MEDIATOR_ENABLED, read on the server. Default false. */
  mediatorEnabled?: boolean;
  /** Back to the push-to-talk table. */
  onExit: () => void;
  /** Injected by the tests; the real one opens a microphone. */
  start?: typeof startInterpreter;
}

function Feed({
  entries,
  lang,
  rotated,
  live,
  mediatorLangs
}: {
  entries: readonly CaptionEntry[];
  lang: string;
  rotated: boolean;
  live: boolean;
  /** The table's languages while the session is a mediator; null otherwise. */
  mediatorLangs: readonly string[] | null;
}): JSX.Element {
  const t = copyFor(lang);
  const lines = useMemo(() => paneLines(entries, lang, { mediatorLangs }), [entries, lang, mediatorLangs]);
  const streaming = paneStreamingText(lines);
  const tail = useFollowTail(streaming.on, streaming.text);

  return (
    <section
      data-interpreter-pane={rotated ? "far" : "near"}
      // Same insets as the table's panes: each end pads for the screen edge
      // it is actually drawn against.
      className={`flex flex-1 flex-col gap-2 overflow-hidden p-4 ${
        rotated
          ? "rotate-180 pb-[calc(1rem+env(safe-area-inset-top))]"
          : "pb-[calc(1rem+env(safe-area-inset-bottom))]"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs uppercase tracking-[0.25em] text-amber-100/50">
          {languageNative(lang)}
        </span>
        {live ? (
          <span className="flex items-center gap-2 text-xs text-emerald-300/80">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
            {t.interpreterListening}
          </span>
        ) : null}
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={tail.ref}
          data-interpreter-feed=""
          className="flex-1 overflow-y-auto [overflow-anchor:none]"
        >
          {lines.length === 0 ? (
            <div className="flex h-full items-center justify-center text-center text-sm text-amber-100/30">
              {t.interpreterHint}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {lines.map((line) =>
                line.kind === "incoming" ? (
                  <div key={line.id} data-caption="incoming" className="text-2xl font-medium leading-snug text-amber-50">
                    {line.text}
                    {line.live ? <span className="animate-pulse text-emerald-300">▍</span> : null}
                  </div>
                ) : line.kind === "outgoing" ? (
                  <div key={line.id} data-caption="outgoing" className="border-l-2 border-white/10 pl-2 text-sm text-amber-100/50">
                    {line.text}
                  </div>
                ) : line.kind === "note" ? (
                  // The mediator speaking for ITSELF — boxed, labelled and in
                  // another colour, so it can never be read as something the
                  // other person said.
                  <div
                    key={line.id}
                    data-caption="note"
                    className="rounded-xl border border-sky-300/40 bg-sky-400/10 px-3 py-2 text-base italic leading-snug text-sky-100"
                  >
                    <span className="mb-0.5 block text-[10px] font-semibold uppercase not-italic tracking-widest text-sky-300/80">
                      {t.interpreterMediatorNote}
                    </span>
                    {line.text}
                    {line.live ? <span className="animate-pulse text-sky-300">▍</span> : null}
                  </div>
                ) : (
                  <div key={line.id} data-caption="both">
                    {line.heard ? <div className="text-sm text-amber-100/50">{line.heard}</div> : null}
                    <div className="text-2xl font-medium leading-snug text-amber-50">
                      {line.said}
                      {line.live ? <span className="animate-pulse text-emerald-300">▍</span> : null}
                    </div>
                  </div>
                )
              )}
            </div>
          )}
        </div>
        <JumpToTail show={tail.detached} onJump={tail.jumpToTail} />
      </div>
    </section>
  );
}

export function InterpreterMode({
  mine,
  theirs,
  defaultEngine,
  mediatorEnabled = false,
  onExit,
  start = startInterpreter
}: InterpreterModeProps): JSX.Element {
  const t = copyFor(mine);
  const [engine, setEngine] = useState<InterpreterEngine>(defaultEngine);
  // Interpreter unless this device has explicitly chosen the experiment.
  const [style, setStyle] = useState<InterpreterStyle>(DEFAULT_INTERPRETER_STYLE);
  /** The style the RUNNING (or last) session was actually briefed in. */
  const [sessionStyle, setSessionStyle] = useState<InterpreterStyle>(DEFAULT_INTERPRETER_STYLE);
  const [phase, setPhase] = useState<Phase>("idle");
  const [entries, setEntries] = useState<CaptionEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState<EndedNotice>(null);
  const [elapsed, setElapsed] = useState(0);
  const [usd, setUsd] = useState(0);
  const [receipt, setReceipt] = useState<BriefingReceipt | null>(null);
  const [maxSeconds, setMaxSeconds] = useState(0);
  // The context editor.
  const [contextOpen, setContextOpen] = useState(false);
  const [contextText, setContextText] = useState("");
  const [contextStatus, setContextStatus] = useState<ContextStatus>("loading");
  const [contextMax, setContextMax] = useState(4000);
  const [contextNote, setContextNote] = useState<"saved" | "failed" | "saving" | null>(null);
  // Diagnostics: on unless this device turned it off (resolveDiagnostics).
  const [diag, setDiag] = useState(true);
  const [lastTimeline, setLastTimeline] = useState<TimelineExport | null>(null);

  const activeRef = useRef<ActiveInterpreter | null>(null);
  const clockRef = useRef<SessionClock | null>(null);
  const endingRef = useRef(false);

  // The device's stored choice wins over the deployment default — that is
  // what lets two founders A/B at the table without a redeploy.
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(ENGINE_STORAGE_KEY);
    } catch {
      /* private mode */
    }
    setEngine(resolveEngine({ stored, envDefault: defaultEngine }));
    if (mediatorEnabled) {
      let storedStyle: string | null = null;
      try {
        storedStyle = window.localStorage.getItem(STYLE_STORAGE_KEY);
      } catch {
        /* private mode */
      }
      setStyle(resolveStyle(storedStyle));
    } else {
      setStyle(DEFAULT_INTERPRETER_STYLE);
    }
    let storedDiag: string | null = null;
    let queryDiag: string | null = null;
    try {
      storedDiag = window.localStorage.getItem(DIAG_STORAGE_KEY);
      queryDiag = new URLSearchParams(window.location.search).get("diag");
      if (queryDiag === "0" || queryDiag === "1") window.localStorage.setItem(DIAG_STORAGE_KEY, queryDiag);
    } catch {
      /* private mode */
    }
    setDiag(resolveDiagnostics({ stored: storedDiag, query: queryDiag }));
  }, [defaultEngine, mediatorEnabled]);

  const toggleDiag = useCallback(() => {
    setDiag((on) => {
      try {
        window.localStorage.setItem(DIAG_STORAGE_KEY, on ? "0" : "1");
      } catch {
        /* the choice still holds for this visit */
      }
      return !on;
    });
  }, []);

  /** Hand the last session's timeline to the founder: share sheet, else a file. */
  const saveTimeline = useCallback(async () => {
    if (!lastTimeline) return;
    const name = timelineFileName(lastTimeline);
    const json = JSON.stringify(lastTimeline);
    try {
      const file = new File([json], name, { type: "application/json" });
      if (typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: name });
        return;
      }
    } catch {
      /* cancelled, or no share sheet: fall through to a download */
    }
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }, [lastTimeline]);

  const chooseStyle = useCallback((next: InterpreterStyle) => {
    setStyle(next);
    try {
      window.localStorage.setItem(STYLE_STORAGE_KEY, next);
    } catch {
      /* the choice still holds for this visit */
    }
  }, []);

  const chooseEngine = useCallback((next: InterpreterEngine) => {
    setEngine(next);
    try {
      window.localStorage.setItem(ENGINE_STORAGE_KEY, next);
    } catch {
      /* the choice still holds for this visit */
    }
  }, []);

  /**
   * One line of numbers to the Vercel log — and, with diagnostics on, one
   * more per leg (the timeline's digest). Never text. Returns the timeline.
   */
  const postUsage = useCallback((active: ActiveInterpreter, stop: InterpreterStop): TimelineExport | null => {
    const summary = summarizeTally(active.tally(), Date.now(), stop);
    const timeline = active.timeline();
    const body = timeline ? { ...summary, diag: timeline.digest.map(summarizeLegDigest) } : summary;
    if (timeline) {
      // The same thing "Save timeline" hands over, for a phone on a cable.
      console.info("[taos-interpreter-timeline]", JSON.stringify(timeline));
    }
    void jsonAuthHeaders()
      .then((headers) =>
        fetch("/api/tabletop/interpreter/usage", {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          keepalive: true
        })
      )
      .catch(() => {
        /* the session is over either way */
      });
    return timeline;
  }, []);

  const end = useCallback(
    async (stop: InterpreterStop) => {
      const active = activeRef.current;
      if (!active || endingRef.current) return;
      endingRef.current = true;
      setPhase("stopping");
      const cap = clockRef.current?.maxSeconds ?? 0;
      clockRef.current = null;
      try {
        await active.stop();
      } finally {
        setLastTimeline(postUsage(active, stop));
        setUsd(estimateUsd(active.tally()));
        activeRef.current = null;
        endingRef.current = false;
        setEntries((prev) => settleCaptions(prev));
        setEnded(
          stop === "cap"
            ? { kind: "cap", minutes: Math.round(cap / 60) }
            : stop === "idle"
              ? { kind: "idle" }
              : stop === "error"
                ? { kind: "error" }
                : null
        );
        setPhase("idle");
      }
    },
    [postUsage]
  );

  const begin = useCallback(async () => {
    if (activeRef.current || phase !== "idle") return;
    // Born in this tap: iOS will not start an AudioContext anywhere else, and
    // the Gemini engine plays through one (lib/tabletop/audio.ts).
    ensureTabletopAudioContext();
    setError(null);
    setEnded(null);
    setEntries([]);
    setElapsed(0);
    setUsd(0);
    setReceipt(null);
    setLastTimeline(null);
    setPhase("connecting");
    try {
      const active = await start({
        engine,
        mine,
        theirs,
        style: mediatorEnabled ? style : DEFAULT_INTERPRETER_STYLE,
        diagnostics: diag,
        handlers: {
          onCaption: (update) => setEntries((prev) => applyCaption(prev, update)),
          onActivity: () => {
            if (clockRef.current) clockRef.current.lastActivityMs = Date.now();
          },
          onTally: (tally) => setUsd(estimateUsd(tally)),
          onError: (message) => setError(message),
          onLegLost: () => void end("error")
        }
      });
      activeRef.current = active;
      const now = Date.now();
      clockRef.current = {
        startedAtMs: now,
        lastActivityMs: now,
        maxSeconds: active.maxSeconds,
        idleSeconds: active.idleSeconds
      };
      setMaxSeconds(active.maxSeconds);
      setReceipt(active.briefing);
      setSessionStyle(active.style);
      setPhase("live");
    } catch (e) {
      activeRef.current = null;
      clockRef.current = null;
      setError(
        // A key that is not on the server: say WHICH variable, in the
        // reader's language — it is the one thing Tom has to go and add.
        e instanceof InterpreterNotConfiguredError
          ? fill(t.interpreterEngineNoKey, { name: e.missingEnv })
          : e instanceof Error
            ? e.message
            : t.interpreterEndedError
      );
      setPhase("idle");
    }
  }, [engine, mine, theirs, style, mediatorEnabled, diag, phase, start, end, t.interpreterEndedError, t.interpreterEngineNoKey]);

  // The session clock: the cap and the idle stop, once a second.
  useEffect(() => {
    if (phase !== "live") return;
    const timer = window.setInterval(() => {
      const clock = clockRef.current;
      if (!clock) return;
      const now = Date.now();
      setElapsed(Math.floor((now - clock.startedAtMs) / 1000));
      // The per-minute engines bill the clock, not events — so the meter is
      // re-read on the clock too.
      const active = activeRef.current;
      if (active) setUsd(estimateUsd(active.tally()));
      const verdict = sessionVerdict(clock, now);
      if (verdict !== "run") void end(verdict);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [phase, end]);

  // Awake for as long as it is listening, and not a second longer.
  useEffect(() => {
    if (phase !== "live") return;
    return keepWake("tabletop-interpreter");
  }, [phase]);

  // Leaving the screen ends the session — a hands-free mic must never
  // outlive the page that shows it is on.
  useEffect(() => {
    const leave = () => {
      const active = activeRef.current;
      if (!active) return;
      activeRef.current = null;
      clockRef.current = null;
      postUsage(active, "left");
      void active.stop();
    };
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [postUsage]);

  const exit = useCallback(() => {
    if (activeRef.current) void end("user").then(onExit);
    else onExit();
  }, [end, onExit]);

  // ── The context editor ────────────────────────────────────────────────────
  const openContext = useCallback(async () => {
    setContextOpen(true);
    setContextNote(null);
    setContextStatus("loading");
    try {
      const res = await fetch("/api/tabletop/interpreter/context", { headers: await authHeaders() });
      const body = (await res.json().catch(() => ({}))) as {
        context?: string;
        status?: ContextStatus;
        maxChars?: number;
      };
      if (!res.ok) throw new Error("load");
      setContextText(typeof body.context === "string" ? body.context : "");
      setContextStatus(body.status ?? "ok");
      if (typeof body.maxChars === "number" && body.maxChars > 0) setContextMax(body.maxChars);
    } catch {
      setContextStatus("unavailable");
    }
  }, []);

  const saveContext = useCallback(async () => {
    setContextNote("saving");
    try {
      const res = await fetch("/api/tabletop/interpreter/context", {
        method: "PUT",
        headers: await jsonAuthHeaders(),
        body: JSON.stringify({ context: contextText })
      });
      const body = (await res.json().catch(() => ({}))) as { context?: string; status?: ContextStatus };
      if (!res.ok) {
        if (body.status === "missing_table") setContextStatus("missing_table");
        setContextNote("failed");
        return;
      }
      if (typeof body.context === "string") setContextText(body.context);
      setContextStatus("ok");
      setContextNote("saved");
    } catch {
      setContextNote("failed");
    }
  }, [contextText]);

  const live = phase === "live";
  const busy = phase === "connecting" || phase === "stopping";
  const briefable = receipt ? receipt.applied : engineTakesBriefing(engine);
  // Notes are looked for only while the session on screen IS a mediator's.
  const mediatorLangs = useMemo(
    () => (sessionStyle === "mediator" ? [mine, theirs] : null),
    [sessionStyle, mine, theirs]
  );
  const mediatorChosen = mediatorEnabled && style === "mediator" && engineTakesBriefing(engine);
  const notice =
    ended?.kind === "cap"
      ? fill(t.interpreterEndedCap, { minutes: ended.minutes })
      : ended?.kind === "idle"
        ? t.interpreterEndedIdle
        : ended?.kind === "error"
          ? t.interpreterEndedError
          : null;

  return (
    <main data-interpreter="" className="flex h-[100dvh] flex-col overflow-hidden">
      <Feed entries={entries} lang={theirs} rotated live={live} mediatorLangs={mediatorLangs} />

      {/* The middle strip: never scrolls, so Stop is always under a thumb.
          Readable from the bottom end, like the table's own. */}
      <div
        data-interpreter-controls=""
        className="flex flex-col gap-2 border-y border-white/10 bg-white/5 px-3 py-2"
      >
        <div className="flex flex-wrap items-center justify-center gap-2">
          <ExitHome lang={mine} />
          <button
            type="button"
            data-interpreter-back=""
            onClick={exit}
            disabled={busy}
            className="min-h-[44px] rounded-full border border-white/10 bg-white/5 px-3 text-xs text-amber-100/70 disabled:opacity-40"
          >
            {t.interpreterBackToTable}
          </button>
          <span data-interpreter-status="" className="font-mono text-xs text-amber-100/60">
            {ENGINE_LABEL[engine]}
            {(live ? sessionStyle === "mediator" : mediatorChosen) ? ` · ${t.interpreterStyleMediator}` : ""}
            {live || elapsed > 0 ? ` · ${formatClock(elapsed)}${maxSeconds ? ` / ${formatClock(maxSeconds)}` : ""}` : ""}
            {usd > 0 ? ` · ${formatUsd(usd)}` : ""}
          </span>
        </div>

        <button
          type="button"
          data-interpreter-toggle=""
          aria-pressed={live}
          onClick={() => (live ? void end("user") : void begin())}
          disabled={busy}
          className={`select-none rounded-2xl px-4 py-5 text-xl font-bold tracking-wide transition disabled:opacity-60 ${
            live ? "bg-red-500 text-stone-50" : busy ? "bg-white/10 text-amber-100/60" : "bg-emerald-400 text-stone-950"
          }`}
        >
          {live ? `■ ${t.interpreterStop}` : busy ? t.connecting : `◉ ${t.interpreterStart}`}
        </button>

        {!live && !busy ? (
          <div className="flex flex-wrap items-center justify-center gap-2">
            <span className="text-[10px] uppercase tracking-widest text-amber-100/40">
              {t.interpreterEngine}
            </span>
            {INTERPRETER_ENGINES.map((e) => (
              <button
                key={e}
                type="button"
                data-interpreter-engine={e}
                onClick={() => chooseEngine(e)}
                aria-pressed={engine === e}
                className={`rounded-full px-3 py-1 text-xs ${
                  engine === e
                    ? "bg-emerald-400 text-stone-950"
                    : "border border-white/10 bg-white/5 text-amber-100/70"
                }`}
              >
                {ENGINE_LABEL[e]}
              </button>
            ))}
            <button
              type="button"
              data-interpreter-context-open=""
              onClick={() => void openContext()}
              className="rounded-full border border-amber-300/30 bg-white/5 px-3 py-1 text-xs text-amber-100/80"
            >
              ✎ {t.interpreterContext}
            </button>
            <button
              type="button"
              data-interpreter-diag=""
              onClick={toggleDiag}
              aria-pressed={diag}
              title={t.interpreterDiagHint}
              className={`rounded-full px-3 py-1 text-xs ${
                diag ? "bg-sky-300 text-stone-950" : "border border-white/10 bg-white/5 text-amber-100/70"
              }`}
            >
              {t.interpreterDiag}
            </button>
            {lastTimeline ? (
              <button
                type="button"
                data-interpreter-diag-save=""
                onClick={() => void saveTimeline()}
                title={t.interpreterDiagHint}
                className="rounded-full border border-sky-300/40 bg-white/5 px-3 py-1 text-xs text-sky-100"
              >
                ⬇ {t.interpreterDiagSave}
              </button>
            ) : null}
          </div>
        ) : null}

        {!briefable ? (
          <div data-interpreter-unbriefed="" className="text-center text-[11px] leading-tight text-amber-200/70">
            {t.interpreterContextNotUsed}
          </div>
        ) : null}
        {notice ? (
          <div data-interpreter-notice="" className="text-center text-xs text-amber-100/70">
            {notice}
          </div>
        ) : null}
        {error ? (
          <div data-interpreter-error="" className="text-center text-xs text-red-300">
            {error}
          </div>
        ) : null}
      </div>

      <Feed entries={entries} lang={mine} rotated={false} live={live} mediatorLangs={mediatorLangs} />

      {contextOpen ? (
        <div
          data-interpreter-context=""
          className="fixed inset-0 z-50 flex flex-col gap-3 bg-stone-950/95 p-4 pt-[calc(1rem+env(safe-area-inset-top))] pb-[calc(1rem+env(safe-area-inset-bottom))]"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-amber-50">{t.interpreterContext}</h2>
            <button
              type="button"
              onClick={() => setContextOpen(false)}
              className="min-h-[44px] rounded-full border border-white/10 bg-white/5 px-4 text-sm text-amber-100/80"
            >
              {t.close}
            </button>
          </div>
          {/* The STYLE of the session, on the briefing screen (Tom, 2026-11-09).
              Interpreter is the default and what every device starts on; the
              mediator is an experiment a founder turns on for their phone. */}
          {mediatorEnabled ? (
          <div data-interpreter-style="" className="flex flex-col gap-1.5 rounded-xl border border-white/10 bg-white/5 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] uppercase tracking-widest text-amber-100/40">{t.interpreterStyle}</span>
              {INTERPRETER_STYLES.map((s) => (
                <button
                  key={s}
                  type="button"
                  data-interpreter-style-option={s}
                  onClick={() => chooseStyle(s)}
                  aria-pressed={style === s}
                  className={`min-h-[36px] rounded-full px-3 text-xs ${
                    style === s
                      ? s === "mediator"
                        ? "bg-sky-300 text-stone-950"
                        : "bg-emerald-400 text-stone-950"
                      : "border border-white/10 bg-white/5 text-amber-100/70"
                  }`}
                >
                  {s === "mediator" ? t.interpreterStyleMediator : t.interpreterStyleInterpreter}
                </button>
              ))}
            </div>
            <p className="text-[11px] leading-snug text-amber-100/60">
              {style === "mediator" ? t.interpreterStyleMediatorHint : t.interpreterStyleInterpreterHint}
            </p>
            {style === "mediator" && !engineTakesBriefing(engine) ? (
              <p data-interpreter-style-unavailable="" className="text-[11px] leading-snug text-amber-200/80">
                {t.interpreterStyleNotOnEngine}
              </p>
            ) : null}
          </div>
          ) : null}
          <p className="text-xs leading-snug text-amber-100/60">{t.interpreterContextHint}</p>
          {contextStatus === "missing_table" ? (
            <p data-interpreter-context-missing="" className="text-xs text-amber-200/80">
              {t.interpreterContextMissing}
            </p>
          ) : null}
          <textarea
            value={contextText}
            onChange={(e) => {
              setContextText(e.target.value.slice(0, contextMax));
              setContextNote(null);
            }}
            disabled={contextStatus === "loading"}
            maxLength={contextMax}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none rounded-xl border border-white/10 bg-black/40 p-3 text-sm leading-relaxed text-amber-50 outline-none focus:border-emerald-300/50"
          />
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-[11px] text-amber-100/40">
              {contextText.length} / {contextMax}
            </span>
            <span className="text-xs text-amber-100/70">
              {contextNote === "saved"
                ? t.interpreterContextSaved
                : contextNote === "failed"
                  ? t.interpreterContextSaveFailed
                  : ""}
            </span>
            <button
              type="button"
              data-interpreter-context-save=""
              onClick={() => void saveContext()}
              disabled={contextStatus === "loading" || contextNote === "saving"}
              className="min-h-[44px] rounded-full bg-emerald-400 px-6 text-sm font-semibold text-stone-950 disabled:opacity-50"
            >
              {t.interpreterContextSave}
            </button>
          </div>
        </div>
      ) : null}
    </main>
  );
}
