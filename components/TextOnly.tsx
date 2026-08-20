import { TEXT_ONLY_TITLE } from "@/lib/tts/speech";

// The two shapes "text only" takes on screen, so no screen invents a third.
//
// A tier-2 language (lib/languages/catalog.ts) is translated but never spoken.
// Both of these say so BEFORE anyone taps something that would have played
// audio — a silent Play button reads as a broken app, and an error afterwards
// reads as a broken language. Neither is true: this is a known limit of what
// ElevenLabs can pronounce, met up front.

/** List-row marking — the language sheet, and any picker that grows one. */
export function TextOnlyChip(): JSX.Element {
  return (
    <span
      title={TEXT_ONLY_TITLE}
      className="shrink-0 rounded-full border border-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-100/50"
    >
      Text only
    </span>
  );
}

/**
 * What stands where a Play button would have been. `className` carries the
 * palette of the surface it sits on (a /chat bubble is amber, a /translate
 * turn is green) — everything else about it stays the same everywhere.
 */
export function TextOnlyNote({ className }: { className?: string }): JSX.Element {
  return (
    <span
      title={TEXT_ONLY_TITLE}
      aria-label={TEXT_ONLY_TITLE}
      className={`flex items-center gap-1 rounded-full ${
        className ?? "border border-white/10 bg-white/5 px-3 py-1 text-emerald-100/60"
      }`}
    >
      <span className="text-base">🔇</span>
      <span className="text-[11px]">Text only · Solo texto</span>
    </span>
  );
}
