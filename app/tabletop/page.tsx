import type { Metadata } from "next";
import { FounderGate } from "@/components/FounderGate";
import { TabletopShell } from "@/components/TabletopShell";

export const metadata: Metadata = {
  title: "Tabletop · TAOS",
  description:
    "Lay the phone flat between two people — each end faces its reader, push to talk, and every turn is translated on screen and out loud."
};

export default function TabletopPage(): JSX.Element {
  // Held back from v1 (lib/release.ts).
  return (
    <FounderGate>
      <TabletopShell />
    </FounderGate>
  );
}
