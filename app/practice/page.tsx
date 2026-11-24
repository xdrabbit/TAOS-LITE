import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PracticeShell } from "@/components/PracticeShell";
import { practiceEnabled } from "@/lib/release";

// Same gate as /tutor (see app/tutor/page.tsx for why each line is here):
// dynamic so the redirect is a real 307, metadata only when the flag is on.
export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  if (!practiceEnabled()) return {};
  return {
    title: "TAOS·PRACTICE — talk it through with Claude",
    description: "Role-play a conversation in the language you are learning, with spoken replies and translations."
  };
}

export default function PracticePage(): JSX.Element {
  if (!practiceEnabled()) redirect("/");
  return <PracticeShell />;
}
