/**
 * Typed view of the messages inside a Meta WhatsApp webhook payload.
 *
 * Pure functions over unknown JSON — the route stays a thin dispatcher and
 * the parsing is unit-testable (tests/whatsapp-webhook.test.ts). Never throws
 * on weird shapes: Meta sends `statuses` changes, non-message fields, and
 * message types this bot doesn't handle, and all of those are simply skipped.
 */

export interface WhatsAppAudioMessage {
  /** The sender's WhatsApp id (phone number). Replies go here. */
  from: string;
  /** wamid — the idempotency key for redeliveries. */
  messageId: string;
  /** Media object id to download. */
  mediaId: string;
  mimeType: string;
}

export interface WhatsAppTextMessage {
  from: string;
  messageId: string;
  body: string;
}

export interface InboundBatch {
  audio: WhatsAppAudioMessage[];
  text: WhatsAppTextMessage[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function extractInboundMessages(payload: unknown): InboundBatch {
  const batch: InboundBatch = { audio: [], text: [] };
  if (!isRecord(payload)) return batch;
  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      if (!isRecord(change) || change.field !== "messages") continue;
      const value = isRecord(change.value) ? change.value : null;
      const messages = value && Array.isArray(value.messages) ? value.messages : [];
      for (const m of messages) {
        if (!isRecord(m)) continue;
        const from = typeof m.from === "string" ? m.from : "";
        const messageId = typeof m.id === "string" ? m.id : "";
        if (!from || !messageId) continue;
        if (m.type === "audio" && isRecord(m.audio) && typeof m.audio.id === "string") {
          batch.audio.push({
            from,
            messageId,
            mediaId: m.audio.id,
            mimeType: typeof m.audio.mime_type === "string" ? m.audio.mime_type : "audio/ogg"
          });
        } else if (m.type === "text" && isRecord(m.text) && typeof m.text.body === "string") {
          batch.text.push({ from, messageId, body: m.text.body });
        }
        // Everything else (image, video, document, sticker, reaction,
        // statuses changes) is intentionally ignored by this bot.
      }
    }
  }
  return batch;
}
