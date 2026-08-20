import type { Metadata } from "next";
import { SessionGate } from "@/components/SessionGate";
import { TabletopShell } from "@/components/TabletopShell";

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
      <TabletopShell />
    </SessionGate>
  );
}
