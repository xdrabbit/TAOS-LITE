import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authServer";
import { CHAT_VOICE_BUCKET, isVoicePathForThread } from "@/lib/chatVoice";
import { hasServiceRoleKey, supabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const maxDuration = 30;

// Burn the chat. Either member, the whole thread, both people's copies.
//
// This is the only destructive route in /chat and the first one the app has
// ever had. Until now nothing could delete a message: no DELETE policy, no
// route, no button. A couple's corpus was write-once and keep-forever, and the
// single deletion mode available to them — deleting an ACCOUNT — cascaded one
// person's messages away by sender_id and left the other's half sitting there,
// unanswered and unremovable. `docs/data-map.md` (2026-08-26) named that as a
// prerequisite for Reflections, whose second principle is that either partner
// can revoke at any time. This is the revocation.
//
// The semantics, decided with Tom and written out in full in
// supabase/migrations/20260826_chat_thread_deletion.sql: a 1:1 thread belongs
// to BOTH of them, so either member may delete ALL of it — the thread row,
// every message from either sender, and the voice audio behind them. Not "my
// half": half a conversation is a worse record than none, and it is exactly
// the artifact the sender_id cascade already produced.
//
// ── Two systems, and the order they have to be taken down in ──────────────
// A voice note is a row in Postgres AND an object in the private `chat-voice`
// bucket, and no cascade spans them — Supabase's `protect_objects_delete`
// trigger refuses SQL deletes on storage.objects outright, so the Storage API
// is the only way to the audio and this route is the only thing holding it.
//
// So: AUDIO FIRST, rows second, and abort the whole thing if the audio does
// not go. The two failure modes are not equal. Audio left behind after a
// thread is gone is the privacy promise broken with nothing left pointing at
// the evidence; rows left behind after the audio is gone is a play button that
// does not work, in a thread the user is about to delete again. One of those
// is recoverable by tapping Delete a second time. The other is not recoverable
// at all.
//
// The rows themselves need no work: every FK into a thread is ON DELETE
// CASCADE, so deleting the thread row takes members, messages (both senders)
// and invites with it.
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
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

  const threadId = params.id?.trim();
  if (!threadId) {
    return NextResponse.json({ error: "Missing thread id." }, { status: 400 });
  }

  // MY MEMBERSHIP is the permission, read as my own row rather than the
  // thread's — the same fence /api/chat/invite draws, for the same reason: a
  // thread id copied off somebody else's screen must delete nothing. The
  // service role bypasses RLS, so this check IS the policy here; the DELETE
  // policy in the migration is the database saying the same thing for any
  // path that does not come through this file.
  const { data: mine, error: mineErr } = await supabaseAdmin
    .from("taos_lite_chat_members")
    .select("thread_id")
    .eq("user_id", user.id)
    .eq("thread_id", threadId)
    .maybeSingle();
  if (mineErr) {
    return NextResponse.json({ error: "Could not delete the chat." }, { status: 502 });
  }
  if (!mine) {
    // Not a member is a refusal, not a 404 — the same answer /api/chat/send,
    // /api/chat/language and /api/chat/invite give. A 404 would also be a
    // small oracle: it would tell a stranger which thread ids exist.
    return NextResponse.json({ error: "You are not part of this chat." }, { status: 403 });
  }

  // ── The audio ─────────────────────────────────────────────────────────────
  // Listed from the BUCKET rather than gathered from `audio_path` columns, so
  // strays are caught too: an upload whose message insert failed leaves an
  // object no row has ever pointed at, and "delete this chat" should mean the
  // folder, not just the rows' worth of it. The thread id is the first path
  // segment (see /api/chat/voice), which is also what the storage read policy
  // keys membership on.
  const { data: objects, error: listErr } = await supabaseAdmin.storage
    .from(CHAT_VOICE_BUCKET)
    .list(threadId, { limit: 1000 });
  if (listErr) {
    return NextResponse.json({ error: "Could not delete the chat." }, { status: 502 });
  }

  const paths = (objects ?? [])
    .map((o) => `${threadId}/${o.name}`)
    // Belt and braces on a path that is about to be handed to a delete call:
    // the list is already scoped to this thread's folder, and this makes it
    // impossible for a name with a slash or a `..` in it to widen that.
    .filter((p) => isVoicePathForThread(p, threadId));

  if (paths.length) {
    const { error: removeErr } = await supabaseAdmin.storage
      .from(CHAT_VOICE_BUCKET)
      .remove(paths);
    if (removeErr) {
      // Nothing has been deleted yet — the rows are all still there, the chat
      // still works, and tapping Delete again is a clean retry.
      return NextResponse.json({ error: "Could not delete the chat." }, { status: 502 });
    }
  }

  const { error: deleteErr } = await supabaseAdmin
    .from("taos_lite_chat_threads")
    .delete()
    .eq("id", threadId);
  if (deleteErr) {
    return NextResponse.json({ error: "Could not delete the chat." }, { status: 502 });
  }

  return NextResponse.json({ deleted: true, threadId, audioRemoved: paths.length });
}
