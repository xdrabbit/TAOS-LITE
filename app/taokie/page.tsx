import type { Metadata } from "next";
import { TaokieScreen, walkieMetadata } from "@/components/walkie/TaokieScreen";

// /taokie — the push-to-talk translation walkie (founders-only P0 spike,
// 2026-11-01). Hold the button, talk, let go: the turn goes through the home
// pipeline and plays on the partner's phone in the partner's language.
// /taokie/<code> (app/taokie/[room]/page.tsx) is the same screen with the
// channel filled in and joined: the invite link.
//
// Dynamic because TAOS_WALKIE_ENABLED is a SERVER flag read per request —
// not NEXT_PUBLIC_, so it never reaches a bundle, and a prerendered page
// would freeze whatever it was at build time. The two knobs ride along as
// props for the same reason (components/walkie/TaokieScreen.tsx).
export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  return walkieMetadata();
}

export default function TaokiePage(): JSX.Element {
  return <TaokieScreen />;
}
