"use client";

import { useEffect, useState } from "react";
import type { ChromeCopy } from "@/lib/chrome/copy";
import {
  installAction,
  iosShareGuide,
  isIosUserAgent,
  type InstallAction,
  type ShareGuide
} from "@/lib/install/action";

// One-time "add it to your phone" nudge. Deliberately an inline banner in the
// normal flow rather than a floating overlay: the record button owns the
// bottom of the translator screen and nothing may sit on top of it.
//
// Two very different platforms:
// - Android/Chromium fires `beforeinstallprompt`, which we stash and replay
//   from a real tap, so the banner installs the app itself.
// - iOS has no such event and never will. Installing is Share → "Add to Home
//   Screen", done by hand in Safari's own menus. That is the only path on
//   iPhones, which is what Tom and Liz carry.
//
// The button must never be a dead click (Tom, 2026-11-25: "Install does
// nothing"), and on an iPhone it must not just SAY "tap Share" (Liz, the same
// day: that is no help if you cannot find Share). So on iOS the banner opens
// a picture guide: one short action per card, a drawing of the button on
// every card, and a bouncing arrow at the edge of the page nearest the real
// Safari button. Where that button is depends on the Safari version; see
// iosShareGuide in lib/install/action.ts.
//
// Its words come from the phone owner's copy (lib/chrome/copy.ts).
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
  | "installShowMe"
  | "installDismiss"
  | "installSheetTitle"
  | "installPointerDown"
  | "installPointerUp"
  | "installStepMore"
  | "installStepMoreHint"
  | "installStepShare"
  | "installStepShareHint"
  | "installStepAdd"
  | "installStepAddHint"
  | "installStepConfirm"
  | "installStepConfirmHint"
  | "installAddWord"
  | "installNotSafariTitle"
  | "installNotSafariWhy"
  | "installStepCopy"
  | "installCopyLink"
  | "installCopied"
  | "installCopyFailed"
  | "installStepOpenSafari"
  | "installStepPaste"
  | "installGeneric"
  | "close"
>;

// ── The drawings ──────────────────────────────────────────────────────────
// Line drawings of the buttons to look for, drawn here (no emoji, no
// screenshots of Apple's UI). `data-install-icon` names each one for tests.
type IconName = "more" | "share" | "add-square" | "check" | "copy" | "safari" | "paste";

function Icon({ name, className = "h-7 w-7" }: { name: IconName; className?: string }): JSX.Element {
  const common = {
    "aria-hidden": true,
    "data-install-icon": name,
    viewBox: "0 0 24 24",
    className: `shrink-0 ${className}`,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.9,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const
  };
  switch (name) {
    case "more":
      return (
        <svg {...common}>
          <circle cx="5.5" cy="12" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="18.5" cy="12" r="1.6" fill="currentColor" stroke="none" />
        </svg>
      );
    case "share":
      return (
        <svg {...common}>
          <path d="M12 15V3" />
          <path d="M8 7l4-4 4 4" />
          <path d="M8 11H7a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1" />
        </svg>
      );
    case "add-square":
      return (
        <svg {...common}>
          <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" />
          <path d="M12 8v8M8 12h8" />
        </svg>
      );
    case "check":
      return (
        <svg {...common}>
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      );
    case "copy":
      return (
        <svg {...common}>
          <rect x="8.5" y="8.5" width="12" height="12" rx="2.5" />
          <path d="M15.5 8.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5" />
        </svg>
      );
    case "safari":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M15.5 8.5l-2 5-5 2 2-5z" />
        </svg>
      );
    case "paste":
      return (
        <svg {...common}>
          <rect x="5" y="4.5" width="14" height="16" rx="2.5" />
          <rect x="9" y="2.5" width="6" height="4" rx="1.2" />
          <path d="M9 12h6M9 16h4" />
        </svg>
      );
  }
}

/** A light tile, the way the button looks on the phone, with its drawing. */
function IconTile({ name }: { name: IconName }): JSX.Element {
  return (
    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white text-stone-900 shadow-[0_0_0_2px_rgba(251,191,36,0.55)]">
      <Icon name={name} />
    </span>
  );
}

interface Step {
  /** Names the card for tests; the drawing unless `word` replaces it. */
  icon: IconName | "add-word";
  /** A button that is a word on the phone ("Add"), drawn as that word. */
  word?: string;
  text: string;
  hint?: string;
  /** A second drawing shown after the hint ("…tap this one: [share]"). */
  hintIcon?: IconName;
  extra?: JSX.Element;
}

function StepCard({ n, step }: { n: number; step: Step }): JSX.Element {
  return (
    <li
      data-install-step={step.icon}
      className="flex items-center gap-3 rounded-2xl border border-orange-400/30 bg-white/[0.04] px-3 py-2.5"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-orange-500 text-base font-bold text-black">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-lg font-semibold leading-snug text-white">{step.text}</p>
        {step.hint ? (
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[13px] leading-snug text-amber-200/75">
            <span>{step.hint}</span>
            {step.hintIcon ? (
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-white text-stone-900">
                <Icon name={step.hintIcon} className="h-4 w-4" />
              </span>
            ) : null}
          </p>
        ) : null}
        {step.extra}
      </div>
      {step.icon === "add-word" ? (
        <span
          data-install-icon="add-word"
          aria-hidden="true"
          className="flex h-12 shrink-0 items-center justify-center rounded-2xl bg-white px-3 text-base font-bold text-sky-600 shadow-[0_0_0_2px_rgba(251,191,36,0.55)]"
        >
          {step.word}
        </span>
      ) : (
        <IconTile name={step.icon} />
      )}
    </li>
  );
}

// The arrow that points OUT of the page, at Safari's own button. It sits in
// the strip of the sheet that touches that edge of the screen: bottom right
// for the ••• of Safari 26, bottom center for the Share of older Safari, top
// right on an iPad. Still for people who ask for less motion.
function Pointer({ where, label }: { where: "bottom-right" | "bottom-center" | "top-right"; label: string }): JSX.Element {
  const up = where === "top-right";
  // Bottom center: the ARROW is centered (the label sits above it), because
  // it is the arrow that has to line up with Safari's Share button.
  const center = where === "bottom-center";
  const row = center ? "flex-col justify-center gap-1" : where === "bottom-right" ? "justify-end gap-2 pr-3" : "justify-end gap-2 pr-24";
  return (
    <div data-install-pointer={where} className={`flex shrink-0 items-center ${row}`}>
      <span className="rounded-full bg-amber-300 px-3 py-1 text-sm font-bold text-black">{label}</span>
      <span data-install-arrow className="relative flex h-11 w-11 items-center justify-center">
        <span className="absolute inset-0 rounded-full bg-orange-500/50 motion-safe:animate-ping" />
        <span className="relative flex h-11 w-11 items-center justify-center rounded-full bg-orange-500 text-black motion-safe:animate-bounce">
          <svg aria-hidden="true" viewBox="0 0 24 24" className={`h-7 w-7 ${up ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 4v15" />
            <path d="M5.5 13l6.5 6.5 6.5-6.5" />
          </svg>
        </span>
      </span>
    </div>
  );
}

/** Copy the app's address, so nobody has to type it into Safari. */
function CopyLink({ copy }: { copy: InstallCopy }): JSX.Element {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const url = typeof window === "undefined" ? "https://taoslite.com" : window.location.origin;
  const shown = url.replace(/^https?:\/\//, "");

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(url);
      setState("copied");
    } catch {
      // An in-app browser may refuse the clipboard. Show the address to type.
      setState("failed");
    }
  }

  return (
    <div className="mt-2 flex flex-col items-start gap-1.5">
      <button
        type="button"
        onClick={() => void onCopy()}
        className="flex items-center gap-2 rounded-full bg-orange-500 px-4 py-2 text-base font-bold text-black active:bg-orange-400"
      >
        <Icon name={state === "copied" ? "check" : "copy"} className="h-5 w-5" />
        {state === "copied" ? copy.installCopied : copy.installCopyLink}
      </button>
      <p role="status" className="text-[13px] leading-snug text-amber-200/75">
        {state === "failed" ? (
          <>
            {copy.installCopyFailed} <span className="select-all font-semibold text-white">{shown}</span>
          </>
        ) : (
          <span className="select-all">{shown}</span>
        )}
      </p>
    </div>
  );
}

// The guide. A bottom sheet on a phone (so its arrow touches Safari's bottom
// bar), a top sheet on an iPad (whose Share is at the top). It only opens
// from a tap and closes on the backdrop, Close or Escape, so it never sits
// over the record button uninvited.
function InstallSheet({
  kind,
  guide,
  copy,
  onClose
}: {
  kind: SheetKind;
  guide: ShareGuide;
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

  const addSteps: Step[] = [
    { icon: "add-square", text: copy.installStepAdd, hint: copy.installStepAddHint },
    { icon: "add-word", word: copy.installAddWord, text: copy.installStepConfirm, hint: copy.installStepConfirmHint }
  ];
  let steps: Step[] = [];
  let pointer: "bottom-right" | "bottom-center" | "top-right" | null = null;
  let title = copy.installSheetTitle;

  if (kind === "ios-safari") {
    if (guide.device === "ipad") {
      pointer = "top-right";
      steps = [{ icon: "share", text: copy.installStepShare, hint: copy.installStepShareHint }, ...addSteps];
    } else if (guide.viaMore) {
      pointer = "bottom-right";
      steps = [
        { icon: "more", text: copy.installStepMore, hint: copy.installStepMoreHint, hintIcon: "share" },
        { icon: "share", text: copy.installStepShare },
        ...addSteps
      ];
    } else {
      pointer = "bottom-center";
      steps = [{ icon: "share", text: copy.installStepShare }, ...addSteps];
    }
  } else if (kind === "ios-other") {
    title = copy.installNotSafariTitle;
    steps = [
      { icon: "copy", text: copy.installStepCopy, extra: <CopyLink copy={copy} /> },
      { icon: "safari", text: copy.installStepOpenSafari },
      { icon: "paste", text: copy.installStepPaste }
    ];
  }

  const top = pointer === "top-right";
  const pointerEl = pointer ? (
    <Pointer where={pointer} label={top ? copy.installPointerUp : copy.installPointerDown} />
  ) : null;

  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col bg-black/75 ${top ? "justify-start" : "justify-end"}`}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-install-sheet={kind}
    >
      {/* The arrow stays pinned to the screen edge; only the cards scroll,
          so a short phone never scrolls the arrow away from the button. */}
      <div
        onClick={(e) => e.stopPropagation()}
        className={`flex max-h-[100dvh] flex-col gap-3 border-orange-500/60 bg-black px-4 ${
          top
            ? "rounded-b-3xl border-b-2 pb-5 pt-[calc(env(safe-area-inset-top)+0.5rem)]"
            : `rounded-t-3xl border-t-2 pt-4 ${pointer ? "pb-[calc(env(safe-area-inset-bottom)+0.5rem)]" : "pb-[calc(env(safe-area-inset-bottom)+1.25rem)]"}`
        }`}
      >
        {top ? pointerEl : null}
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2.5 text-lg font-bold leading-tight text-white">
              <AppIcon size="h-9 w-9" />
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded-full border border-white/20 bg-white/10 px-3.5 py-1.5 text-sm font-medium text-white"
            >
              {copy.close}
            </button>
          </div>

          {kind === "ios-other" ? <p className="text-sm text-amber-200/80">{copy.installNotSafariWhy}</p> : null}

          {kind === "generic" ? (
            <p className="pb-4 text-base leading-relaxed text-white/90">{copy.installGeneric}</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {steps.map((step, i) => (
                <StepCard key={step.icon} n={i + 1} step={step} />
              ))}
            </ol>
          )}
        </div>
        {top ? null : pointerEl}
      </div>
    </div>
  );
}

function AppIcon({ size }: { size: string }): JSX.Element {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/icons/icon-192.png" alt="" className={`${size} shrink-0 rounded-[22%]`} />
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
  const [guide, setGuide] = useState<ShareGuide>({ device: "iphone", viaMore: true });

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
      setGuide(iosShareGuide(navigator.userAgent));
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
    <div className="flex items-center gap-3 rounded-2xl border border-orange-500/50 bg-black px-3 py-2.5 text-sm">
      <AppIcon size="h-10 w-10" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold leading-tight text-white">{copy.installTitle}</p>
        <p className="mt-0.5 text-xs leading-snug text-amber-200/70">{ios ? copy.installHowIos : copy.installHowOther}</p>
      </div>
      {ios || deferred ? (
        <button
          type="button"
          onClick={() => void install()}
          className="shrink-0 rounded-full bg-orange-500 px-3.5 py-2 text-sm font-bold text-black active:bg-orange-400"
        >
          {ios ? copy.installShowMe : copy.install}
        </button>
      ) : null}
      <button
        type="button"
        onClick={dismiss}
        aria-label={copy.installDismiss}
        className="-mr-1 shrink-0 px-1 text-xl leading-none text-white/40 transition hover:text-white/80"
      >
        ×
      </button>
      {sheet ? <InstallSheet kind={sheet} guide={guide} copy={copy} onClose={() => setSheet(null)} /> : null}
    </div>
  );
}
