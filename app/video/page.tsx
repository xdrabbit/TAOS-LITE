import type { Metadata } from "next";
import { FounderGate } from "@/components/FounderGate";
import { VideoShell } from "@/components/VideoShell";

export const metadata: Metadata = {
  title: "Video captions · TAOS",
  description:
    "Feed TAOS a video and get translated closed captions — English becomes Spanish, Spanish becomes English, with SRT/VTT downloads."
};

export default function VideoPage(): JSX.Element {
  // Held back from v1 (lib/release.ts).
  return (
    <FounderGate>
      <VideoShell />
    </FounderGate>
  );
}
