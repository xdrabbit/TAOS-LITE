/**
 * Thin typed client for the WhatsApp Business Cloud API.
 *
 * Reads WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID at call time (not
 * module load) so Vercel env changes don't need a rebuild to take effect.
 * Every function throws on provider failure with the Graph error surfaced —
 * the route decides what that means for the user (see voiceNotes.ts).
 */

const GRAPH_VERSION = "v22.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const UPSTREAM_TIMEOUT_MS = 30000;

function config(): { token: string; phoneNumberId: string } {
  const token = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (!token || !phoneNumberId) {
    throw new Error(
      "WhatsApp not configured: set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID."
    );
  }
  return { token, phoneNumberId };
}

async function graphFetch(
  path: string,
  init: RequestInit & { token: string }
): Promise<unknown> {
  const { token, ...rest } = init;
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    ...rest,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(rest.headers ?? {})
    },
    cache: "no-store",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
  });
  const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const detail =
      payload && typeof payload === "object" ? JSON.stringify(payload) : `HTTP ${res.status}`;
    throw new Error(`WhatsApp Graph API failed: ${detail}`);
  }
  return payload;
}

/** Download a media object: first resolve its URL, then fetch the bytes. */
export async function downloadMedia(
  mediaId: string
): Promise<{ bytes: Buffer; mimeType: string }> {
  const { token } = config();
  const meta = (await graphFetch(`/${mediaId}`, { token })) as {
    url?: string;
    mime_type?: string;
  };
  if (!meta.url) throw new Error("WhatsApp media had no download URL.");
  const res = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`WhatsApp media download failed: HTTP ${res.status}.`);
  return {
    bytes: Buffer.from(await res.arrayBuffer()),
    mimeType: meta.mime_type ?? "audio/ogg"
  };
}

/** Upload audio bytes; returns the media id to reference in a message. */
export async function uploadMedia(
  audio: Buffer,
  mimeType: string,
  filename: string
): Promise<string> {
  const { token, phoneNumberId } = config();
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append(
    "file",
    new File([new Uint8Array(audio)], filename, { type: mimeType })
  );
  form.append("type", mimeType);
  const payload = (await graphFetch(`/${phoneNumberId}/media`, {
    token,
    method: "POST",
    body: form
  })) as { id?: string };
  if (!payload.id) throw new Error("WhatsApp media upload returned no id.");
  return payload.id;
}

/** Send a plain text message. Used for errors, text-only languages, and the "send a voice note" nudge. */
export async function sendTextMessage(to: string, text: string): Promise<void> {
  const { token, phoneNumberId } = config();
  await graphFetch(`/${phoneNumberId}/messages`, {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text }
    })
  });
}

/**
 * Send an audio message. An OGG/Opus file sent as type "audio" renders as a
 * true voice note in WhatsApp clients (mp3 renders as an audio attachment
 * instead) — so the pipeline must hand this OGG bytes, see voiceNotes.ts.
 */
export async function sendAudioMessage(to: string, mediaId: string): Promise<void> {
  const { token, phoneNumberId } = config();
  await graphFetch(`/${phoneNumberId}/messages`, {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "audio",
      audio: { id: mediaId }
    })
  });
}

/** Blue ticks. Best-effort — callers should not fail the pipeline over it. */
export async function markMessageRead(messageId: string): Promise<void> {
  const { token, phoneNumberId } = config();
  await graphFetch(`/${phoneNumberId}/messages`, {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId
    })
  });
}
