"use client";

import { useEffect, useState } from "react";
import type { ChromeCopy } from "@/lib/chrome/copy";
import { installAction, isIosUserAgent, type InstallAction } from "@/lib/install/action";

// One-time "add it to your home screen" nudge. Deliberately an inline banner in
// the normal flow rather than a floating overlay: the record button owns the
// bottom of the translator screen and nothing may sit on top of it.
//
// Two very different platforms:
// - Android/Chromium fires `beforeinstallprompt`, which we stash and replay
//   from a real tap, so the banner installs the app itself.
// - iOS Safari has no such event and never will. Installing is Share → "Add to
//   Home Screen", so there the Install button opens a sheet that walks it,
//   step by step. That is also the only path on iPhones, which is what Tom
//   and Liz carry.
//
// The button must never be a dead click (Tom, 2026-11-25: "Install does
// nothing"). The handler used to be `if (!deferred) return;`, and an iPhone
// got no button at all — just the five-word hint. Now lib/install/action.ts
// decides what a tap does, and every answer is something on screen.
//
// Its words come from the phone owner's copy (lib/chrome/copy.ts). It was
// English with a Spanish tail glued on until 2026-10-04 — "Install TAOS on
// your phone" over "… · Pantalla completa" — so neither reader got a whole
// sentence in their own language.
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
  return isIosUserAgent(navigator.userAgent, navigator.maxTouchPoints);
}

type SheetKind = Exclude<InstallAction, "installed" | "prompt">;

type InstallCopy = Pick<
  ChromeCopy,
  | "installTitle"
  | "installHowIos"
  | "installHowOther"
  | "install"
  | "installDismiss"
  | "installSheetTitle"
  | "installIosStep1"
  | "installIosStep2"
  | "installIosStep3"
  | "installIosNotSafari"
  | "installGeneric"
  | "close"
>;

/** The iOS Share glyph, so step 1 shows the thing to look for. */
function ShareGlyph(): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="inline-block h-5 w-5 shrink-0 text-sky-300"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 15V3" />
      <path d="M8 7l4-4 4 4" />
      <path d="M7 11H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1" />
    </svg>
  );
}

// The how-to sheet: same bottom-sheet shape as the language picker
// (components/LanguagePicker.tsx). It only opens from a tap and closes on the
// backdrop, Close or Escape, so it never sits over the record button uninvited.
function InstallSheet({
  kind,
  copy,
  onClose
}: {
  kind: SheetKind;
  copy: InstallCopy;
  onClose: () => void;
}): JSX.Element {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const steps = [copy.installIosStep1, copy.installIosStep2, copy.installIosStep3];

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end bg-black/70"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={copy.installSheetTitle}
      data-install-sheet={kind}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex flex-col gap-4 rounded-t-3xl border-t border-amber-300/20 bg-[rgba(28,23,19,0.98)] p-5 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-amber-100">{copy.installSheetTitle}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-amber-100/70"
          >
            {copy.close}
          </button>
        </div>

        {kind === "generic" ? (
          <p className="text-sm leading-relaxed text-amber-50/85">{copy.installGeneric}</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {steps.map((step, i) => (
              <li key={step} className="flex items-start gap-3 text-sm leading-relaxed text-amber-50/85">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-400 text-xs font-semibold text-stone-950">
                  {i + 1}
                </span>
                <span className="flex-1">{step}</span>
                {i === 0 ? <ShareGlyph /> : null}
              </li>
            ))}
          </ol>
        )}

        {kind === "ios-other" ? (
          <p className="rounded-2xl border border-amber-300/20 bg-amber-400/5 px-3 py-2 text-xs leading-relaxed text-amber-100/70">
            {copy.installIosNotSafari}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function InstallPrompt({
  copy
}: {
  copy: InstallCopy;
}): JSX.Element | null {
  const [show, setShow] = useState(false);
  const [ios, setIos] = useState(false);
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [sheet, setSheet] = useState<SheetKind | null>(null);

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
    // Decided at the tap, from the browser as it is right now.
    const action = installAction({
      standalone: isStandalone(),
      userAgent: navigator.userAgent,
      maxTouchPoints: navigator.maxTouchPoints,
      hasPrompt: deferred !== null
    });
    if (action === "installed") {
      setShow(false);
      return;
    }
    if (action !== "prompt" || !deferred) {
      setSheet(action === "prompt" ? "generic" : action);
      return;
    }
    try {
      await deferred.prompt();
    } catch {
      // A prompt can be replayed once; a spent or refused one throws. Say how
      // to do it by hand rather than swallow the tap.
      setSheet("generic");
      return;
    }
    await deferred.userChoice.catch(() => null);
    dismiss(); // installed or declined, the banner has said its piece
  }

  if (!show) return null;

  return (
    <div className="flex items-center gap-3 rounded-2xl border border-amber-300/20 bg-amber-400/5 px-4 py-2.5 text-sm text-amber-100/80">
      <div className="flex-1">
        <p>{copy.installTitle}</p>
        <p className="text-xs text-amber-100/50">{ios ? copy.installHowIos : copy.installHowOther}</p>
      </div>
      {ios || deferred ? (
        <button
          type="button"
          onClick={() => void install()}
          className="rounded-full bg-amber-400 px-3 py-1 text-xs font-semibold text-stone-950"
        >
          {copy.install}
        </button>
      ) : null}
      <button
        type="button"
        onClick={dismiss}
        aria-label={copy.installDismiss}
        className="text-lg leading-none text-amber-100/40 transition hover:text-amber-100/80"
      >
        ×
      </button>
      {sheet ? <InstallSheet kind={sheet} copy={copy} onClose={() => setSheet(null)} /> : null}
    </div>
  );
}
