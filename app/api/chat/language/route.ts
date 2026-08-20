import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authServer";
import { hasServiceRoleKey, supabaseAdmin } from "@/lib/supabaseAdmin";
import { isSupportedLanguageCode } from "@/lib/realtime/languages";

export const runtime = "nodejs";
export const maxDuration = 15;

// Sets the caller's own language in a chat thread.
//
// /chat's languages are not the phone's — they are a property of the
// MEMBERSHIP, one row per person per thread, and they are what
// /api/chat/send and /api/chat/voice translate between. That is why this is a
// route and not a localStorage write like the pair on /translate: the person
// this setting affects most is the one on the other phone, who needs to
// receive messages in a language their own device never chose.
//
// You can only ever change your OWN row. The partner's language is theirs to
// set, on their phone — a picker that could reach across the thread would let
// one person decide what language the other reads in.
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

  const payload = (await req.json().catch(() => ({}))) as { threadId?: string; lang?: string };
  const threadId = typeof payload.threadId === "string" ? payload.threadId : "";
  const lang = typeof payload.lang === "string" ? payload.lang : "";
  if (!threadId || !lang) {
    return NextResponse.json({ error: "Missing threadId or lang." }, { status: 400 });
  }
  // The catalog is the allow-list. An unrecognized code would reach the
  // translation prompts as a bare string and be interpolated into "translate
  // this into xx", which produces confident nonsense rather than an error.
  if (!isSupportedLanguageCode(lang)) {
    return NextResponse.json({ error: "That language isn't supported." }, { status: 400 });
  }

  const { data: updated, error } = await supabaseAdmin
    .from("taos_lite_chat_members")
    .update({ lang })
    .eq("thread_id", threadId)
    .eq("user_id", user.id)
    .select("thread_id, user_id, lang")
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: "Could not save the language." }, { status: 502 });
  }
  // No row matched: the caller is not a member of this thread. Same answer
  // the send route gives, for the same reason.
  if (!updated) {
    return NextResponse.json({ error: "You are not part of this chat." }, { status: 403 });
  }

  return NextResponse.json({ lang: updated.lang });
}
