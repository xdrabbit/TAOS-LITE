"use client";

import { useEffect, useState } from "react";

// One-time "add it to your home screen" nudge. Deliberately an inline banner in
// the normal flow rather than a floating overlay: the record button owns the
// bottom of the translator screen and nothing may sit on top of it.
//
// Two very different platforms:
// - Android/Chromium fires `beforeinstallprompt`, which we stash and replay
//   from a real tap, so the banner installs the app itself.
// - iOS Safari has no such event and never will. Installing is Share → "Add to
//   Home Screen", so there the banner can only say so. That is also the only
//   path on iPhones, which is what Tom and Liz carry.
const DISMISSED_KEY = "taos.install.dismissed";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  // iOS reports installed apps through a non-standard navigator flag; everyone
  // else answers the display-mode media query.
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone;
  return window.matchMedia?.("(display-mode: standalone)").matches === true || iosStandalone === true;
}

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  // iPadOS 13+ claims to be a Mac; the touch points give it away.
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  );
}

export function InstallPrompt(): JSX.Element | null {
  const [show, setShow] = useState(false);
  const [ios, setIos] = useState(false);
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    // Already installed, or told once already: never ask again.
    if (isStandalone()) return;
    try {
      if (window.localStorage.getItem(DISMISSED_KEY)) return;
    } catch {
      /* private mode — the nudge just isn't sticky */
    }

    const onIos = isIos();
    setIos(onIos);
    if (onIos) {
      setShow(true);
      return;
    }

    // Elsewhere, wait for the browser to say the app is actually installable
    // instead of advertising an option that might not exist.
    function onBeforeInstall(e: Event) {
      e.preventDefault(); // keep the browser's own mini-infobar from firing too
      setDeferred(e as BeforeInstallPromptEvent);
      setShow(true);
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstall);
  }, []);

  function dismiss() {
    setShow(false);
    try {
      window.localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      /* private mode — it will ask again next time */
    }
  }

  async function install() {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice.catch(() => null);
    dismiss(); // installed or declined, the banner has said its piece
  }

  if (!show) return null;

  return (
    <div className="flex items-center gap-3 rounded-2xl border border-amber-300/20 bg-amber-400/5 px-4 py-2.5 text-sm text-amber-100/80">
      <div className="flex-1">
        <p>Install TAOS on your phone 📲</p>
        <p className="text-xs text-amber-100/50">
          {ios
            ? "Share → Add to Home Screen · Compartir → Añadir a inicio"
            : "Full screen, one tap from your home screen · Pantalla completa"}
        </p>
      </div>
      {!ios && deferred ? (
        <button
          type="button"
          onClick={() => void install()}
          className="rounded-full bg-amber-400 px-3 py-1 text-xs font-semibold text-stone-950"
        >
          Install
        </button>
      ) : null}
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss install prompt / Descartar"
        className="text-lg leading-none text-amber-100/40 transition hover:text-amber-100/80"
      >
        ×
      </button>
    </div>
  );
}
