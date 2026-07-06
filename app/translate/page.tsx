import type { Metadata } from "next";
import { TranslateShell } from "@/components/TranslateShell";

export const metadata: Metadata = {
  title: "Type & translate · TAOS",
  description:
    "A manual typing surface with predictive autocomplete trained on your own conversation history — the familiar phrases are nearly free to type."
};

export default function TranslatePage(): JSX.Element {
  return <TranslateShell />;
}
