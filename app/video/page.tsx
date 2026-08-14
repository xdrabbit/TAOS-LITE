import type { Metadata } from "next";
import { VideoShell } from "@/components/VideoShell";

export const metadata: Metadata = {
  title: "Video captions · TAOS",
  description:
    "Feed TAOS a video and get translated closed captions — English becomes Spanish, Spanish becomes English, with SRT/VTT downloads."
};

export default function VideoPage(): JSX.Element {
  return <VideoShell />;
}
