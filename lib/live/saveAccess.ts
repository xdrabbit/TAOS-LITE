// Who may SAVE a /live conversation. Server-only.
//
//     TAOS_LIVE_SAVE=founders | subscribers | all        (default: founders)
//
// A server env, read per request, so Tom can widen it from the Vercel
// dashboard without a deploy. Anything else — unset, a typo, "off" spelled
// some way nobody planned for — is `founders`, the narrowest audience: a knob
// that fails must not fail open on storing people's conversations.
//
// This gates WRITING only. Reading, exporting and deleting what a user has
// already saved needs a sign-in and nothing else (their own rows, always), so
// narrowing the audience later never strands a conversation its owner can no
// longer see or delete.

import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { guardSpend } from "@/lib/spendGuard";
import { isFounder } from "@/lib/release";

export type LiveSaveAudience = "founders" | "subscribers" | "all";

export function liveSaveAudience(raw: string | undefined = process.env.TAOS_LIVE_SAVE): LiveSaveAudience {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "subscribers" || v === "all" ? v : "founders";
}

/** Is this user's plan a paid (or comped) one? Injectable for tests. */
export type SubscriberLookup = (userId: string) => Promise<boolean>;

/**
 * Unlike lib/tts/shareSignoff.ts's lookup this one answers FALSE when it
 * cannot tell: there, a doubt means "do not add the sign-off"; here, a doubt
 * means "do not store the conversation".
 */
export async function paidPlanFromProfile(userId: string): Promise<boolean> {
  try {
    const { supabaseAdmin, hasServiceRoleKey } = await import("@/lib/supabaseAdmin");
    if (!hasServiceRoleKey) return false;
    const { tierFromProfile } = await import("@/lib/tutor/meter");
    const { data, error } = await supabaseAdmin
      .from("profiles")
      .select("subscription_status, tier")
      .eq("id", userId)
      .maybeSingle();
    if (error) return false;
    return tierFromProfile(data as { subscription_status?: string; tier?: string } | null) !== "free";
  } catch {
    return false;
  }
}

export async function liveSaveAllowed(
  user: Pick<User, "id" | "email">,
  deps: { audience?: LiveSaveAudience; isSubscriber?: SubscriberLookup } = {}
): Promise<boolean> {
  const audience = deps.audience ?? liveSaveAudience();
  // Founders are in every audience.
  if (isFounder(user.email)) return true;
  if (audience === "all") return true;
  if (audience === "subscribers") return (deps.isSubscriber ?? paidPlanFromProfile)(user.id);
  return false;
}

export type LiveSavedGuard = { ok: true; user: User } | { ok: false; response: NextResponse };

/** Sign-in only: the door for reading, exporting and deleting one's own. */
export async function guardLiveSaved(req: Request): Promise<LiveSavedGuard> {
  const guard = await guardSpend(req);
  if (!guard.ok) return guard;
  if (!guard.user) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Not found." }, { status: 404, headers: { "Cache-Control": "no-store" } })
    };
  }
  return { ok: true, user: guard.user };
}
