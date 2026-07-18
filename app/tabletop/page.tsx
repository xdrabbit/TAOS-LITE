import type { Metadata } from "next";
import { TabletopShell } from "@/components/TabletopShell";

export const metadata: Metadata = {
  title: "Tabletop · TAOS",
  description:
    "Lay the phone flat between two people — each end faces its reader, push to talk, and every turn is translated on screen and out loud."
};

export default function TabletopPage(): JSX.Element {
  return <TabletopShell />;
}
