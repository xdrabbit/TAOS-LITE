"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authHeaders, jsonAuthHeaders } from "@/lib/authClient";
import { copyFor, fill } from "@/lib/chrome/copy";
import {
  DEFAULT_DICTATE_MODE,
  DEFAULT_DICTATE_STYLE,
  DICTATE_MAX_RECORDING_MS,
  DICTATE_MAX_TEXT_CHARS,
  DICTATE_SAME_LANGUAGE,
  DICTATE_STYLES,
  readStoredDictateMode,
  readStoredDictateStyle,
  readStoredDictateTarget,
  storeDictateMode,
  storeDictateStyle,
  storeDictateTarget,
  type DictateMode,
  type DictateStyle
} from "@/lib/dictate/style";
import {
  isLanguageCode,
  languageLabel,
  languageLabelEs,
  SHEET_LANGUAGES
} from "@/lib/languages/catalog";
import { fetchWithRetry, isConnectionError } from "@/lib/net";
import {
  AUDIO_BITS_PER_SECOND,
  fileNameFor,
  MIN_TURN_DURATION_MS,
  pickMimeType
} from "@/lib/translate/recorder";
import { useLanguagePair } from "@/lib/translate/useLanguagePair";
import { keepWake } from "@/lib/wakeLock";
import { ExitHome } from "./ExitHome";

// /dictate — founders only (lib/release.ts, dictateVisibleTo).
//
// Two things on one screen, both ending in text you copy or share:
//
//   Speak    tap, talk, tap. The recording is transcribed and written up in
//            one of four styles, in the language you spoke or another one.
//            Tapping a different style afterwards re-writes the SAME words —
//            a JSON request with no second transcription.
//   Decoder  paste a message that arrived fast and unpunctuated. It comes
//            back punctuated in its own language and translated into yours,
//            with a short note wherever the original is genuinely unclear.
//
// Built for one thumb on a phone: Liz uses this from her home screen. The mic
// is the home screen's recorder in its simplest form — one MediaRecorder, one
// recording per dictation, tap-to-toggle, and the two iOS interruption
// handlers (lib/translate/recorder.ts). Not home's chunked recorder.
//
// Nothing is stored and nothing is metered while this is founders-only. The
// style, the output language and the mode are remembered per device
// (lib/dictate/style.ts).
//
// The chrome follows the phone's owner (`mine`), like every other screen.

type Phase = "idle" | "starting" | "recording" | "working";

interface DictateResult {
  raw: string;
  styled: string;
}

interface DecodeResult {
  cleaned: string;
  translation: string;
  notes: string[];
}

// The audio request can legitimately take a transcription plus a completion;
// the JSON ones are a single completion. One retry: every attempt is paid for.
const AUDIO_REQUEST_TIMEOUT_MS = 115000;
const TEXT_REQUEST_TIMEOUT_MS = 60000;

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function DictateShell(): JSX.Element {
  const { mine, theirs } = useLanguagePair();
  const c = copyFor(mine);
  const nameOf = useCallback(
    (code: string) => (mine === "es" ? languageLabelEs(code) : languageLabel(code)),
    [mine]
  );

  const [mode, setMode] = useState<DictateMode>(DEFAULT_DICTATE_MODE);
  const [style, setStyle] = useState<DictateStyle>(DEFAULT_DICTATE_STYLE);
  const [target, setTarget] = useState<string>(DICTATE_SAME_LANGUAGE);
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DictateResult | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [restyling, setRestyling] = useState(false);
  const [pasted, setPasted] = useState("");
  const [decoding, setDecoding] = useState(false);
  const [decoded, setDecoded] = useState<DecodeResult | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const phaseRef = useRef<Phase>("idle");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const capTimerRef = useRef<number | null>(null);
  const tickRef = useRef<number | null>(null);
  const wakeStopRef = useRef<(() => void) | null>(null);
  // Every request takes a number; only the newest one may write to the
  // screen. A slow Formal must not land on top of the Casual tapped after it.
  const requestRef = useRef(0);
  const resultRef = useRef<HTMLDivElement | null>(null);

  const go = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  // The last choices made on this phone. Read in an effect, not at render:
  // the server render has no storage, and a mismatch would be a hydration
  // error on the first paint.
  useEffect(() => {
    setMode(readStoredDictateMode());
    setStyle(readStoredDictateStyle());
    const stored = readStoredDictateTarget();
    setTarget(isLanguageCode(stored) ? stored : DICTATE_SAME_LANGUAGE);
  }, []);

  const clearTimers = useCallback(() => {
    if (capTimerRef.current !== null) window.clearTimeout(capTimerRef.current);
    if (tickRef.current !== null) window.clearInterval(tickRef.current);
    capTimerRef.current = null;
    tickRef.current = null;
  }, []);

  const releaseMic = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    wakeStopRef.current?.();
    wakeStopRef.current = null;
  }, []);

  // Leaving the screen mid-recording must not leave the mic open.
  useEffect(
    () => () => {
      clearTimers();
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        recorder.stop();
      }
      releaseMic();
    },
    [clearTimers, releaseMic]
  );

  const flashCopied = useCallback((which: string) => {
    setCopied(which);
    window.setTimeout(() => setCopied((current) => (current === which ? null : current)), 2000);
  }, []);

  // Copy runs inside the tap that asked for it. iOS Safari refuses a
  // clipboard write that is not part of a gesture, so nothing here copies on
  // its own when a result arrives.
  const copyText = useCallback(
    async (which: string, text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        flashCopied(which);
      } catch {
        // Clipboard blocked — the text is on screen to select by hand.
      }
    },
    [flashCopied]
  );

  const shareText = useCallback(async (text: string) => {
    try {
      await navigator.share({ text });
    } catch {
      // A cancelled share sheet is not an error worth surfacing.
    }
  }, []);

  const messageFor = useCallback(
    (e: unknown): string =>
      isConnectionError(e) ? c.connectionLost : e instanceof Error && e.message ? e.message : c.dictateFailed,
    [c]
  );

  /** Read a response, or throw the route's own words for the banner. */
  async function readJson(res: Response): Promise<Record<string, unknown>> {
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(typeof payload.error === "string" ? payload.error : "");
    }
    return payload;
  }

  const showResult = useCallback(() => {
    // Optional call: jsdom has no scrollIntoView.
    window.setTimeout(() => resultRef.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" }), 50);
  }, []);

  // ── Speak ────────────────────────────────────────────────────────────────

  async function sendRecording(blob: Blob, mime: string) {
    const request = ++requestRef.current;
    try {
      const form = new FormData();
      form.append("audio", new File([blob], fileNameFor(mime), { type: mime || "audio/webm" }));
      form.append("style", style);
      form.append("source", mine);
      form.append("target", target);
      const res = await fetchWithRetry(
        "/api/dictate",
        { method: "POST", headers: await authHeaders(), body: form },
        { retries: 1, timeoutMs: AUDIO_REQUEST_TIMEOUT_MS }
      );
      const payload = await readJson(res);
      if (request !== requestRef.current) return;
      const styled = typeof payload.styled === "string" ? payload.styled : "";
      if (!styled) throw new Error("");
      setResult({ raw: typeof payload.raw === "string" ? payload.raw : "", styled });
      setShowRaw(false);
      showResult();
    } catch (e) {
      if (request === requestRef.current) setError(messageFor(e));
    } finally {
      if (request === requestRef.current) go("idle");
    }
  }

  function stopRecording() {
    clearTimers();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      go("working");
      recorder.stop();
    }
  }

  async function startRecording() {
    // Set before the await: two quick taps must not open two microphones.
    if (phaseRef.current !== "idle") return;
    go("starting");
    setError(null);
    setCopied(null);

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      go("idle");
      setError(c.micUnavailable);
      return;
    }
    // Inside the tap, which is the best moment to ask for the wake lock.
    wakeStopRef.current = keepWake("dictate-mic");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = pickMimeType();
      const recorder = new MediaRecorder(stream, {
        ...(mime ? { mimeType: mime } : {}),
        audioBitsPerSecond: AUDIO_BITS_PER_SECOND
      });
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const heldMs = performance.now() - startedAtRef.current;
        const type = recorder.mimeType || mime;
        const blob = new Blob(chunksRef.current, { type: type || "audio/webm" });
        chunksRef.current = [];
        recorderRef.current = null;
        releaseMic();
        if (heldMs < MIN_TURN_DURATION_MS) {
          go("idle");
          setError(c.tooShort);
          return;
        }
        if (blob.size === 0) {
          go("idle");
          setError(c.noAudio);
          return;
        }
        void sendRecording(blob, type);
      };
      // iOS Safari ends the mic track SILENTLY when the audio session is
      // interrupted (a call, Siri, another app). Both handlers go through the
      // normal stop, so what was said before the interruption is still
      // written up (components/TranslatorShell.tsx keeps the same pair).
      recorder.onerror = () => stopRecording();
      for (const track of stream.getAudioTracks()) {
        track.onended = () => stopRecording();
      }
      // A flush every second, so a long dictation is never one fragile buffer.
      recorder.start(1000);
      recorderRef.current = recorder;
      startedAtRef.current = performance.now();
      setElapsedMs(0);
      go("recording");
      capTimerRef.current = window.setTimeout(stopRecording, DICTATE_MAX_RECORDING_MS);
      tickRef.current = window.setInterval(
        () => setElapsedMs(performance.now() - startedAtRef.current),
        500
      );
    } catch {
      releaseMic();
      go("idle");
      setError(c.micDenied);
    }
  }

  function toggleRecord() {
    if (phaseRef.current === "recording") stopRecording();
    else if (phaseRef.current === "idle") void startRecording();
  }

  /** The same words, written again. No audio, so no transcription. */
  async function restyle(nextStyle: DictateStyle, nextTarget: string) {
    if (!result?.raw) return;
    const request = ++requestRef.current;
    setRestyling(true);
    setError(null);
    setCopied(null);
    try {
      const res = await fetchWithRetry(
        "/api/dictate",
        {
          method: "POST",
          headers: await jsonAuthHeaders(),
          body: JSON.stringify({ raw: result.raw, style: nextStyle, source: mine, target: nextTarget })
        },
        { retries: 1, timeoutMs: TEXT_REQUEST_TIMEOUT_MS }
      );
      const payload = await readJson(res);
      if (request !== requestRef.current) return;
      const styled = typeof payload.styled === "string" ? payload.styled : "";
      if (!styled) throw new Error("");
      setResult({ raw: result.raw, styled });
    } catch (e) {
      if (request === requestRef.current) setError(messageFor(e));
    } finally {
      if (request === requestRef.current) setRestyling(false);
    }
  }

  function chooseStyle(next: DictateStyle) {
    if (next === style) return;
    setStyle(next);
    storeDictateStyle(next);
    if (result && phaseRef.current === "idle") void restyle(next, target);
  }

  function chooseTarget(next: string) {
    setTarget(next);
    storeDictateTarget(next);
    if (result && phaseRef.current === "idle") void restyle(style, next);
  }

  function chooseMode(next: DictateMode) {
    if (next === mode || phaseRef.current !== "idle") return;
    setMode(next);
    storeDictateMode(next);
    setError(null);
  }

  // ── Decoder ──────────────────────────────────────────────────────────────

  async function pasteFromClipboard() {
    setError(null);
    try {
      // Absent on some browsers, refused on others (Firefox, an iOS user who
      // taps "Don't Allow"). Either way the box still takes a manual paste.
      const text = await navigator.clipboard.readText();
      if (text) {
        setPasted(text.slice(0, DICTATE_MAX_TEXT_CHARS));
        setDecoded(null);
      }
    } catch {
      setError(c.dictatePasteBlocked);
    }
  }

  async function decode() {
    const raw = pasted.trim();
    if (!raw || decoding) return;
    if (raw.length > DICTATE_MAX_TEXT_CHARS) {
      setError(c.dictateTooLong);
      return;
    }
    const request = ++requestRef.current;
    setDecoding(true);
    setError(null);
    setCopied(null);
    try {
      const res = await fetchWithRetry(
        "/api/dictate",
        {
          method: "POST",
          headers: await jsonAuthHeaders(),
          body: JSON.stringify({ mode: "decode", raw, reader: mine, other: theirs })
        },
        { retries: 1, timeoutMs: TEXT_REQUEST_TIMEOUT_MS }
      );
      const payload = await readJson(res);
      if (request !== requestRef.current) return;
      const cleaned = typeof payload.cleaned === "string" ? payload.cleaned : "";
      const translation = typeof payload.translation === "string" ? payload.translation : "";
      if (!cleaned || !translation) throw new Error("");
      setDecoded({
        cleaned,
        translation,
        notes: Array.isArray(payload.notes)
          ? payload.notes.filter((note): note is string => typeof note === "string")
          : []
      });
      showResult();
    } catch (e) {
      if (request === requestRef.current) setError(messageFor(e));
    } finally {
      if (request === requestRef.current) setDecoding(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  const recording = phase === "recording";
  const busy = phase === "starting" || phase === "working";
  const styleLabel: Record<DictateStyle, string> = {
    // "Formal" is the same word in English and Spanish (lib/chrome/copy.ts).
    formal: "Formal",
    professional: c.dictateStyleProfessional,
    conversational: c.dictateStyleConversational,
    casual: c.dictateStyleCasual
  };

  const actions = (which: string, text: string) => (
    <div className={`grid gap-2 ${canShare ? "grid-cols-2" : "grid-cols-1"}`}>
      <button
        type="button"
        data-dictate-copy={which}
        onClick={() => void copyText(which, text)}
        className="min-h-[56px] rounded-2xl bg-amber-400 px-4 text-base font-semibold text-stone-950 transition active:scale-[0.99]"
      >
        {copied === which ? c.dictateCopied : c.dictateCopy}
      </button>
      {canShare ? (
        <button
          type="button"
          data-dictate-share={which}
          onClick={() => void shareText(text)}
          className="min-h-[56px] rounded-2xl border border-amber-300/40 bg-amber-400/10 px-4 text-base font-semibold text-amber-200 transition active:scale-[0.99]"
        >
          ↗ {c.dictateShare}
        </button>
      ) : null}
    </div>
  );

  return (
    <main className="min-h-screen px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-[calc(env(safe-area-inset-top)+1rem)]">
      <div className="mx-auto flex max-w-md flex-col gap-4">
        <header className="flex items-center gap-3">
          <ExitHome lang={mine} />
          <h1 className="text-lg font-semibold tracking-tight text-amber-200">{c.dictateTitle}</h1>
        </header>

        <div role="tablist" className="grid grid-cols-2 gap-1 rounded-2xl border border-white/10 bg-white/5 p-1">
          {(["speak", "decode"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              data-dictate-mode={value}
              aria-selected={mode === value}
              disabled={phase !== "idle"}
              onClick={() => chooseMode(value)}
              className={`min-h-[44px] rounded-xl px-3 text-sm font-semibold transition disabled:opacity-60 ${
                mode === value ? "bg-amber-400 text-stone-950" : "text-amber-100/70"
              }`}
            >
              {value === "speak" ? c.dictateModeSpeak : c.dictateModeDecode}
            </button>
          ))}
        </div>

        {mode === "speak" ? (
          <>
            <p className="text-sm text-amber-50/70">{c.dictateSpeakHint}</p>

            <div>
              <div className="mb-1.5 text-xs uppercase tracking-[0.2em] text-amber-100/50">
                {c.dictateStyleLabel}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {DICTATE_STYLES.map((value) => (
                  <button
                    key={value}
                    type="button"
                    data-dictate-style={value}
                    aria-pressed={style === value}
                    disabled={recording || busy || restyling}
                    onClick={() => chooseStyle(value)}
                    className={`min-h-[48px] rounded-2xl border px-3 text-sm font-semibold transition active:scale-[0.99] disabled:opacity-60 ${
                      style === value
                        ? "border-amber-300 bg-amber-400/20 text-amber-100"
                        : "border-white/10 bg-white/5 text-amber-100/70"
                    }`}
                  >
                    {styleLabel[value]}
                  </button>
                ))}
              </div>
            </div>

            <label className="flex items-center justify-between gap-3 text-sm text-amber-100/80">
              <span className="shrink-0">{c.dictateOutputLabel}</span>
              <select
                data-dictate-target=""
                value={target}
                disabled={recording || busy || restyling}
                onChange={(event) => chooseTarget(event.target.value)}
                className="min-h-[44px] min-w-0 flex-1 rounded-xl border border-white/10 bg-stone-900 px-3 text-sm text-amber-100"
              >
                <option value={DICTATE_SAME_LANGUAGE}>
                  {fill(c.dictateSameLanguage, { language: nameOf(mine) })}
                </option>
                {SHEET_LANGUAGES.filter((language) => language.code !== mine).map((language) => (
                  <option key={language.code} value={language.code}>
                    {nameOf(language.code)}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              data-dictate-mic=""
              aria-pressed={recording}
              disabled={busy}
              onClick={toggleRecord}
              className={`flex min-h-[9rem] w-full flex-col items-center justify-center gap-2 rounded-3xl px-4 text-xl font-bold tracking-wide transition active:scale-[0.99] disabled:opacity-70 ${
                recording ? "bg-red-500 text-white" : "bg-emerald-400 text-stone-950"
              }`}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-9 w-9"
              >
                <path d="M12 2a3 3 0 00-3 3v6a3 3 0 006 0V5a3 3 0 00-3-3z" />
                <path d="M5 10v1a7 7 0 0014 0v-1M12 19v3M8.5 22h7" />
              </svg>
              <span>
                {recording ? c.dictateTapToStop : busy ? c.dictateWorking : c.dictateTapToStart}
              </span>
              {recording ? (
                <span className="text-sm font-medium tabular-nums opacity-90">
                  {clock(elapsedMs)} / {clock(DICTATE_MAX_RECORDING_MS)}
                </span>
              ) : null}
            </button>
            <p className="-mt-2 text-center text-xs text-amber-100/50">
              {fill(c.dictateSpeakingIn, { language: nameOf(mine) })} · {c.dictateLimit}
            </p>
          </>
        ) : (
          <>
            <p className="text-sm text-amber-50/70">
              {fill(c.dictateDecodeHint, { language: nameOf(mine) })}
            </p>
            <textarea
              data-dictate-paste-box=""
              value={pasted}
              maxLength={DICTATE_MAX_TEXT_CHARS}
              onChange={(event) => {
                setPasted(event.target.value);
                setDecoded(null);
              }}
              placeholder={c.dictatePastePlaceholder}
              rows={6}
              className="w-full rounded-2xl border border-white/10 bg-stone-900 px-4 py-3 text-base text-amber-50 placeholder:text-amber-100/30"
            />
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                data-dictate-paste=""
                disabled={decoding}
                onClick={() => void pasteFromClipboard()}
                className="min-h-[48px] rounded-2xl border border-amber-300/40 bg-amber-400/10 px-4 text-sm font-semibold text-amber-200 transition active:scale-[0.99] disabled:opacity-60"
              >
                {c.dictatePaste}
              </button>
              <button
                type="button"
                data-dictate-clear=""
                disabled={decoding || !pasted}
                onClick={() => {
                  setPasted("");
                  setDecoded(null);
                  setError(null);
                }}
                className="min-h-[48px] rounded-2xl border border-white/10 bg-white/5 px-4 text-sm font-semibold text-amber-100/70 transition active:scale-[0.99] disabled:opacity-40"
              >
                {c.dictateClear}
              </button>
            </div>
            <button
              type="button"
              data-dictate-decode=""
              disabled={decoding || !pasted.trim()}
              onClick={() => void decode()}
              className="min-h-[64px] w-full rounded-3xl bg-emerald-400 px-4 text-lg font-bold text-stone-950 transition active:scale-[0.99] disabled:opacity-50"
            >
              {decoding ? c.dictateDecoding : c.dictateDecode}
            </button>
          </>
        )}

        {error ? (
          <div
            role="alert"
            className="rounded-2xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-200"
          >
            {error}
          </div>
        ) : null}

        <div ref={resultRef} className="flex flex-col gap-3">
          {mode === "speak" && result ? (
            <>
              <div
                data-dictate-result=""
                className={`rounded-3xl border border-amber-300/20 bg-amber-400/5 p-4 ${restyling ? "opacity-60" : ""}`}
              >
                <div className="text-xs uppercase tracking-[0.2em] text-amber-100/50">
                  {restyling ? c.dictateRestyling : styleLabel[style]}
                </div>
                <div className="mt-1 select-text whitespace-pre-wrap text-lg text-amber-50">
                  {result.styled}
                </div>
              </div>
              {actions("styled", result.styled)}
              <button
                type="button"
                data-dictate-raw-toggle=""
                aria-expanded={showRaw}
                onClick={() => setShowRaw((open) => !open)}
                className="min-h-[44px] self-start rounded-full border border-white/10 bg-white/5 px-4 text-sm text-amber-100/70"
              >
                {showRaw ? c.dictateHideOriginal : c.dictateShowOriginal}
              </button>
              {showRaw ? (
                <div
                  data-dictate-raw=""
                  className="select-text whitespace-pre-wrap rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-amber-100/70"
                >
                  {result.raw}
                </div>
              ) : null}
            </>
          ) : null}

          {mode === "decode" && decoded ? (
            <>
              <div data-dictate-translation="" className="rounded-3xl border border-amber-300/20 bg-amber-400/5 p-4">
                <div className="text-xs uppercase tracking-[0.2em] text-amber-100/50">
                  {c.dictateTranslation}
                </div>
                <div className="mt-1 select-text whitespace-pre-wrap text-lg text-amber-50">
                  {decoded.translation}
                </div>
              </div>
              {decoded.notes.length > 0 ? (
                <div data-dictate-notes="" className="rounded-2xl border border-amber-300/30 bg-amber-400/10 p-4">
                  <div className="text-xs uppercase tracking-[0.2em] text-amber-200/80">
                    {c.dictateUnclear}
                  </div>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-amber-50/90">
                    {decoded.notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {actions("translation", decoded.translation)}
              <div data-dictate-cleaned="" className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="text-xs uppercase tracking-[0.2em] text-amber-100/40">
                  {c.dictateCleaned}
                </div>
                <div className="mt-1 select-text whitespace-pre-wrap text-base text-amber-100/80">
                  {decoded.cleaned}
                </div>
              </div>
              <button
                type="button"
                data-dictate-copy="cleaned"
                onClick={() => void copyText("cleaned", decoded.cleaned)}
                className="min-h-[44px] self-start rounded-full border border-white/10 bg-white/5 px-4 text-sm text-amber-100/70"
              >
                {copied === "cleaned" ? c.dictateCopied : c.dictateCopy}
              </button>
            </>
          ) : null}
        </div>
      </div>
    </main>
  );
}
