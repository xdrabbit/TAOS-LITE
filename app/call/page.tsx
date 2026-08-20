import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CallShell } from "@/components/CallShell";
import { FounderGate } from "@/components/FounderGate";
import { callEnabled } from "@/lib/release";

// Same reason as /tutor: without this the route is statically prerendered and
// Next turns a build-time redirect() into an HTML shell that only bounces
// after hydration — no Location header, and a flash of a page that is meant
// to be gone. Dynamic rendering makes it a real 307 from the server.
export const dynamic = "force-dynamic";

// The redirect still streams a head, so the title is conditional too:
// `curl /call` and any link preview should not announce a screen RC1 does
// not have.
export function generateMetadata(): Metadata {
  if (!callEnabled()) return {};
  return {
    title: "Translated call · TAOS",
    description:
      "Call each other over wifi or cellular — video or voice-only — with a live AI interpreter and captions in each person's own language."
  };
}

export default function CallPage(): JSX.Element {
  // Off for RC1 (lib/release.ts): /call never got wired to the language
  // catalog, so it interprets into English or Spanish whatever pair the trip
  // is actually on. Hiding the nav link is not enough — /call?room=XYZ links
  // are the whole point of the screen and they live in people's messages.
  if (!callEnabled()) redirect("/");
  // Flag on: back to founders-only, the pre-RC1 behavior. /call bills two
  // realtime lines while connected and the cost guards still aren't in.
  return (
    <FounderGate>
      <CallShell />
    </FounderGate>
  );
}
