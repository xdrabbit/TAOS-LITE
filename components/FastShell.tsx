"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { languageFlag, languageNative, type LanguageCode } from "@/lib/languages/catalog";
import { authHeaders, jsonAuthHeaders } from "@/lib/authClient";
import { isTextOnlyLanguage, requestSpeech } from "@/lib/tts/speech";
import { useLanguagePair } from "@/lib/translate/useLanguagePair";
import { LanguagePillRow, LanguageSheet } from "./LanguagePicker";
import { FAST_DEBOUNCE_MS, FAST_MAX_CHARS } from "@/lib/fast/settle";
import { FAST_MAX_DICTATION_MS } from "@/lib/fast/dictation";
import { appendDictated } from "@/lib/fast/liveTranscript";
import { speechCandidates } from "@/lib/fast/speechLocale";
import { useLiveDictation } from "@/lib/fast/useLiveDictation";

// ── /fast: the quickie ─────────────────────────────────────────────────────
// One box. You type, and the translation is already there. No record button,
// no send, no turn — the thing everybody already knows how to do, done well.
//
// It is the ONLY literal surface in TAOS. Everything else asks for the
// translation "a fluent friend would say"; this one asks for the plain word,
// because that is what you want when you are standing in front of a sign or
// trying to remember how to say "receipt". lib/fast/prompt.ts carries that
// register and says why it is deliberately the opposite of the house voice.
//
// ── One clock here, one on the server ──────────────────────────────────────
// This component keeps the 300ms debounce, which is about FEEL: short enough
// that the translation appears to keep up, long enough not to fire a request
// per letter.
//
// It no longer keeps the other one. Until 8/31 a second timer here decided
// what a translation COST — 1500ms of stillness, then a row written straight
// to Supabase from the browser. That was the meter, and a meter in the
// browser is not a meter: a curl with a valid session never ran it, a tab
// closed a fraction early never ran it, and the write was wrapped in a
// `.catch(() => {})` besides. It now happens inside POST /api/fast, before
// the engine is called, off the gaps between requests — which is the same
// pause, measured where it cannot be skipped. lib/fast/meter.ts has the note.
//
// What is left of the money on this screen is DISPLAY. The route may answer
// 402 when the month is spent, and that message is rendered like any other.
//
// ── The mic ────────────────────────────────────────────────────────────────
// The keyboard is still the primary way in. The mic is the sausage-finger
// lane onto the same box: hold it or tap it, and the words land IN the input
// as editable text rather than as an answer. That is the whole difference
// between this and the home screen — there, speaking IS the turn, and a
// mis-heard word is a mis-heard turn. Here it is a draft you can fix before it
// costs anything, which is what /fast is for.
//
// So dictation adds no third clock. The transcript is written into `input`
// exactly as if it had been typed, and the two clocks above take it from
// there: 300ms later it is translated, 1500ms after that it counts. One
// spoken quickie bills one row, the same as one typed quickie.
//
// ── Live, and what is NOT live ─────────────────────────────────────────────
// The mic streams (lib/fast/useLiveDictation.ts): words appear while you are
// still saying them, not in one lump on release. That splits what is on the
// box into two kinds of text, and the split is load-bearing:
//
//   COMMITTED  finalized words. Real `input` state, editable, and what the
//              two clocks above see — so a long sentence gets translated at
//              each pause for breath, exactly as if it were being typed.
//   TENTATIVE  the recogniser is still reconsidering these. Drawn dimmed as
//              a trailing tail and held OUTSIDE `input`, so it never starts a
//              translation. lib/fast/liveTranscript.ts says why that one line
//              is the difference between a live mic and an expensive one.
//
// While the tail is on screen the box is a live view rather than a textarea —
// same box, same type, no caret you can put a word into. It is the only
// seconds on this screen when the keyboard is not the way in, and it ends the
// moment you stop talking: the textarea comes back with the caret at the end
// and every word editable. A dimmed tail cannot be drawn inside a <textarea>,
// and showing the tentative words as though they were settled text would be
// the worse lie.
//
// The screen is minimal on purpose. Its whole virtue is speed, and every
// control added here is a thing between somebody and the word they wanted.
// The mic earns its place by being the one control that makes the screen
// usable while walking.

/** Which way round a turn runs, when the writer has pinned it. */
type Pinned = "auto" | "mine" | "theirs";

/**
 * The box, shared by the textarea and the live view that replaces it.
 *
 * ONE string on purpose. The two render alternately in the same slot, and the
 * swap is only invisible if their metrics are identical — a different padding
 * or line-height between them would make the box jump the instant somebody
 * started talking. min-h matches rows={3} so the empty live view is not
 * shorter than the empty textarea.
 */
const BOX_BASE =
  "min-h-[7.5rem] min-w-0 flex-1 rounded-3xl border border-white/10 bg-[rgba(20,16,14,0.86)] p-4 text-lg leading-relaxed text-amber-50 outline-none";

export function FastShell(): JSX.Element {
  const [input, setInput] = useState("");
  const [translation, setTranslation] = useState("");
  const [detected, setDetected] = useState<LanguageCode | null>(null);
  const [target, setTarget] = useState<LanguageCode | null>(null);
  const [engine, setEngine] = useState<"azure" | "openai" | null>(null);
  const [fallback, setFallback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pinned, setPinned] = useState<Pinned>("auto");

  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // A pair change invalidates whatever is on screen — it is a translation into
  // a language that is no longer selected. The hook does not fire for a tap
  // that changed nothing, so re-tapping the current language leaves a result
  // somebody is still reading alone.
  const { mine, theirs, pills, sheetOpen, setSheetOpen, selectLanguage } = useLanguagePair({
    onPairChange: () => {
      setTranslation("");
      setDetected(null);
      setTarget(null);
      setError(null);
      setPinned("auto");
    }
  });

  // Every in-flight request carries the sequence number it was issued under.
  // Typing outruns the network constantly on this screen, so a reply that is
  // not the newest one is dropped rather than rendered — otherwise a slow
  // early request lands last and the box shows the translation of a sentence
  // three words ago.
  const seqRef = useRef(0);

  const explicitSource: LanguageCode | null =
    pinned === "auto" ? null : pinned === "mine" ? mine : theirs;

  const translate = useCallback(
    async (text: string, source: LanguageCode | null, seq: number) => {
      setBusy(true);
      try {
        const res = await fetch("/api/fast", {
          method: "POST",
          headers: await jsonAuthHeaders(),
          // The shared contract (lib/translate/textRequest.ts): name BOTH
          // sides, and add `direction: "auto"` when we do not know which of
          // them was typed. Pinning the direction is just naming the sides in
          // the order they run — the parser reads sourceLanguage as the side
          // the text is in unless "auto" says otherwise.
          body: JSON.stringify(
            source === null
              ? { text, sourceLanguage: mine, targetLanguage: theirs, direction: "auto" }
              : {
                  text,
                  sourceLanguage: source,
                  targetLanguage: source === mine ? theirs : mine
                }
          )
        });
        const payload = (await res.json().catch(() => ({}))) as {
          translation?: string;
          detectedSource?: LanguageCode;
          targetLanguage?: LanguageCode;
          engine?: "azure" | "openai";
          fallback?: string | null;
          error?: string;
          details?: string;
        };
        // A stale reply is not an error and must not clear a newer result.
        if (seq !== seqRef.current) return;
        if (!res.ok) throw new Error(payload.details || payload.error || "Translation failed.");
        setTranslation(payload.translation ?? "");
        setDetected(payload.detectedSource ?? null);
        setTarget(payload.targetLanguage ?? null);
        setEngine(payload.engine ?? null);
        setFallback(payload.fallback ?? null);
        setError(null);
      } catch (e) {
        if (seq !== seqRef.current) return;
        setError(e instanceof Error ? e.message : "Translation failed.");
      } finally {
        if (seq === seqRef.current) setBusy(false);
      }
    },
    [mine, theirs]
  );

  // ── Clock one: the 300ms debounce that fetches ──────────────────────────
  useEffect(() => {
    const text = input.trim();
    if (!text) {
      seqRef.current += 1; // orphan anything in flight
      setTranslation("");
      setDetected(null);
      setTarget(null);
      setError(null);
      setBusy(false);
      return;
    }
    const seq = (seqRef.current += 1);
    const id = window.setTimeout(() => void translate(text, explicitSource, seq), FAST_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [input, explicitSource, translate]);

  // ── The mic ─────────────────────────────────────────────────────────────
  // Audio in, transcript into the box. Nothing here translates: setting
  // `input` is exactly what a keystroke does, and the debounce above does the
  // rest — which is why a spoken quickie and a typed one cost the same one
  // row, and why the words are sitting in an editable box when they arrive.
  // (The billing itself is the server's now — lib/fast/meter.ts. A spoken
  // quickie is the same burst of previews a typed one is, so it needs no
  // special case there either.)
  // One place where dictated words enter the box, whichever mic produced them.
  // APPENDED, never replacing (lib/fast/liveTranscript.ts): somebody who typed
  // half a phrase and then said the rest has not asked for the typed half to
  // be thrown away, and there is no undo on this screen. Setting `input` is
  // exactly what a keystroke does, which is why a spoken quickie and a typed
  // one cost the same one row.
  const commitDictated = useCallback((heard: string) => {
    setInput((current) => appendDictated(current, heard, FAST_MAX_CHARS));
    setError(null);
  }, []);

  const receiveDictation = useCallback(
    async (blob: Blob, mimeType: string) => {
      const form = new FormData();
      // A filename with an extension the container matches: the transcriber
      // sniffs it, and a webm blob called .bin comes back "unsupported".
      const ext = mimeType.includes("mp4") || mimeType.includes("aac") ? "mp4" : "webm";
      form.append("audio", new File([blob], `quickie.${ext}`, { type: mimeType }));
      // Only so the transcriber knows whether Cantonese is possible
      // (lib/fast/dictation.ts). It is NOT a source hint — the box does not
      // know which of the two somebody is about to speak, which is the same
      // reason the direction row says Auto.
      form.append("pairA", mine);
      form.append("pairB", theirs);
      try {
        // authHeaders, not jsonAuthHeaders: the browser must set its own
        // multipart boundary, and a Content-Type here corrupts the body.
        const res = await fetch("/api/fast/listen", {
          method: "POST",
          headers: await authHeaders(),
          body: form
        });
        const payload = (await res.json().catch(() => ({}))) as {
          text?: string;
          error?: string;
        };
        if (!res.ok) throw new Error(payload.error || "Could not hear that.");
        const heard = (payload.text ?? "").trim();
        if (!heard) throw new Error("Nothing was heard — try again.");
        commitDictated(heard);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not hear that.");
      }
    },
    [commitDictated, mine, theirs]
  );

  // Which languages to tell Azure to listen for. The pair is required — both
  // sides, or this answers null and the batch mic takes the job, because a
  // recogniser that can hear only one of the two pills would silently mangle
  // every sentence said in the other. The rest of the slots come from the pill
  // row, which is this phone's own answer to "what languages am I in the
  // middle of" (lib/fast/speechLocale.ts has the full note, and the reason the
  // cap is four).
  const candidates = useMemo(() => speechCandidates([mine, theirs], pills), [mine, theirs, pills]);

  const dictation = useLiveDictation({
    candidates,
    onSegment: commitDictated,
    onAudio: receiveDictation,
    onError: setError,
    onStart: useCallback(() => setError(null), [])
  });

  // Put the caret back in the box when the mic lets go. The point of dictating
  // into a text FIELD rather than at a translator is that the next thing you
  // might do is fix a word — but only once, at the end: focusing on every
  // finalized segment would pop the keyboard up over the screen while somebody
  // is still talking into it.
  const dictating = dictation.state !== "idle";
  const wasDictatingRef = useRef(false);
  useEffect(() => {
    if (wasDictatingRef.current && !dictating) {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }
    wasDictatingRef.current = dictating;
  }, [dictating]);

  // The live view stands in for the textarea only while the STREAMING mic is
  // open. The batch mic has no partials to draw, so it leaves the box editable
  // the whole time it records — which is exactly what it did before this, and
  // one less thing that changes when a pair falls back.
  const live = dictation.mode === "stream" && dictation.state === "recording";

  const copy = useCallback(async () => {
    if (!translation) return;
    try {
      await navigator.clipboard.writeText(translation);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard is permissioned and absent on some in-app browsers. The
      // text is selectable on screen either way, so this stays quiet.
    }
  }, [translation]);

  const speak = useCallback(async () => {
    if (!translation || !target) return;
    try {
      const blob = await requestSpeech({
        text: translation,
        sourceLanguage: detected,
        targetLanguage: target
      });
      // null = the language is text-only. `speakable` already hid the button
      // for those, so reaching this is the stale-client case: a phone holding
      // an old bundle after a tier flipped. Quiet either way — it is not an
      // error and there is nothing useful to say about it.
      if (!blob) return;
      const audio = new Audio(URL.createObjectURL(blob));
      void audio.play();
    } catch {
      /* a quickie is not worth an error banner over playback */
    }
  }, [translation, detected, target]);

  /**
   * The swap. From auto it PINS the opposite of whatever was just detected —
   * which is what somebody means when they hit swap on a result that came out
   * the wrong way round. After that it toggles between the two sides, and the
   * Auto chip next to it hands the decision back.
   */
  const swap = useCallback(() => {
    setPinned((current) => {
      if (current === "mine") return "theirs";
      if (current === "theirs") return "mine";
      return detected === mine ? "theirs" : "mine";
    });
  }, [detected, mine]);

  const from = detected ?? explicitSource ?? mine;
  const to = target ?? (from === mine ? theirs : mine);
  // Tier 2 (text-only) languages have no voice, and requestSpeech answers null
  // for them rather than failing. That is the right behaviour for a caller
  // that already committed to asking — but on a screen this bare, a speaker
  // icon that silently does nothing is worse than no icon. So the catalog is
  // asked BEFORE the button is drawn, the same question the pill row asks when
  // it puts a muted speaker on a tier-2 pill.
  const speakable = useMemo(
    () => Boolean(translation && target && !isTextOnlyLanguage(target)),
    [translation, target]
  );

  return (
    <main className="min-h-screen px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-[calc(env(safe-area-inset-top)+1rem)]">
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-md flex-col gap-4">
        <header className="flex items-center justify-between gap-2">
          <h1 className="text-lg font-semibold tracking-tight text-amber-200">TAOS·LITE</h1>
          <a
            href="/"
            className="rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-sm text-amber-100/80"
          >
            ← Home
          </a>
        </header>

        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-amber-100/50">
            Quick translate · Traducción rápida
          </div>
          {/* Says out loud what makes this screen different from /translate,
              because two translation screens that disagree on purpose is only
              a feature if somebody knows which is which. */}
          <p className="mt-1 text-sm text-amber-50/70">
            Word-for-word, as you type. For the plain meaning of a word or a sign — the rest of
            TAOS translates the way a friend would say it.
            <br />
            <span className="text-amber-100/50">
              Palabra por palabra, mientras escribes.
            </span>
          </p>
        </div>

        <LanguagePillRow
          pills={pills}
          selected={theirs}
          paired={mine}
          caption="Between · Entre"
          sheetOpen={sheetOpen}
          onSelect={selectLanguage}
          onOpenSheet={() => setSheetOpen(true)}
        />

        {/* The resolved direction, always on screen, plus the swap. Auto is
            the default and says so — a detector that silently picks a side is
            the one thing that would make this screen feel unpredictable. */}
        <div className="flex items-center justify-between gap-2 rounded-2xl border border-white/10 bg-white/5 px-3 py-2">
          <span className="truncate text-sm text-amber-100/80">
            {languageFlag(from)} {languageNative(from)} → {languageFlag(to)} {languageNative(to)}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            {pinned !== "auto" ? (
              <button
                type="button"
                onClick={() => setPinned("auto")}
                className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-amber-100/60"
              >
                Auto
              </button>
            ) : (
              <span className="rounded-full border border-amber-300/25 bg-amber-400/10 px-2.5 py-1 text-[11px] text-amber-200/80">
                Auto
              </span>
            )}
            <button
              type="button"
              onClick={swap}
              aria-label="Swap direction · Cambiar dirección"
              title="Swap direction · Cambiar dirección"
              className="flex h-8 w-8 items-center justify-center rounded-full border border-amber-300/30 bg-amber-400/10 text-amber-200 transition active:scale-95"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-4 w-4"
              >
                <path d="M7 4v13M7 4L4 7M7 4l3 3M17 20V7M17 20l3-3M17 20l-3-3" />
              </svg>
            </button>
          </div>
        </div>

        {/* The box, and the mic beside it. Beside and not below: they are two
            ways into the SAME field, and a control that sits under the answer
            reads as a control over the answer. The keyboard is still primary —
            the textarea takes the width and the autofocus, and the mic is a
            thumb-sized target next to it. */}
        <div className="flex items-end gap-2">
          {live ? (
            /* The live view. Same box, same type, same metrics as the textarea
               it stands in for — only the caret is gone, because for these few
               seconds the words are arriving from a mouth rather than a
               keyboard. No aria-live: a hypothesis changes several times a
               second, and announcing each one would make a screen reader
               unusable. The recording banner below is the status region, and
               the committed text is read normally once the mic lets go. */
            <div className={`${BOX_BASE} overflow-y-auto whitespace-pre-wrap break-words`}>
              {input ? <span>{input}</span> : null}
              {dictation.partial ? (
                <span className="text-amber-100/40">
                  {input ? " " : ""}
                  {dictation.partial}
                </span>
              ) : null}
              {/* Something to watch while the first words are still coming. */}
              <span className="ml-0.5 inline-block h-[1.1em] w-[2px] animate-pulse bg-amber-300 align-text-bottom" />
              {!input && !dictation.partial ? (
                <span className="text-amber-100/25"> Listening… · Escuchando…</span>
              ) : null}
            </div>
          ) : (
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value.slice(0, FAST_MAX_CHARS))}
              maxLength={FAST_MAX_CHARS}
              autoFocus
              rows={3}
              placeholder="Type a word or a phrase…"
              autoCapitalize="sentences"
              autoCorrect="on"
              spellCheck
              className={`${BOX_BASE} resize-none caret-amber-300 placeholder:text-amber-100/25`}
            />
          )}
          {/* Pointer events, not onClick: the button has to know the
              DIFFERENCE between a hold and a tap, and a click only ever
              reports that both happened. `touch-none` keeps a held finger
              from scrolling the page out from under itself, and the pointer
              capture keeps the release on this button even if the finger
              drifts off it mid-sentence — a walking thumb always drifts. */}
          <button
            type="button"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              dictation.press();
            }}
            onPointerUp={() => dictation.release()}
            onPointerCancel={() => dictation.release()}
            disabled={dictation.state === "working"}
            aria-label="Dictar · Dictate"
            title="Dictar · Dictate"
            aria-pressed={dictation.state === "recording"}
            className={`flex h-14 w-14 shrink-0 touch-none select-none items-center justify-center rounded-full border transition active:scale-95 disabled:opacity-60 ${
              dictation.state === "recording"
                ? "animate-pulse border-amber-300 bg-amber-400 text-stone-950 shadow-[0_0_28px_rgba(251,191,36,0.55)]"
                : "border-amber-300/30 bg-amber-400/10 text-amber-200"
            }`}
          >
            {dictation.state === "working" ? (
              <span className="text-[11px] font-semibold tracking-tight">···</span>
            ) : (
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-6 w-6"
              >
                <path d="M12 2a3 3 0 00-3 3v6a3 3 0 006 0V5a3 3 0 00-3-3z" />
                <path d="M5 10v1a7 7 0 0014 0v-1M12 19v3M8.5 22h7" />
              </svg>
            )}
          </button>
        </div>

        {/* Only while it is listening. A permanent hint under the box would be
            one more thing between somebody and the word they wanted. */}
        {dictation.state === "recording" ? (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center justify-between gap-2 rounded-2xl border border-amber-300/25 bg-amber-400/10 px-3 py-2 text-sm text-amber-100/80"
          >
            <span className="truncate">
              {dictation.latched ? "Listening — tap to stop" : "Listening — let go when done"}
              <span className="ml-2 tabular-nums text-amber-100/50">
                {Math.max(0, Math.round(FAST_MAX_DICTATION_MS / 1000) - dictation.seconds)}s
              </span>
            </span>
            {/* The same button means two different things, so it says two
                different things. Streaming has already put the finalized words
                in the box — there is nothing left to take back, only a tail to
                drop, so it is "Done". The batch mic is still holding audio
                nobody has seen, and stopping it really does discard: "Cancel".
                One label for both would promise an undo this screen does not
                have. */}
            <button
              type="button"
              onClick={dictation.cancel}
              className="shrink-0 rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-amber-100/60"
            >
              {dictation.mode === "stream" ? "Done · Listo" : "Cancel · Cancelar"}
            </button>
          </div>
        ) : null}

        {/* Batch only. Streaming's "working" is the sub-second flush that
            collects the last word after you stop, and the words are already on
            screen — a banner announcing that it is writing them down would
            appear and vanish faster than it could be read. */}
        {dictation.state === "working" && dictation.mode !== "stream" ? (
          <p role="status" aria-live="polite" className="text-center text-sm text-amber-100/60">
            Writing it down… · Escribiéndolo…
          </p>
        ) : null}

        {/* The answer. It REPLACES in place rather than clearing first: the
            box going blank between keystrokes is what makes an as-you-type
            surface feel broken, so the previous translation stays put and
            only dims while a newer one is on the way. */}
        <section className="flex flex-1 flex-col">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs uppercase tracking-[0.18em] text-emerald-100/50">
              {languageNative(to)}
            </span>
            {translation ? (
              <div className="flex items-center gap-1">
                {speakable ? (
                  <button
                    type="button"
                    onClick={() => void speak()}
                    aria-label="Hear it · Escuchar"
                    title="Hear it · Escuchar"
                    className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/5 text-amber-100/70 transition active:scale-95"
                  >
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-4 w-4"
                    >
                      <path d="M11 5L6 9H3v6h3l5 4V5zM16 9a4 4 0 010 6" />
                    </svg>
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => void copy()}
                  aria-label="Copy · Copiar"
                  title="Copy · Copiar"
                  className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] text-amber-100/70 transition active:scale-95"
                >
                  {copied ? "Copied ✓" : "Copy · Copiar"}
                </button>
              </div>
            ) : null}
          </div>

          {translation ? (
            <div
              className={`rounded-3xl border border-white/10 bg-[rgba(18,44,36,0.7)] p-5 transition-opacity ${
                busy ? "opacity-60" : "opacity-100"
              }`}
            >
              <p className="text-pretty text-[clamp(1.5rem,6vw,2.2rem)] font-semibold leading-tight tracking-tight text-white">
                {translation}
              </p>
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center rounded-3xl border border-dashed border-white/10 px-5 py-10 text-center text-amber-100/40">
              Start typing — the translation appears here.
            </div>
          )}
        </section>

        {error ? (
          <p
            role="status"
            aria-live="polite"
            className="rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200"
          >
            {error}
          </p>
        ) : null}

        {/* Which engine answered. Not decoration: /fast runs on Azure
            Translator when the resource is configured and on a literal-prompted
            OpenAI model when it is not (lib/fast/engine.ts), and the two have
            measurably different registers. A founder reading a translation
            deserves to know which one they are reading. */}
        {engine ? (
          <p className="text-center text-[11px] text-amber-100/30">
            {engine === "azure"
              ? "Azure Translator"
              : fallback === "azure_unsupported_language"
                ? `literal AI — Azure has no ${languageNative(to)}`
                : "literal AI — Azure Translator not configured"}
          </p>
        ) : null}
      </div>

      <LanguageSheet
        open={sheetOpen}
        selected={theirs}
        paired={mine}
        onSelect={selectLanguage}
        onClose={() => setSheetOpen(false)}
      />
    </main>
  );
}
