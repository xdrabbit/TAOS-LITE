import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authServer";
import {
  CHAT_JOIN_ALREADY_MEMBER,
  CHAT_JOIN_BAD_LINK,
  CHAT_JOIN_EXPIRED,
  CHAT_JOIN_FULL,
  CHAT_JOIN_USED,
  isInviteExpired,
  isInviteToken
} from "@/lib/chatInvite";
import { isSupportedLanguageCode } from "@/lib/realtime/languages";
import { hasServiceRoleKey, supabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const maxDuration = 15;

// Redeems an invite token: the second half of the entry path that /chat never
// had (see app/api/chat/invite/route.ts).
//
// ── Who you are is never the token's business ──────────────────────────────
// The token says WHICH CHAT. The Supabase session says WHO. They are checked
// separately and neither substitutes for the other: a link cannot name its
// recipient, so anyone holding it may become the second member — which is
// exactly what handing somebody a QR code means — but it can only ever add
// the account that is signed in on the phone redeeming it. That is why the
// membership row is written from `user.id` and the body is not consulted for
// anything except a language preference.
//
// ── Single use ─────────────────────────────────────────────────────────────
// The claim is a conditional UPDATE (`where accepted_at is null`), so two
// phones racing on the same link produce one winner and one honest "already
// used" — no read-then-write window in between. If the membership insert then
// fails, the claim is released so the link is not burned by a server error.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  }
  if (!hasServiceRoleKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: missing SUPABASE_SERVICE_ROLE_KEY." },
      { status: 500 }
    );
  }

  const payload = (await req.json().catch(() => ({}))) as { token?: string; lang?: string };
  const token = payload.token;
  if (!isInviteToken(token)) {
    return NextResponse.json({ error: CHAT_JOIN_BAD_LINK }, { status: 400 });
  }
  const lang =
    typeof payload.lang === "string" && isSupportedLanguageCode(payload.lang)
      ? payload.lang
      : "en";

  const { data: invite, error: inviteErr } = await supabaseAdmin
    .from("taos_lite_chat_invites")
    .select("token, thread_id, created_by, expires_at, accepted_at")
    .eq("token", token)
    .maybeSingle();
  if (inviteErr) {
    return NextResponse.json({ error: "Could not open the invite." }, { status: 502 });
  }
  if (!invite) {
    return NextResponse.json({ error: CHAT_JOIN_BAD_LINK }, { status: 404 });
  }

  // Am I already in this thread? Answered BEFORE the used/expired checks,
  // because "you're already in this chat" is the truth for the two people most
  // likely to open a spent link: the person who minted it and tapped their own
  // QR, and the person who joined and then reopened the link. Neither should
  // be told the link is broken — it did its job.
  const { data: existing, error: existingErr } = await supabaseAdmin
    .from("taos_lite_chat_members")
    .select("thread_id")
    .eq("user_id", user.id);
  if (existingErr) {
    return NextResponse.json({ error: "Could not open the invite." }, { status: 502 });
  }
  if (existing?.some((m) => m.thread_id === invite.thread_id)) {
    return NextResponse.json({
      threadId: invite.thread_id,
      joined: false,
      message: CHAT_JOIN_ALREADY_MEMBER
    });
  }
  // Being in a DIFFERENT chat used to end the road here, with "You're already
  // in a chat, and TAOS holds one at a time" — the sentence Tom hit on his own
  // app during the two-phone walkthrough. It was true of a screen that drew
  // the first thread and had no switcher; it stopped being true when /chat
  // grew a list (lib/chatThreads.ts), so the refusal is gone rather than
  // reworded. The one just above stays: joining the SAME thread twice is
  // still nothing to do.

  if (invite.accepted_at) {
    return NextResponse.json({ error: CHAT_JOIN_USED }, { status: 410 });
  }
  if (isInviteExpired(invite.expires_at as string)) {
    return NextResponse.json({ error: CHAT_JOIN_EXPIRED }, { status: 410 });
  }

  const { count, error: countErr } = await supabaseAdmin
    .from("taos_lite_chat_members")
    .select("user_id", { count: "exact", head: true })
    .eq("thread_id", invite.thread_id);
  if (countErr) {
    return NextResponse.json({ error: "Could not open the invite." }, { status: 502 });
  }
  if ((count ?? 0) >= 2) {
    return NextResponse.json({ error: CHAT_JOIN_FULL }, { status: 409 });
  }

  // Claim the token. Conditional on it still being unclaimed, so this is the
  // line that decides the race rather than the read above.
  const { data: claimed, error: claimErr } = await supabaseAdmin
    .from("taos_lite_chat_invites")
    .update({ accepted_by: user.id, accepted_at: new Date().toISOString() })
    .eq("token", token)
    .is("accepted_at", null)
    .select("thread_id")
    .maybeSingle();
  if (claimErr) {
    return NextResponse.json({ error: "Could not open the invite." }, { status: 502 });
  }
  if (!claimed) {
    return NextResponse.json({ error: CHAT_JOIN_USED }, { status: 410 });
  }

  const { error: memberErr } = await supabaseAdmin
    .from("taos_lite_chat_members")
    .insert({ thread_id: invite.thread_id, user_id: user.id, lang });
  if (memberErr) {
    // Give the link back. The one insert that can fail here is the two-member
    // cap trigger firing on a thread that filled up in the last millisecond,
    // and a link burned by somebody else's race is a link its owner has to
    // re-mint for no reason they could ever see.
    await supabaseAdmin
      .from("taos_lite_chat_invites")
      .update({ accepted_by: null, accepted_at: null })
      .eq("token", token);
    return NextResponse.json({ error: CHAT_JOIN_FULL }, { status: 409 });
  }

  return NextResponse.json({ threadId: invite.thread_id, joined: true });
}
