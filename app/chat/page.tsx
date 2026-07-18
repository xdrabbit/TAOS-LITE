import type { Metadata } from "next";
import { ChatShell } from "@/components/ChatShell";

export const metadata: Metadata = {
  title: "Private chat · TAOS",
  description:
    "Private messages between the two of you — each message auto-translated so you read in English and she reads in Spanish."
};

export default function ChatPage(): JSX.Element {
  return <ChatShell />;
}
