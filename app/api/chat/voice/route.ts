import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authServer";
import { hasServiceRoleKey, supabaseAdmin } from "@/lib/supabaseAdmin";
import { chatCompletion, getOpenAIKey } from "@/lib/translateProvider";

export const runtime = "nodejs";
export const maxDuration = 60;

// Voice message: receives the recorded audio, stores it in the private
// chat-voice bucket, transcribes it (same transcription API as /api/translate),
// translates the transcript into the partner's language, and inserts one
// message row carrying all of it. If transcription or translation hiccup, the
// voice note still sends — audio is the payload, text is the bonus.

const MAX_AUDIO_BYTES = 15 * 1024 * 1024; // ~2 min of audio with headroom
const LANG_LABEL: Record<string, string> = { en: "English", es: "Spanish" };

function extensionFor(mime: string): string {
  if (mime.includes("mp4") || mime.includes("aac") || mime.includes("m4a")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  return "webm";
}

async function transcribeAudio(apiKey: string, file: File, sourceLabel: string): Promise<string> {
  const model = process.env.OPENAI_TRANSCRIBE_MODEL?.trim() || "gpt-4o-transcribe";
  const form = new FormData();
  form.append("file", file, file.name || "voice.webm");
  form.append("model", model);
  // Hint the sender's usual language but leave room for mixing — they're a
  // bilingual couple, code-switching is the normal case, not the edge case.
  form.append(
    "prompt",
    `Mostly spoken ${sourceLabel}, possibly mixing English and Spanish. Transcribe verbatim with natural punctuation.`
  );
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    cache: "no-store"
  });
  const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    throw new Error(payload ? JSON.stringify(payload) : `HTTP ${res.status}`);
  }
  return typeof payload?.text === "string" ? payload.text.trim() : "";
}

async function translateTranscript(
  apiKey: string,
  text: string,
  sourceLabel: string,
  targetLabel: string
): Promise<string | null> {
  try {
    const out = await chatCompletion(apiKey, {
      temperature: 0.2,
      maxTokens: 1200,
      messages: [
        {
          role: "system",
          content:
            `You translate transcripts of short voice messages between two partners. ` +
            `The sender usually speaks ${sourceLabel}. Translate the transcript into natural, warm, ` +
            `conversational ${targetLabel}, keeping the tone, affection, and any emoji-worthy feeling. ` +
            `If the transcript is already entirely in ${targetLabel}, return it unchanged. ` +
            `Output ONLY the translation — no quotes, no notes, no labels.`
        },
        { role: "user", content: text }
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
  const apiKey = getOpenAIKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: missing OPENAI_API_KEY." },
      { status: 500 }
    );
  }

  const form = await req.formData().catch(() => null);
  const threadId = typeof form?.get("threadId") === "string" ? (form.get("threadId") as string) : "";
  const audio = form?.get("audio");
  if (!threadId || !(audio instanceof File) || audio.size === 0) {
    return NextResponse.json({ error: "Missing threadId or audio." }, { status: 400 });
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    return NextResponse.json({ error: "Voice message is too large." }, { status: 413 });
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
  const sourceLabel = LANG_LABEL[sourceLang] ?? sourceLang;
  const targetLabel = LANG_LABEL[targetLang] ?? targetLang;

  // Store the audio first — it is the message; text enrichment can fail.
  const mime = audio.type || "audio/webm";
  const audioPath = `${threadId}/${crypto.randomUUID()}.${extensionFor(mime)}`;
  const bytes = await audio.arrayBuffer();
  const { error: uploadErr } = await supabaseAdmin.storage
    .from("chat-voice")
    .upload(audioPath, bytes, { contentType: mime, upsert: false });
  if (uploadErr) {
    return NextResponse.json({ error: "Could not store the voice message." }, { status: 502 });
  }

  let transcript = "";
  try {
    transcript = await transcribeAudio(apiKey, audio, sourceLabel);
  } catch {
    transcript = "";
  }
  transcript = transcript.slice(0, 4000);

  const translated =
    transcript && targetLang !== sourceLang
      ? (await translateTranscript(apiKey, transcript, sourceLabel, targetLabel))?.slice(0, 4000) ??
        null
      : null;

  const { data: inserted, error: insertErr } = await supabaseAdmin
    .from("taos_lite_chat_messages")
    .insert({
      thread_id: threadId,
      sender_id: user.id,
      kind: "voice",
      audio_path: audioPath,
      body: transcript || "🎤 Voice message",
      body_translated: translated,
      source_lang: sourceLang,
      target_lang: translated ? targetLang : null
    })
    .select("*")
    .single();
  if (insertErr || !inserted) {
    // Best-effort cleanup so a failed insert doesn't strand the audio file.
    await supabaseAdmin.storage.from("chat-voice").remove([audioPath]);
    return NextResponse.json({ error: "Could not send the voice message." }, { status: 502 });
  }

  return NextResponse.json({ message: inserted });
}
