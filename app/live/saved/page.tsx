import type { Metadata } from "next";
import { SessionGate } from "@/components/SessionGate";
import { SavedLiveShell } from "@/components/live/SavedLiveShell";

// /live/saved — the /live conversations a user chose to save (Tom and Liz,
// 2026-11-17): list them, read one, export it as text, delete it. Text only,
// kept until deleted.
//
// Its own route, under /live, rather than a section of /review: /review is
// the founders' audio-review bench (its routes 404 for everyone else and its
// rows expire after 14 days), and this is a user's own data, which
// TAOS_LIVE_SAVE can open to subscribers or everyone without a deploy. Sign-in
// is the only gate here — what somebody saved stays theirs to read and delete.
export function generateMetadata(): Metadata {
  return { title: "Saved conversations · TAOS", robots: { index: false, follow: false } };
}

export default function SavedLivePage(): JSX.Element {
  return (
    <SessionGate>
      <SavedLiveShell />
    </SessionGate>
  );
}
