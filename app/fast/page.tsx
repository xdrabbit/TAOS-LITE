import type { Metadata } from "next";
import { FastShell } from "@/components/FastShell";
import { FounderGate } from "@/components/FounderGate";
import { fastEnabled } from "@/lib/release";

// Dynamic because the metadata below reads a release flag, and a statically
// prerendered head would freeze whichever value was true at build time.
export const dynamic = "force-dynamic";

// `curl /fast` and any link preview should not announce a screen customers do
// not have yet. Founders reach it from the grid menu and do not need a title
// to find it.
export function generateMetadata(): Metadata {
  if (!fastEnabled()) return {};
  return {
    title: "Quick translate · TAOS",
    description:
      "Type and read it back instantly — a plain, word-for-word translation that appears as you type."
  };
}

export default function FastPage(): JSX.Element {
  // Founders only (lib/release.ts), bounced home rather than shown a card —
  // the same `deny` /call uses. A quickie box is the sort of screen whose URL
  // gets pasted into a message ("try this"), and a stranger who taps a
  // forwarded one should land on TAOS proper, not on an advert for a screen
  // they cannot open.
  //
  // ── Why this is not a 307 ──────────────────────────────────────────────
  // /tutor bounces with a real server-side `redirect()`, and it can, because
  // `tutorEnabled()` is an environment flag the server can read on its own.
  // This gate is `fastVisibleTo(EMAIL)`, and the email lives in a Supabase
  // session that is persisted CLIENT-side (lib/supabase.ts) — a server
  // component here has no cookie to read and cannot tell a founder from
  // anybody else. So the bounce is FounderGate's `router.replace("/")`: same
  // destination, no Location header, one frame of "Loading…" on the way.
  //
  // Which is fine, because this gate was never the fence. The fence is in
  // app/api/fast/route.ts, which re-asks the same question against a
  // server-validated access token and answers a stranger with a 404.
  // Rendering FastShell by hand gets you a screen that cannot translate.
  return (
    <FounderGate publicRelease={fastEnabled()} deny="home">
      <FastShell />
    </FounderGate>
  );
}
