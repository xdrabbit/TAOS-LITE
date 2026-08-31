"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { languageFlag, languageNative, type LanguageCode } from "@/lib/languages/catalog";
import { jsonAuthHeaders } from "@/lib/authClient";
import { isTextOnlyLanguage, requestSpeech } from "@/lib/tts/speech";
import { useLanguagePair } from "@/lib/translate/useLanguagePair";
import { LanguagePillRow, LanguageSheet } from "./LanguagePicker";
import { FAST_DEBOUNCE_MS, FAST_MAX_CHARS } from "@/lib/fast/settle";
import { hasSomethingToClear } from "@/lib/fast/clear";
import { fastMicEnabled } from "@/lib/release";

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
// ── The mic is the keyboard's ──────────────────────────────────────────────
// This screen had a mic of its own for two days. Tom took it off on 8/31, and
// the reasoning is worth keeping where the next person to want one will read
// it: every phone TAOS ships to already carries a mic on its keyboard, it
// lands its words in this box exactly as ours did, and it is the control
// people already know. Ours bought partial transcripts and its own
// auto-detect, and cost a week that ended with a mic that worked on Android
// and was DEAD on iPhone in the shape of a working mic — lit button, open
// socket, never a word (three rounds of fixes; PRs #49 and #50 are the file).
//
// So the screen is back to what it always was underneath: a box you type in.
// The line under it says the keyboard's mic works here, because a screen that
// used to have a mic button and now does not should say where the mic went.
//
// The streaming stack is PARKED, not deleted — lib/release.ts lists every
// piece and names the flag. FastMicDock below is the door back in, and it is
// shut: with NEXT_PUBLIC_ENABLE_FAST_MIC unset the dock is never rendered, so
// its chunk is never fetched and none of the Speech SDK reaches a phone.
//
// The screen is minimal on purpose. Its whole virtue is speed, and every
// control added here is a thing between somebody and the word they wanted.

/** Which way round a turn runs, when the writer has pinned it. */
type Pinned = "auto" | "mine" | "theirs";

/**
 * The parked mic (components/fast/FastMicDock.tsx).
 *
 * `dynamic` and not an import: calling it here only registers a loader, and
 * the chunk behind it is fetched on the first RENDER — which cannot happen
 * while `fastMicEnabled()` is false. That is what keeps useLiveDictation,
 * micCapture and microsoft-cognitiveservices-speech-sdk out of what /fast
 * downloads. `ssr: false` because it opens a microphone and there is nothing
 * for a server to render of it.
 */
const FastMicDock = dynamic(() => import("./fast/FastMicDock"), { ssr: false });

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

  // ── The parked mic's two wires ──────────────────────────────────────────
  // Both are here rather than in the dock because Clear needs them, and Clear
  // ships. They cost two `useState` calls when the mic is off, and the dock
  // that would move them is the thing being kept out of the bundle.
  //
  // `micPartial` is the tentative tail — words on screen that are deliberately
  // NOT in `input` (lib/fast/liveTranscript.ts). It stays "" forever while the
  // mic is parked, which is exactly what hasSomethingToClear should then see.
  const [micPartial, setMicPartial] = useState("");
  // A counter the dock watches, bumped to mean "drop what you are holding".
  const [micCancel, setMicCancel] = useState(0);
  const focusInput = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  // ── Clear ───────────────────────────────────────────────────────────────
  // One tap back to the state the screen opens in. lib/fast/clear.ts carries
  // the whole rule; two things this handler must NOT do:
  //
  //   It must not reach for the meter. There is nothing here to reset — since
  //   #51 the allowance is the server's, and clear-and-retype costs nothing
  //   extra because `fast_begin` recognises a phrase it has already answered
  //   (lib/fast/settle.ts, FAST_REPEAT_MS). This used to be a `billedRef` set
  //   in this file, and the risk was a reset button that helpfully emptied it.
  //   The risk is gone; the requirement is the same, and it is pinned against
  //   the real route in tests/fast-clear.test.ts.
  //
  //   `pinned` is NOT touched either. The direction is a decision about the
  //   conversation, not about the phrase that was just cleared.
  const clear = useCallback(() => {
    // Orphan anything in flight. The empty-input effect bumps this too, but a
    // render later, and the whole point of this button is that nothing lands
    // after it.
    seqRef.current += 1;
    setInput("");
    setTranslation("");
    setDetected(null);
    setTarget(null);
    // The engine caption goes with the answer it described. It outlives an
    // emptied box today, which is survivable when the box emptied a character
    // at a time — but a line reading "Azure Translator" under a screen that
    // has been deliberately reset is a claim about nothing.
    setEngine(null);
    setFallback(null);
    setError(null);
    setBusy(false);
    // So a "Copied ✓" from the previous quickie cannot still be sitting on the
    // button when the next translation lands inside its 1400ms.
    setCopied(false);
    // And the parked mic, if somebody has flipped it back on: a tail still
    // arriving is text on its way into the box that was just emptied. A clear
    // during dictation really does discard — it is the one gesture on this
    // screen that means "not that, start again".
    setMicCancel((n) => n + 1);
    // Keyboard users get the caret back without reaching for the box.
    inputRef.current?.focus();
  }, []);

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

  // Only when there is something to clear, so an empty /fast is still the bare
  // box it was designed as. The tentative tail counts as content even though
  // it is deliberately not in `input` — and while the mic is parked it is
  // always "" (lib/fast/clear.ts).
  const clearable = hasSomethingToClear(input, micPartial);

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

        {/* The box, and Clear beside it. Beside and not below: Clear acts on
            the FIELD, and a control that sits under the answer reads as a
            control over the answer.

            The slot is RESERVED rather than faded. It is always in the layout
            at its own height, and only the button inside it comes and goes, so
            appearing costs no reflow — the box does not resize the moment
            somebody types their first letter. A fade would have hidden that
            jump rather than removed it. */}
        <div className="flex items-start gap-2">
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
            className="min-h-[7.5rem] min-w-0 flex-1 resize-none rounded-3xl border border-white/10 bg-[rgba(20,16,14,0.86)] p-4 text-lg leading-relaxed text-amber-50 caret-amber-300 outline-none placeholder:text-amber-100/25"
          />
          {/* h-8 w-8 and not just h-8: the slot used to get its width from the
              56px mic underneath it, and with the mic gone an empty wrapper
              would collapse to zero and hand its width back to the textarea —
              so the box would resize under the caret on the first keystroke.
              The reserved slot has to reserve both dimensions now. */}
          <div className="flex h-8 w-8 shrink-0 items-center justify-center">
            {clearable ? (
              <button
                type="button"
                onClick={clear}
                aria-label="Borrar · Clear"
                title="Borrar · Clear"
                className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/5 text-amber-100/60 transition active:scale-95"
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
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            ) : null}
          </div>
        </div>

        {/* Where the mic went. One quiet line, bilingual like every other piece
            of copy a stranger might read first, and small enough that it does
            not need a dismiss button — a screen this bare cannot afford a
            second control to make the first one go away.

            KNOWN LIMITATION, documented and accepted: iOS keyboard dictation
            transcribes in the KEYBOARD's language, not in whatever is being
            spoken. So dictating the other side of the pair means switching
            keyboards first (globe key), where our own mic auto-detected
            between the two pills. That was the best thing it did and it is
            what this line costs. Somebody typing in one language and looking
            up words in it — the actual /fast loop — never notices. */}
        <p className="-mt-1 px-1 text-[11px] leading-snug text-amber-100/40">
          💡 Your keyboard&rsquo;s mic works here · El micrófono de tu teclado funciona aquí
        </p>

        {/* Parked (lib/release.ts). Never rendered unless somebody sets
            NEXT_PUBLIC_ENABLE_FAST_MIC=1, which is what keeps the whole
            streaming stack out of the chunk this page downloads. */}
        {fastMicEnabled() ? (
          <FastMicDock
            mine={mine}
            theirs={theirs}
            explicitSource={explicitSource}
            setInput={setInput}
            onError={setError}
            onPartialChange={setMicPartial}
            cancelSignal={micCancel}
            onIdle={focusInput}
          />
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
