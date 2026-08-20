"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { predict } from "@/lib/predict/engine";
import type { PredictModel } from "@/lib/predict/model.mjs";
import { languageNative } from "@/lib/languages/catalog";
import { LanguagePillRow, LanguageSheet } from "./LanguagePicker";
import { useLanguagePair } from "@/lib/translate/useLanguagePair";
import { pairDirection, type PairSide } from "@/lib/translate/pair";
import { jsonAuthHeaders } from "@/lib/authClient";

// ── /translate: manual typing surface with personalized predictive autocomplete
// A companion to /live's voice follow-along. You TYPE; a prediction model trained
// on Tom & Liz's own conversation history makes their habitual phrases nearly free
// to type — ghost text (accept with Tab / →) plus tappable chips. Submitting sends
// the text to the existing POST /api/text-translate for the actual translation.
// Every keystroke prediction runs in-memory on a model loaded once per direction —
// no network call per keystroke.
//
// ── It follows the pills now (8/19) ─────────────────────────────────────────
// This screen kept a private `Direction = "en-es" | "es-en"` with a table of
// labels and placeholders hanging off it, and it was the LAST one to: /live,
// /tabletop and /chat were wired to the catalog on 8/18 and this one was
// missed, so a phone set to Bosnian on the home screen still typed into
// Spanish here. Nothing about typing was ever EN⇄ES — only this table was.
//
// The pair comes from the shared state now (lib/translate/useLanguagePair.ts),
// which is the same pair /translate's home screen, /live and /tabletop read,
// off the same key on disk. The toggle below keeps its own job: the PAIR says
// which two languages, the toggle says which of the two is doing the typing
// (lib/translate/pair.ts, pairDirection).
//
// The suggestions are the one thing that genuinely stays EN⇄ES — see the note
// on the model fetch below.

function formatBuilt(iso: string | null): string {
  if (!iso) return "not built yet";
  try {
    const d = new Date(iso);
    return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "unknown";
  }
}

export function TranslateShell(): JSX.Element {
  const [input, setInput] = useState("");
  const [model, setModel] = useState<PredictModel | null>(null);
  const [builtAt, setBuiltAt] = useState<string | null>(null);
  // false = no model was ever BUILT for this pair, so there is nothing to
  // suggest and the screen says so instead of going mysteriously quiet.
  const [trained, setTrained] = useState(true);

  const [translation, setTranslation] = useState("");
  const [translating, setTranslating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildNote, setRebuildNote] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Which of the two is typing. The PAIR is not this screen's to invent — it
  // is the phone's answer to "what languages am I working between right now?"
  // and it arrives from the shared hook. This only says which side of it is at
  // the keyboard, which is the one thing the old toggle was really for.
  const [speaking, setSpeaking] = useState<PairSide>("mine");

  // A pair change tears the current turn down: the translation on screen is in
  // a language that is no longer selected. The hook does not fire this for a
  // tap that changed nothing, so re-tapping the selected language leaves a
  // translation someone is still reading alone.
  const { pair, mine, theirs, pills, sheetOpen, setSheetOpen, selectLanguage } = useLanguagePair({
    onPairChange: () => {
      setTranslation("");
      setError(null);
    }
  });

  const { sourceLanguage, targetLanguage } = pairDirection(pair, speaking);
  const direction = `${sourceLanguage}-${targetLanguage}`;

  // Load the direction's model once (and on direction switch). All keystroke
  // prediction then runs in-memory against this — never per keystroke.
  //
  // The key is still a direction string, and deliberately: the model is not a
  // language feature, it is Tom & Liz's own history n-grammed, and their
  // history is in English and Spanish. Every other pair asks for a direction
  // that was never built, and /api/predict/model answers `model: null` for it
  // rather than handing back the English one (which is what it used to do).
  // predict(null, …) is already a no-op, so typing stays exactly as fast and
  // only the ghost text goes quiet.
  useEffect(() => {
    let cancelled = false;
    setModel(null);
    fetch(`/api/predict/model?direction=${direction}`)
      .then((r) => r.json())
      .then((data: { model?: PredictModel | null; builtAt?: string | null; trained?: boolean }) => {
        if (cancelled) return;
        setModel(data.model ?? null);
        setBuiltAt(data.builtAt ?? null);
        setTrained(data.trained !== false);
      })
      .catch(() => {
        // Prediction silently no-ops if the model can't load; typing still works.
        if (!cancelled) setModel(null);
      });
    return () => {
      cancelled = true;
    };
  }, [direction]);

  // Zero-latency prediction: recomputed synchronously from the in-memory model.
  const prediction = useMemo(() => predict(model, input), [model, input]);

  const acceptGhost = useCallback(() => {
    if (prediction.ghostApply === null) return false;
    setInput(prediction.ghostApply);
    return true;
  }, [prediction.ghostApply]);

  const applyChip = useCallback((apply: string) => {
    setInput(apply);
    textareaRef.current?.focus();
  }, []);

  const runTranslate = useCallback(async () => {
    const text = input.trim();
    if (!text || translating) return;
    setTranslating(true);
    setError(null);
    try {
      const res = await fetch("/api/text-translate", {
        method: "POST",
        headers: await jsonAuthHeaders(),
        body: JSON.stringify({ text, sourceLanguage, targetLanguage })
      });
      const payload = (await res.json().catch(() => ({}))) as {
        translation?: string;
        error?: string;
        details?: string;
      };
      if (!res.ok) throw new Error(payload.details || payload.error || "Translation failed.");
      setTranslation(typeof payload.translation === "string" ? payload.translation : "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Translation failed.");
    } finally {
      setTranslating(false);
    }
  }, [input, sourceLanguage, targetLanguage, translating]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const el = e.currentTarget;
      const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
      // Tab always accepts the ghost; → only when the caret sits at the very end
      // (otherwise → should just move the caret).
      if ((e.key === "Tab" || (e.key === "ArrowRight" && atEnd)) && prediction.ghostApply !== null) {
        e.preventDefault();
        acceptGhost();
        return;
      }
      // Enter submits; Shift+Enter inserts a newline.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void runTranslate();
      }
    },
    [prediction.ghostApply, acceptGhost, runTranslate]
  );

  const rebuild = useCallback(async () => {
    if (rebuilding) return;
    setRebuilding(true);
    setRebuildNote(null);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) {
        setRebuildNote("Sign in to rebuild suggestions.");
        return;
      }
      const res = await fetch("/api/predict/rebuild", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }
      });
      const payload = (await res.json().catch(() => ({}))) as { builtAt?: string; error?: string };
      if (!res.ok) throw new Error(payload.error || "Rebuild failed.");
      // Reload the freshly-built model for the current direction.
      const mres = await fetch(`/api/predict/model?direction=${direction}`);
      const mdata = (await mres.json()) as {
        model?: PredictModel | null;
        builtAt?: string | null;
        trained?: boolean;
      };
      setModel(mdata.model ?? null);
      setBuiltAt(mdata.builtAt ?? payload.builtAt ?? null);
      setTrained(mdata.trained !== false);
      setRebuildNote("Suggestions rebuilt.");
    } catch (e) {
      setRebuildNote(e instanceof Error ? e.message : "Rebuild failed.");
    } finally {
      setRebuilding(false);
    }
  }, [rebuilding, direction]);

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
          <div className="text-xs uppercase tracking-[0.2em] text-amber-100/50">Type &amp; translate</div>
          <p className="mt-1 text-sm text-amber-50/70">
            Autocomplete learns <em>your</em> phrases from past chats — familiar words are nearly free to
            type. Press <kbd className="rounded bg-white/10 px-1">Tab</kbd> or{" "}
            <kbd className="rounded bg-white/10 px-1">→</kbd> to accept, or tap a chip.
          </p>
        </div>

        {/* The pills — drawn by components/LanguagePicker.tsx, the same row
            /translate's home screen, /live, /tabletop and /chat put on screen,
            over the same pair on disk. The solid pill is THEIRS; tapping your
            own outlined pill flips the pair. A text-only language marks itself
            with a muted speaker here, which is all this screen needs to say
            about tier 2: there is no audio control on it to disappoint. */}
        <LanguagePillRow
          pills={pills}
          selected={theirs}
          paired={mine}
          caption="Translate into · Traducir a"
          sheetOpen={sheetOpen}
          onSelect={selectLanguage}
          onOpenSheet={() => setSheetOpen(true)}
        />

        {/* Who is TYPING — the pair says which two languages, this says which
            of them is at the keyboard (lib/translate/pair.ts, pairDirection). */}
        <div className="grid grid-cols-2 gap-2 rounded-2xl border border-white/10 bg-white/5 p-1">
          {(
            [
              ["mine", `You (${mine.toUpperCase()} → ${theirs.toUpperCase()})`],
              ["theirs", `Them · Ellos (${theirs.toUpperCase()} → ${mine.toUpperCase()})`]
            ] as [PairSide, string][]
          ).map(([side, label]) => (
            <button
              key={side}
              type="button"
              onClick={() => {
                if (side === speaking) return;
                setSpeaking(side);
                setTranslation("");
                setError(null);
              }}
              className={`rounded-xl px-3 py-2 text-sm font-medium transition ${
                speaking === side ? "bg-amber-400 text-stone-950" : "text-amber-100/70"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Spell the direction out in both languages' own names, so nobody has
            to infer it from which pill is filled in. */}
        <p className="-mt-2 text-xs text-amber-100/50">
          {languageNative(sourceLanguage)} → {languageNative(targetLanguage)}
        </p>

        {/* Typing surface with inline ghost text */}
        <section className="flex flex-col gap-2">
          <div className="relative rounded-3xl border border-white/10 bg-[rgba(20,16,14,0.86)]">
            {/* Ghost backdrop: renders the typed text invisibly + the prediction
                dimmed, perfectly aligned under the textarea. */}
            <div
              aria-hidden="true"
              className="pointer-events-none min-h-[8rem] whitespace-pre-wrap break-words p-4 text-lg leading-relaxed"
            >
              <span className="text-transparent">{input}</span>
              <span className="text-amber-100/30">{prediction.ghostText}</span>
              {input === "" && prediction.ghostText === "" ? "​" : null}
            </div>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              // "Type in English…" verbatim for EN; the language's OWN name
              // for the other ninety-nine, because localising the verb a
              // hundred times is the table this screen just got rid of.
              placeholder={`Type in ${languageNative(sourceLanguage)}…`}
              autoCapitalize="sentences"
              autoCorrect="on"
              spellCheck
              className="absolute inset-0 h-full w-full resize-none bg-transparent p-4 text-lg leading-relaxed text-amber-50 caret-amber-300 outline-none placeholder:text-amber-100/25"
            />
          </div>

          {/* Suggestion chips — thumb-friendly alternatives */}
          <div className="flex min-h-[2.25rem] flex-wrap gap-2">
            {prediction.chips.map((chip) => (
              <button
                key={chip.apply}
                type="button"
                onMouseDown={(e) => e.preventDefault()} // keep textarea focus
                onClick={() => applyChip(chip.apply)}
                className="rounded-full border border-amber-300/25 bg-amber-400/10 px-3 py-1.5 text-sm text-amber-100/90 transition active:scale-95"
              >
                {chip.label}
              </button>
            ))}
          </div>

          {/* Model status + manual rebuild */}
          <div className="flex items-center justify-between gap-2 text-[11px] text-amber-100/40">
            <span>
              {trained
                ? `model last built: ${formatBuilt(builtAt)}`
                : "no suggestions for this pair — typing works as usual"}
            </span>
            <button
              type="button"
              onClick={rebuild}
              disabled={rebuilding}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-amber-100/70 disabled:opacity-50"
            >
              {rebuilding ? "rebuilding…" : "rebuild suggestions"}
            </button>
          </div>
          {rebuildNote ? <p className="text-[11px] text-amber-100/50">{rebuildNote}</p> : null}
        </section>

        {/* Translate control */}
        <button
          type="button"
          onClick={() => void runTranslate()}
          disabled={!input.trim() || translating}
          className="flex h-14 items-center justify-center rounded-2xl border border-amber-300/30 bg-stone-50 text-lg font-semibold text-stone-900 transition active:scale-[0.99] hover:bg-white disabled:opacity-50"
        >
          {translating ? "Translating…" : "Translate"}
        </button>

        {error ? (
          <p
            role="status"
            aria-live="polite"
            className="rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200"
          >
            {error}
          </p>
        ) : null}

        {/* Translation pane — big and glanceable, matching /live */}
        <section className="flex flex-1 flex-col">
          <div className="mb-2 text-xs uppercase tracking-[0.18em] text-emerald-100/50">Translation</div>
          {translation ? (
            <div className="rounded-3xl border border-white/10 bg-[rgba(18,44,36,0.7)] p-5">
              <p className="text-pretty text-[clamp(1.5rem,6vw,2.2rem)] font-semibold leading-tight tracking-tight text-white">
                {translation}
              </p>
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center rounded-3xl border border-dashed border-white/10 px-5 py-10 text-center text-amber-100/40">
              Type above, then Translate — the result shows here.
            </div>
          )}
        </section>
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
