import type { Metadata } from "next";
import { VisionShell } from "@/components/VisionShell";

export const metadata: Metadata = {
  title: "Photo translator · TAOS",
  description:
    "Point the camera at a sign, menu, or label — or pick a photo — and read it in your language."
};

export default function VisionPage(): JSX.Element {
  return <VisionShell />;
}
