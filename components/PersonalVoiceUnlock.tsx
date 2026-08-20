"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearPersonalVoiceCode,
  isPersonalVoiceUnlocked,
  savePersonalVoiceCode,
  verifyPersonalVoiceCode
} from "@/lib/tts/personalVoiceClient";

// The way in is a gesture, not a button: five quick taps on the TAOS·LITE
// title. Nothing on screen advertises it, because the whole point of the gate
// is that the strangers TAOS gets handed to never learn the cloned voices
// exist. Tom and Liz type the code once per phone.

const TAPS_TO_OPEN = 5;
const TAP_WINDOW_MS = 1200; // taps must be deliberate, not spread over a minute

/**
 * Returns an onClick for whatever element carries the secret gesture. Taps
 * that fall outside the window reset the run, so ordinary stray taps on the
 * title never accumulate into an unlock prompt.
 */
export function useSecretTaps(onTrigger: () => void): () => void {
  const countRef = useRef(0);
  const lastRef = useRef(0);

  return useCallback(() => {
    const now = Date.now();
    countRef.current = now - lastRef.current > TAP_WINDOW_MS ? 1 : countRef.current + 1;
    lastRef.current = now;
    if (countRef.current >= TAPS_TO_OPEN) {
      countRef.current = 0;
      onTrigger();
    }
  }, [onTrigger]);
}

export function PersonalVoiceModal({
  open,
  onClose
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element | null {
  const [unlocked, setUnlocked] = useState(false);
  const [code, setCode] = useState("");
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);

  // Read localStorage on open, not at mount: the server render has no storage,
  // and re-reading keeps the sheet honest if another tab locked the device.
  useEffect(() => {
    if (!open) return;
    setUnlocked(isPersonalVoiceUnlocked());
    setCode("");
    setFailed(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const typed = code.trim();
    if (!typed || checking) return;
    setChecking(true);
    setFailed(false);
    // Verified server-side before storing, so a typo doesn't leave the phone
    // silently sending a dead code and wondering why the voice is stock.
    const ok = await verifyPersonalVoiceCode(typed);
    setChecking(false);
    if (!ok) {
      setFailed(true);
      return;
    }
    savePersonalVoiceCode(typed);
    setUnlocked(true);
    setCode("");
  }

  function lock() {
    clearPersonalVoiceCode();
    setUnlocked(false);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Personal voice"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6 backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative flex w-full max-w-sm flex-col gap-4 rounded-3xl border border-amber-300/20 bg-[rgba(20,16,14,0.98)] p-6 shadow-[0_10px_44px_rgba(0,0,0,0.6)]"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close / Cerrar"
          className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/5 text-lg leading-none text-amber-100/70 transition active:scale-95"
        >
          ×
        </button>

        <p className="pt-1 text-lg font-semibold text-amber-200">Personal voice</p>

        {unlocked ? (
          <>
            <p className="flex items-center gap-2 text-sm font-medium text-emerald-300">
              <span aria-hidden="true">✓</span> Unlocked on this phone
            </p>
            <p className="text-sm text-amber-100/60">
              Translations play in your own cloned voice here. Everyone else hears the
              standard voice.
            </p>
            <button
              type="button"
              onClick={lock}
              className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-amber-100/80 transition active:scale-95"
            >
              Lock this phone again
            </button>
          </>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3">
            <label htmlFor="personal-voice-code" className="text-sm text-amber-100/60">
              Enter the code to use your cloned voice on this phone.
            </label>
            <input
              id="personal-voice-code"
              type="password"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              // eslint-disable-next-line jsx-a11y/no-autofocus -- the sheet only
              // opens on a deliberate 5-tap gesture; the keyboard is the point.
              autoFocus
              className="rounded-2xl border border-white/10 bg-white/5 px-4 py-2.5 text-base text-amber-100 outline-none focus:border-amber-300/40"
            />
            {failed ? (
              <p className="text-sm text-red-300">That code didn&rsquo;t work.</p>
            ) : null}
            <button
              type="submit"
              disabled={checking || !code.trim()}
              className="rounded-full bg-amber-400 px-4 py-2 text-sm font-semibold text-stone-950 transition active:scale-95 disabled:opacity-40"
            >
              {checking ? "Checking…" : "Unlock"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
