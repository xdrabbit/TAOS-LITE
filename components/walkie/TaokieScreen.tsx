import type { Metadata } from "next";
import { WalkieGate } from "@/components/walkie/WalkieGate";
import { WalkieShell } from "@/components/walkie/WalkieShell";
import { walkieEnabled, walkieMaxTurnMs, walkieRetentionDays } from "@/lib/walkie/flag";
import { isWalkieRoom, normalizeWalkieRoom } from "@/lib/walkie/room";

// The /taokie screen, server side: the flag, the two knobs, and the room
// from the path — shared by app/taokie/page.tsx and app/taokie/[room]/page.tsx
// (a page module may export only Next's route exports, so the shared parts
// live here).
//
// /taokie/<code> is the invite link AND the on-air address. The code rides
// in the PATH so that it survives Google sign-in's bounce through Supabase,
// which comes back to a path and appends its own ?code= — a ?room= did not
// survive it (both founders, 2026-11-02). The code is validated before it is
// trusted with anything; a path that is not one of ours is the plain lobby.

export function walkieMetadata(): Metadata {
  // Never indexed, and no title to announce it while it is switched off.
  if (!walkieEnabled()) return { robots: { index: false, follow: false } };
  return { title: "Taokie · TAOS", robots: { index: false, follow: false } };
}

/** The code from the path, or "" when it is not one of ours. */
export function roomParam(raw: string | undefined): string {
  const code = normalizeWalkieRoom(raw);
  return isWalkieRoom(code) ? code : "";
}

/** Where sign-in should come back to: the invite, code and all. */
export function walkieRedirectPath(code: string): string {
  return code ? `/taokie/${code}` : "/taokie";
}

export function TaokieScreen({ room = "" }: { room?: string }): JSX.Element {
  const code = roomParam(room);
  return (
    <WalkieGate enabled={walkieEnabled()} redirectPath={walkieRedirectPath(code)}>
      <WalkieShell maxTurnMs={walkieMaxTurnMs()} retentionDays={walkieRetentionDays()} initialRoom={code || undefined} />
    </WalkieGate>
  );
}
