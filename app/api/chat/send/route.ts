import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authServer";
import { hasServiceRoleKey, supabaseAdmin } from "@/lib/supabaseAdmin";
import { chatCompletion, getOpenAIKey } from "@/lib/translateProvider";

export const runtime = "nodejs";
export const maxDuration = 30;

// Sends a chat message: verifies the sender is a member of the thread,
// translates the body into the partner's language (same provider/model as the
// other translate routes), and inserts both texts in one row via the service
// role — so a message and its translation always arrive together. If the
// provider hiccups, the message still sends untranslated rather than failing;
// the recipient sees the original.

const LANG_LABEL: Record<string, string> = { en: "English", es: "Spanish" };

async function translateBody(body: string, source: string, target: string): Promise<string | null> {
  const apiKey = getOpenAIKey();
  if (!apiKey) return null;
  const targetLabel = LANG_LABEL[target] ?? target;
  const sourceLabel = LANG_LABEL[source] ?? source;
  try {
    const out = await chatCompletion(apiKey, {
      temperature: 0.2,
      maxTokens: 1000,
      messages: [
        {
          role: "system",
          content:
            `You translate short private chat messages between two partners. ` +
            `The sender usually writes ${sourceLabel}. Translate the message into natural, warm, ` +
            `conversational ${targetLabel}, keeping the tone, affection, slang level, emoji, and punctuation. ` +
            `If the message is already entirely in ${targetLabel}, return it unchanged. ` +
            `Output ONLY the translation — no quotes, no notes, no labels.`
        },
        { role: "user", content: body }
      ]
    });
    return out || null;
  } catch {
    return null;
  }
}

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

  const payload = (await req.json().catch(() => ({}))) as { threadId?: string; body?: string };
  const threadId = typeof payload.threadId === "string" ? payload.threadId : "";
  const body = typeof payload.body === "string" ? payload.body.trim() : "";
  if (!threadId || !body) {
    return NextResponse.json({ error: "Missing threadId or message body." }, { status: 400 });
  }
  if (body.length > 4000) {
    return NextResponse.json({ error: "Message is too long (4000 characters max)." }, { status: 400 });
  }

  const { data: members, error: memberErr } = await supabaseAdmin
    .from("taos_lite_chat_members")
    .select("user_id, lang")
    .eq("thread_id", threadId);
  if (memberErr || !members?.length) {
    return NextResponse.json({ error: "Chat thread not found." }, { status: 404 });
  }

  const me = members.find((m) => m.user_id === user.id);
  if (!me) {
    return NextResponse.json({ error: "You are not part of this chat." }, { status: 403 });
  }
  const partner = members.find((m) => m.user_id !== user.id);

  const sourceLang = me.lang;
  const targetLang = partner?.lang ?? me.lang;
  const translated =
    targetLang === sourceLang ? null : await translateBody(body, sourceLang, targetLang);

  const { data: inserted, error: insertErr } = await supabaseAdmin
    .from("taos_lite_chat_messages")
    .insert({
      thread_id: threadId,
      sender_id: user.id,
      body,
      body_translated: translated,
      source_lang: sourceLang,
      target_lang: translated ? targetLang : null
    })
    .select("*")
    .single();
  if (insertErr || !inserted) {
    return NextResponse.json({ error: "Could not send the message." }, { status: 502 });
  }

  return NextResponse.json({ message: inserted, translated: Boolean(translated) });
}
