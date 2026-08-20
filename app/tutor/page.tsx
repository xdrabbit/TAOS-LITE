import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { TutorShell } from "@/components/TutorShell";
import { tutorEnabled } from "@/lib/release";

// Without this the route is statically prerendered, and Next turns a
// build-time redirect() into an HTML shell that only bounces AFTER hydration:
// no Location header, and a visible flash of a page that is supposed to be
// gone. Dynamic rendering makes it a real 307 from the server instead.
export const dynamic = "force-dynamic";

// The redirect still streams a head, so the title has to be conditional too —
// otherwise `curl /tutor` and any link preview announce a feature that RC1
// does not have.
export function generateMetadata(): Metadata {
  if (!tutorEnabled()) return {};
  return {
    title: "TAOS·TUTOR — pronunciation practice",
    description: "Repeat-after-me drills with real pronunciation scoring."
  };
}

export default function TutorPage(): JSX.Element {
  // Off for RC1 (lib/release.ts). Hiding the nav link is not enough — the URL
  // is guessable, it is in old bookmarks, and Stripe's add-on pack still sends
  // buyers to /tutor?pack=success. Redirect home rather than render a "coming
  // soon" card: there is nothing to come back to yet, and a dead-end page is a
  // support email.
  if (!tutorEnabled()) redirect("/");
  return <TutorShell />;
}
