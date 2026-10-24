import type { Metadata } from "next";
import { DemoGate } from "@/components/demo/DemoGate";
import { DemoShell } from "@/components/demo/DemoShell";
import { demoEnabled } from "@/lib/demo/server";

// /demo — "Tu voz": founders-only sidewalk demo. A stranger records ~45 s, an
// instant clone speaks the other language in their voice, and the clone is
// deleted (lib/demo/server.ts).
//
// Dynamic because TAOS_DEMO_ENABLED is a SERVER flag read per request — it is
// not NEXT_PUBLIC_, so it never reaches a bundle, and a prerendered page
// would freeze whatever it was at build time.
export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  // Never indexed, and no title to announce it while it is switched off.
  if (!demoEnabled()) return { robots: { index: false, follow: false } };
  return { title: "Tu voz · TAOS", robots: { index: false, follow: false } };
}

export default function DemoPage(): JSX.Element {
  return (
    <DemoGate enabled={demoEnabled()}>
      <DemoShell />
    </DemoGate>
  );
}
