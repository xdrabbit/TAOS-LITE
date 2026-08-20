"use client";

import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { GUIDE_PATH, GUIDE_TITLE } from "@/lib/guide";

// The QR sheet. Two things use it now, and they want the same object for
// different reasons:
//
//   /translate — "scan to get TAOS", pointed at production forever. The person
//                scanning is a stranger across a table and a preview-deploy or
//                localhost URL would be useless (or unreachable) to them, so
//                this one never reads window.location.origin.
//   /chat      — an invite link, which is the opposite: it MUST be the
//                deployment the inviter is standing on, and it carries a
//                one-use token, so it is passed in (minted server-side, fenced
//                by the same origin allow-list as sign-in).
//
// Hence the props. Everything defaults to the /translate behaviour, so that
// call site reads exactly as it did before this file learned a second job.
const SHARE_URL = "https://taoslite.com";

export interface QrShareModalProps {
  open: boolean;
  onClose: () => void;
  /** What the QR encodes and the copy button copies. */
  url?: string;
  /** The line above the code. */
  title?: string;
  /** Its Spanish half, under the code. */
  subtitle?: string;
  /** What to print under the code instead of the raw URL. */
  display?: string;
  /** An optional sentence between the title and the code. */
  blurb?: string;
  /** Optional small print under the link — expiry, one-person-only, that sort. */
  note?: string;
  /** A "copy link" button, for a URL nobody could retype from a screen. */
  copyLabel?: string;
  copiedLabel?: string;
  /** The quick-start link under the code. Pass null to leave it off. */
  guideHref?: string | null;
}

export function QrShareModal({
  open,
  onClose,
  url = SHARE_URL,
  title = "Scan to get TAOS",
  subtitle = "Escanea para obtener TAOS",
  display,
  blurb,
  note,
  copyLabel,
  copiedLabel = "Copied · Copiado",
  guideHref = GUIDE_PATH
}: QrShareModalProps): JSX.Element | null {
  const [copied, setCopied] = useState(false);

  // Escape closes, matching the header menus in TranslatorShell. Only wired
  // while open so there's no idle global listener.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  // A fresh sheet is never already-copied — the label is about THIS link.
  useEffect(() => {
    if (!open) setCopied(false);
  }, [open]);

  if (!open) return null;

  async function copy() {
    // Two ways, because the modern one needs a secure context and the share
    // sheet is exactly where a phone that half-supports it turns up. Failing
    // silently is fine: the link is on screen underneath either way.
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      try {
        await navigator.share?.({ url });
      } catch {
        /* dismissed or unsupported — the link is printed below */
      }
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      // The backdrop closes on tap; the card stops propagation so tapping the
      // QR itself (the thing people crowd around) never dismisses it.
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6 backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative flex w-full max-w-sm flex-col items-center gap-4 rounded-3xl border border-amber-300/20 bg-[rgba(20,16,14,0.98)] p-6 shadow-[0_10px_44px_rgba(0,0,0,0.6)]"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close / Cerrar"
          className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/5 text-lg leading-none text-amber-100/70 transition active:scale-95"
        >
          ×
        </button>

        <p className="pt-1 text-center text-lg font-semibold text-amber-200">{title}</p>

        {blurb ? (
          <p className="-mt-2 text-center text-xs leading-snug text-amber-100/60">{blurb}</p>
        ) : null}

        {/* White plate around the code: QR scanners need a light quiet zone,
            and the app's dark UI would otherwise run right up to the modules.
            The SVG is rendered large and scaled by CSS, so it stays crisp at
            whatever width the phone gives it — big enough to scan from across
            a dinner table. */}
        <div className="w-[min(72vw,17rem)] rounded-2xl bg-white p-4">
          <QRCodeSVG
            value={url}
            size={512}
            level="M"
            marginSize={1}
            title={display ?? url}
            className="h-auto w-full"
          />
        </div>

        <div className="w-full text-center">
          {subtitle ? <p className="text-sm text-amber-100/70">{subtitle}</p> : null}
          <p className="mt-1 break-all text-sm font-medium tracking-wide text-amber-200">
            {display ?? url}
          </p>
          {note ? <p className="mt-2 text-[11px] text-amber-100/45">{note}</p> : null}
          {copyLabel ? (
            <button
              type="button"
              onClick={() => void copy()}
              className="mt-3 w-full rounded-2xl border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-medium text-amber-100/85 transition active:scale-[0.99]"
            >
              {copied ? copiedLabel : copyLabel}
            </button>
          ) : null}

          {/* The quick start rides along with the code. This sheet is the
              moment TAOS is handed to someone who has never seen it — across
              a table, or as a chat invite — and the instructions were being
              given out loud, once per stranger, or not at all. Opened in a
              new tab so a half-finished invite (the link above carries a
              one-use token) is still on screen behind it. */}
          {guideHref ? (
            <a
              href={guideHref}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 block text-xs text-amber-100/50 underline underline-offset-2"
            >
              {GUIDE_TITLE}
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}
