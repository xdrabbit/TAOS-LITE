import type { Metadata } from "next";
import { DictateShell } from "@/components/DictateShell";
import { FounderGate } from "@/components/FounderGate";
import { dictateEnabled } from "@/lib/release";

// Dynamic because the metadata below reads a release flag, and a statically
// prerendered head would freeze whichever value was true at build time.
export const dynamic = "force-dynamic";

// A link preview should not announce a screen customers do not have yet.
export function generateMetadata(): Metadata {
  if (!dictateEnabled()) return {};
  return {
    title: "Dictate · TAOS",
    description: "Say it however it comes out and get clean, styled text back to copy or share."
  };
}

export default function DictatePage(): JSX.Element {
  // Founders only (lib/release.ts), bounced home like /fast and for the same
  // reason. This gate hides the screen; it does not defend it. The fence is
  // POST /api/dictate, which asks dictateVisibleTo() against a
  // server-validated token and answers anyone else with a 404.
  return (
    <FounderGate publicRelease={dictateEnabled()} deny="home">
      <DictateShell />
    </FounderGate>
  );
}
