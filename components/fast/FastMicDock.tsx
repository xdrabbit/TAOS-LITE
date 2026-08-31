"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { LanguageCode } from "@/lib/languages/catalog";
import { authHeaders } from "@/lib/authClient";
import { FAST_MAX_CHARS } from "@/lib/fast/settle";
import { FAST_MAX_DICTATION_MS } from "@/lib/fast/dictation";
import { appendDictated } from "@/lib/fast/liveTranscript";
import { speechCandidates } from "@/lib/fast/speechLocale";
import { useLiveDictation } from "@/lib/fast/useLiveDictation";

// ── /fast's mic — PARKED ────────────────────────────────────────────────────
//
// Nothing in this file runs unless NEXT_PUBLIC_ENABLE_FAST_MIC=1. FastShell
// reaches it through a `dynamic()` import behind `fastMicEnabled()`, so with
// the flag unset the chunk is never fetched and the streaming stack it pulls
// in — useLiveDictation, micCapture and the Speech SDK — is not in the bundle
// a phone downloads. lib/release.ts carries the decision and the date;
// ENHANCEMENTS.md carries the forensic file.
//
// The short version: this mic worked on Android and was DEAD on iPhone, in the
// shape of a working mic — button lit, socket open, never a word — and three
// rounds of fixes (PRs #49, #50) did not close it. Tom's call on 8/31 was that
// every phone already carries a mic on its keyboard, and that one works. So
// /fast is a typing screen again, and this is the drawer the work went into.
//
// ── What was lifted out of FastShell, and what changed on the way ──────────
// The hook, the button, the two status banners and the tentative tail all came
// across intact. ONE thing was deliberately not preserved: the mic used to sit
// in a column beside the box with Clear above it, and the tentative tail used
// to be drawn INSIDE a stand-in for the textarea, so that partial words
// appeared where typed words appear. That arrangement needed the mic's state
// spread across FastShell, which is exactly what has to stay out of the
// default bundle — so the dock is one self-contained block below the box, and
// the tail is a dimmed line under it.
//
// If this is revived on Android, that is the one piece of UI work waiting:
// PR #49's diff of components/FastShell.tsx has the original arrangement, and
// the reason for every pixel of it, in the comments it was lifted from.
//
// ── What has NOT changed ───────────────────────────────────────────────────
// The rule the whole feature turns on. Dictation does not produce a
// translation; it produces text in the box, which FastShell's own two clocks
// then translate and bill exactly as if it had been typed. Finalized words go
// into `input`; the tentative tail is held OUTSIDE it so a hypothesis cannot
// start a translation (lib/fast/liveTranscript.ts). That is what makes a live
// mic affordable, and it is why this component asks for the box's setter
// rather than for a way to answer.

export interface FastMicDockProps {
  /** The pair on the pills — the recogniser is told to choose between them. */
  mine: LanguageCode;
  theirs: LanguageCode;
  /** The pinned direction, or null for Auto. A pin means one locale, not two. */
  explicitSource: LanguageCode | null;
  /**
   * The box's own setter.
   *
   * Blunt on purpose. Dictated words are appended to `input` by exactly the
   * same rule a keystroke follows, and handing the dock the setter is what
   * keeps `appendDictated` — and the rest of this file's imports — out of
   * FastShell, which is the whole point of the split.
   */
  setInput: Dispatch<SetStateAction<string>>;
  /** null clears whatever error is on screen. */
  onError: (message: string | null) => void;
  /**
   * The tentative tail, reported up.
   *
   * Only so the Clear button can see it: a box showing nothing but a tail is
   * still a box with something on it (lib/fast/clear.ts).
   */
  onPartialChange: (partial: string) => void;
  /**
   * Bumped when the screen wants the mic dropped — Clear, today.
   *
   * A counter rather than a registered callback: the parent owns when, the
   * dock owns how, and neither has to hold a ref into the other.
   */
  cancelSignal: number;
  /** The mic let go. The caller puts the caret back in the box. */
  onIdle: () => void;
}

export default function FastMicDock({
  mine,
  theirs,
  explicitSource,
  setInput,
  onError,
  onPartialChange,
  cancelSignal,
  onIdle
}: FastMicDockProps): JSX.Element {
  // One place where dictated words enter the box, whichever mic produced them.
  // APPENDED, never replacing (lib/fast/liveTranscript.ts): somebody who typed
  // half a phrase and then said the rest has not asked for the typed half to
  // be thrown away, and there is no undo on this screen.
  const commitDictated = useCallback(
    (heard: string) => {
      setInput((current) => appendDictated(current, heard, FAST_MAX_CHARS));
      onError(null);
    },
    [setInput, onError]
  );

  const receiveDictation = useCallback(
    async (blob: Blob, mimeType: string) => {
      const form = new FormData();
      // A filename with an extension the container matches: the transcriber
      // sniffs it, and a webm blob called .bin comes back "unsupported".
      // Three containers reach here, not two — wav is the salvaged PCM from a
      // streaming session whose socket went deaf (lib/fast/useLiveDictation.ts),
      // which is the only path that hands up audio this hook recorded itself.
      const ext = mimeType.includes("wav")
        ? "wav"
        : mimeType.includes("mp4") || mimeType.includes("aac")
          ? "mp4"
          : "webm";
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
        onError(e instanceof Error ? e.message : "Could not hear that.");
      }
    },
    [commitDictated, onError, mine, theirs]
  );

  // Which languages to tell Azure to listen for — and it is the SAME direction
  // decision FastShell's translate call makes, deliberately. Pinning the
  // direction does not just aim the translation; it tells the recogniser there
  // is nothing to identify, which measured ~800ms to first word against
  // ~2400ms for auto-detect (lib/fast/speechLocale.ts carries the table and
  // the reason the auto list is only ever the two pills).
  const candidates = useMemo(
    () => speechCandidates([mine, theirs], explicitSource),
    [mine, theirs, explicitSource]
  );

  const clearError = useCallback(() => onError(null), [onError]);

  const dictation = useLiveDictation({
    candidates,
    onSegment: commitDictated,
    onAudio: receiveDictation,
    onError,
    onStart: clearError
  });

  // The tail belongs to the hook and the Clear button needs to see it, so it is
  // mirrored up on every change rather than lifted into FastShell — which
  // would have put the streaming state back in the file this split exists to
  // keep clean. Reported "" on unmount so a mic that is flagged off mid-visit
  // cannot leave a stale tail behind it.
  useEffect(() => {
    onPartialChange(dictation.partial);
  }, [dictation.partial, onPartialChange]);
  useEffect(() => () => onPartialChange(""), [onPartialChange]);

  // Clear cancels the mic: a tail still arriving is text on its way into a box
  // somebody just emptied. The first render is not a cancel — the signal only
  // means anything once it has moved.
  const seenCancelRef = useRef(cancelSignal);
  const cancel = dictation.cancel;
  useEffect(() => {
    if (cancelSignal === seenCancelRef.current) return;
    seenCancelRef.current = cancelSignal;
    cancel();
  }, [cancelSignal, cancel]);

  // Put the caret back in the box when the mic lets go. The point of dictating
  // into a text FIELD rather than at a translator is that the next thing you
  // might do is fix a word — but only once, at the end: focusing on every
  // finalized segment would pop the keyboard up over the screen while somebody
  // is still talking into it.
  const dictating = dictation.state !== "idle";
  const wasDictatingRef = useRef(false);
  useEffect(() => {
    if (wasDictatingRef.current && !dictating) onIdle();
    wasDictatingRef.current = dictating;
  }, [dictating, onIdle]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        {/* Pointer events, not onClick: the button has to know the DIFFERENCE
            between a hold and a tap, and a click only ever reports that both
            happened. `touch-none` keeps a held finger from scrolling the page
            out from under itself, and the pointer capture keeps the release on
            this button even if the finger drifts off it mid-sentence — a
            walking thumb always drifts. */}
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

        {/* Only while it is listening. A permanent hint here would be one more
            thing between somebody and the word they wanted. */}
        {dictation.state === "recording" ? (
          <div
            role="status"
            aria-live="polite"
            className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-2xl border border-amber-300/25 bg-amber-400/10 px-3 py-2 text-sm text-amber-100/80"
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
          <p role="status" aria-live="polite" className="flex-1 text-sm text-amber-100/60">
            Writing it down… · Escribiéndolo…
          </p>
        ) : null}
      </div>

      {/* The tentative tail: words the recogniser is still reconsidering. Held
          outside `input` on purpose, and drawn dimmed so it does not read as
          settled text. No aria-live — a hypothesis changes several times a
          second, and announcing each one would make a screen reader unusable;
          the recording banner above is the status region, and the committed
          words are read normally once they land in the box. */}
      {dictation.mode === "stream" && dictation.partial ? (
        <p className="whitespace-pre-wrap break-words px-1 text-sm text-amber-100/40">
          {dictation.partial}
        </p>
      ) : null}
    </div>
  );
}
