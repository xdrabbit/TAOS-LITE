import type { Metadata } from "next";
import { ChatShell } from "@/components/ChatShell";

export const metadata: Metadata = {
  title: "Private chat · TAOS",
  description:
    "Private messages between the two of you — each message auto-translated so you read in your language and they read in theirs."
};

/**
 * `?t=` names which chat to open.
 *
 * An account can hold several now (lib/chatThreads.ts), so "go to /chat" is no
 * longer a complete instruction. /chat/join lands somebody on the thread it
 * has just let them into, and a reload comes back to the conversation that was
 * on screen rather than to whichever one sorts first. Read here, on the server
 * component, rather than through useSearchParams — a client hook would need a
 * Suspense boundary around the whole shell to satisfy the build.
 */
export default function ChatPage({
  searchParams
}: {
  searchParams?: { t?: string | string[] };
}): JSX.Element {
  const t = searchParams?.t;
  return <ChatShell openThreadId={typeof t === "string" ? t : undefined} />;
}
