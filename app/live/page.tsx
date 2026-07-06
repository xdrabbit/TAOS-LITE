import type { Metadata } from "next";
import { LiveShell } from "@/components/LiveShell";

export const metadata: Metadata = {
  title: "Live follow-along · TAOS",
  description:
    "Follow a live Spanish phone call in real time — short English concept summaries as your partner speaks."
};

export default function LivePage(): JSX.Element {
  return <LiveShell />;
}
