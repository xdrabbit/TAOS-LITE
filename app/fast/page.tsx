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
  // Founders only (lib/release.ts). "coming-soon" rather than /call's bounce:
  // you only reach /fast by opening the grid menu, so a card is an answer to a
  // question somebody asked, not a dead end they were forwarded into.
  //
  // The gate that MATTERS is in app/api/fast/route.ts: this one runs in the
  // browser off a client-held session, so it hides the screen without
  // defending it. Rendering FastShell without a founder's access token buys
  // you a 404 from the only route that spends money.
  return (
    <FounderGate publicRelease={fastEnabled()}>
      <FastShell />
    </FounderGate>
  );
}
