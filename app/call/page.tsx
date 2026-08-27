import type { Metadata } from "next";
import { CallShell } from "@/components/CallShell";
import { FounderGate } from "@/components/FounderGate";
import { callEnabled } from "@/lib/release";

// Dynamic because the metadata below reads a release flag, and a statically
// prerendered head would freeze whichever value was true at build time.
export const dynamic = "force-dynamic";

// `curl /call` and any link preview should not announce a screen customers do
// not have. Founders reaching it from the nav don't need a title to find it,
// and the room links they share with each other open the app either way.
export function generateMetadata(): Metadata {
  if (!callEnabled()) return {};
  return {
    title: "Translated call · TAOS",
    description:
      "Call each other over wifi or cellular — video or voice-only — with a live AI interpreter and captions in each person's own language."
  };
}

export default function CallPage(): JSX.Element {
  // Founders only (lib/release.ts). A stranger who taps a forwarded
  // /call?room=XYZ link gets bounced home rather than shown a card for a
  // screen they can't have — see FounderGate's `deny`.
  //
  // The gate that MATTERS is in app/api/call/realtime/route.ts: this one runs
  // in the browser off a client-held session, so it hides the screen without
  // defending it. Rendering CallShell without a founder's access token buys
  // you a 404 from the only route that spends money.
  return (
    <FounderGate publicRelease={callEnabled()} deny="home">
      <CallShell />
    </FounderGate>
  );
}
