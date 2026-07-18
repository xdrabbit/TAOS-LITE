import type { Metadata } from "next";
import { CallShell } from "@/components/CallShell";

export const metadata: Metadata = {
  title: "Translated call · TAOS",
  description:
    "Call each other over wifi or cellular — video or voice-only — with a live AI interpreter and captions in each person's own language."
};

export default function CallPage(): JSX.Element {
  return <CallShell />;
}
