import type { Metadata } from "next";
import { CallShell } from "@/components/CallShell";
import { FounderGate } from "@/components/FounderGate";

export const metadata: Metadata = {
  title: "Translated call · TAOS",
  description:
    "Call each other over wifi or cellular — video or voice-only — with a live AI interpreter and captions in each person's own language."
};

export default function CallPage(): JSX.Element {
  // Held back from v1 (lib/release.ts): /call bills two realtime lines while
  // connected — not sellable until the cost guards land.
  return (
    <FounderGate>
      <CallShell />
    </FounderGate>
  );
}
