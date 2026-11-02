import type { Metadata } from "next";
import { WalkieGate } from "@/components/walkie/WalkieGate";
import { WalkieShell } from "@/components/walkie/WalkieShell";
import { walkieEnabled, walkieMaxTurnMs, walkieRetentionDays } from "@/lib/walkie/flag";

// /taokie — the push-to-talk translation walkie (founders-only P0 spike,
// 2026-11-01). Hold the button, talk, let go: the turn goes through the home
// pipeline and plays on the partner's phone in the partner's language.
//
// Dynamic because TAOS_WALKIE_ENABLED is a SERVER flag read per request —
// not NEXT_PUBLIC_, so it never reaches a bundle, and a prerendered page
// would freeze whatever it was at build time. The two knobs ride along as
// props for the same reason.
export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  // Never indexed, and no title to announce it while it is switched off.
  if (!walkieEnabled()) return { robots: { index: false, follow: false } };
  return { title: "Taokie · TAOS", robots: { index: false, follow: false } };
}

export default function TaokiePage(): JSX.Element {
  return (
    <WalkieGate enabled={walkieEnabled()}>
      <WalkieShell maxTurnMs={walkieMaxTurnMs()} retentionDays={walkieRetentionDays()} />
    </WalkieGate>
  );
}
