"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { languageFlag, languageNative, type LanguageCode } from "@/lib/languages/catalog";
import { jsonAuthHeaders } from "@/lib/authClient";
import { saveTranslation } from "@/lib/supabase";
import { requestSpeech } from "@/lib/tts/speech";
import { useLanguagePair } from "@/lib/translate/useLanguagePair";
import { LanguagePillRow, LanguageSheet } from "./LanguagePicker";
import {
  billingKey,
  FAST_DEBOUNCE_MS,
  FAST_MAX_CHARS,
  FAST_SETTLE_MS
} from "@/lib/fast/settle";

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
// ── The two clocks ─────────────────────────────────────────────────────────
// Typing drives two timers, and they are different lengths on purpose
// (lib/fast/settle.ts has the full note):
//
//   300ms  — a pause this long sends a request. This is FEEL.
//   1500ms — a pause this long means the sentence is finished, and THAT is
//            what counts against the monthly allowance. Everything rendered
//            in between is a preview of a sentence still being written, and
//            billing previews would spend a free month on one paragraph.
//
// The screen is minimal on purpose. Its whole virtue is speed, and every
// control added here is a thing between somebody and the word they wanted.

/** Which way round a turn runs, when the writer has pinned it. */
type Pinned = "auto" | "mine" | "theirs";

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
  // What has already been counted against the allowance, so a settle that
  // fires twice over the same words does not bill twice (lib/fast/settle.ts).
  const billedRef = useRef<Set<string>>(new Set());

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

  // ── Clock two: the 1500ms settle that BILLS ─────────────────────────────
  // Deliberately not folded into the effect above. It waits on the typing AND
  // on a translation for those exact words having arrived, which is why it
  // depends on `translation` as well as `input`: a settle that fired while the
  // box still held the previous answer would bill for a preview.
  useEffect(() => {
    const text = input.trim();
    if (!text || !translation || !detected || !target) return;
    const id = window.setTimeout(() => {
      const key = billingKey(text, detected, target);
      if (billedRef.current.has(key)) return;
      billedRef.current.add(key);
      // The row IS the meter: the free monthly allowance is a count of rows in
      // this table (lib/supabase.ts, getMonthlyUsage), which is the same thing
      // the home screen writes when a spoken turn finishes. Writing it here is
      // what wires /fast into the normal allowance rather than giving it a
      // private counter that would have to be reconciled later. It doubles as
      // the History entry, which is the other half of "a settled quickie is a
      // thing you meant to look up".
      void saveTranslation({
        source_lang: detected,
        target_lang: target,
        tone: "literal",
        original_text: text,
        translation_text: translation,
        engine: engine ?? "fast"
      }).catch(() => {});
    }, FAST_SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [input, translation, detected, target, engine]);

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
      // null = the language is text-only. Not an error, and not worth a
      // message on a screen this bare — the speaker is simply hidden for
      // those languages (see `speakable` below).
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
  const speakable = useMemo(() => Boolean(translation && target), [translation, target]);

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
          className="w-full resize-none rounded-3xl border border-white/10 bg-[rgba(20,16,14,0.86)] p-4 text-lg leading-relaxed text-amber-50 caret-amber-300 outline-none placeholder:text-amber-100/25"
        />

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
