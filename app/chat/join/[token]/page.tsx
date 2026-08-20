import type { Metadata } from "next";
import { ChatJoinShell } from "@/components/ChatJoinShell";

export const metadata: Metadata = {
  title: "Join a chat · TAOS",
  description:
    "You've been invited to a private translated chat — each message arrives in the language you read.",
  // An invite token in the path is a credential. Nothing about this URL should
  // end up in a search index or a link preview crawler's cache.
  robots: { index: false, follow: false }
};

export default function ChatJoinPage({ params }: { params: { token: string } }): JSX.Element {
  return <ChatJoinShell token={params.token} />;
}
