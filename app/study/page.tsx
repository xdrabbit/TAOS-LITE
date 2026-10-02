import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { StudyShell } from "@/components/StudyShell";
import { studyEnabled } from "@/lib/release";

// Same shape as app/tutor/page.tsx, for the same reasons: force-dynamic so a
// build-time redirect() is a real 307 rather than a flash of a page that is
// supposed to be gone, and a conditional title so `curl /study` and a link
// preview don't announce a screen the flag has not opened.
export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  if (!studyEnabled()) return {};
  return {
    title: "TAOS·STUDY — lessons from your own conversations",
    description: "Pick a line you actually said, and learn why the words go in that order."
  };
}

export default function StudyPage(): JSX.Element {
  // Dark until NEXT_PUBLIC_ENABLE_STUDY is set (lib/release.ts). Redirect home
  // rather than render a "coming soon" card — there is nothing to wait for on
  // a dead-end page, and a dead-end page is a support email.
  if (!studyEnabled()) redirect("/");
  return <StudyShell />;
}
