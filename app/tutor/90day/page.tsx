import { MirroredTutorPreview } from "@/components/MirroredTutorPreview";
import { TutorMasterySyncBridge } from "@/components/TutorMasterySyncBridge";

export const metadata = {
  title: "TAOS·TUTOR — 90-day mirrored framework",
  description: "Spanish 1 for Tom and English 1 for Liz."
};

export default function MirroredTutorPage(): JSX.Element {
  return (
    <>
      <TutorMasterySyncBridge />
      <MirroredTutorPreview />
    </>
  );
}
