import type { Metadata } from "next";
import { SessionGate } from "@/components/SessionGate";
import { TabletopShell } from "@/components/TabletopShell";
import { brainEnvDefault } from "@/lib/tabletop/brain";
import { tabletopAutoEnabled } from "@/lib/release";

export const metadata: Metadata = {
  title: "Tabletop · TAOS",
  description:
    "Lay the phone flat between two people — each end faces its reader, push to talk, and every turn is translated on screen and out loud."
};

export default function TabletopPage(): JSX.Element {
  // Customer-facing since 8/19 — no longer behind <FounderGate>. See the
  // /tabletop note in lib/release.ts for why it came out of HELD_BACK_V1.
  return (
    <SessionGate>
      {/* TAOS_TABLETOP_BRAIN is server-only; it reaches the shell as a prop,
          and only a founder's shell ever reads it (lib/tabletop/brain.ts). */}
      {/* TAOS_TABLETOP_AUTO_ENABLED is server-only too; the shell shows the
          auto-detect toggle only when this is true AND the user is a founder. */}
      <TabletopShell defaultBrain={brainEnvDefault()} autoEnabled={tabletopAutoEnabled()} />
    </SessionGate>
  );
}
