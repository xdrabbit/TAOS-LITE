"use client";

import { useEffect } from "react";
import { QRCodeSVG } from "qrcode.react";

// The QR always points at production, never window.location.origin: the person
// scanning it is a stranger across a table, and a preview-deploy or localhost
// URL would be useless (or unreachable) to them.
const SHARE_URL = "https://taoslite.com";

export function QrShareModal({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
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

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Share TAOS"
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

        <p className="pt-1 text-center text-lg font-semibold text-amber-200">
          Scan to get TAOS
        </p>

        {/* White plate around the code: QR scanners need a light quiet zone,
            and the app's dark UI would otherwise run right up to the modules.
            The SVG is rendered large and scaled by CSS, so it stays crisp at
            whatever width the phone gives it — big enough to scan from across
            a dinner table. */}
        <div className="w-[min(72vw,17rem)] rounded-2xl bg-white p-4">
          <QRCodeSVG
            value={SHARE_URL}
            size={512}
            level="M"
            marginSize={1}
            title="TAOS — taoslite.com"
            className="h-auto w-full"
          />
        </div>

        <div className="text-center">
          <p className="text-sm text-amber-100/70">Escanea para obtener TAOS</p>
          <p className="mt-1 text-sm font-medium tracking-wide text-amber-200">taoslite.com</p>
        </div>
      </div>
    </div>
  );
}
