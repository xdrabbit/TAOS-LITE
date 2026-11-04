import type { Metadata } from "next";
import { TaokieScreen, walkieMetadata } from "@/components/walkie/TaokieScreen";

// /taokie/<code> — the invite link, and the on-air address. The code is in
// the path so it survives the sign-in bounce (components/walkie/TaokieScreen.tsx).
export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  return walkieMetadata();
}

export default function TaokieRoomPage({ params }: { params: { room: string } }): JSX.Element {
  return <TaokieScreen room={params.room} />;
}
