// The webhook's two trust boundaries, pinned:
//   1. verifyMetaSignature — an unverifiable delivery is rejected, never processed.
//   2. extractInboundMessages — only audio/text messages from the "messages"
//      field are dispatched; everything else is ignored, never crashed on.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyMetaSignature } from "@/lib/whatsapp/signature";
import { extractInboundMessages } from "@/lib/whatsapp/inbound";

const APP_SECRET = "test_app_secret_abc123";
const BODY = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

function sign(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

describe("verifyMetaSignature", () => {
  it("accepts a correctly signed body", () => {
    expect(verifyMetaSignature(BODY, sign(BODY, APP_SECRET), APP_SECRET)).toBe(true);
  });

  it("rejects a body signed with the wrong secret", () => {
    expect(verifyMetaSignature(BODY, sign(BODY, "wrong_secret"), APP_SECRET)).toBe(false);
  });

  it("rejects a tampered body", () => {
    const tampered = BODY + " ";
    expect(verifyMetaSignature(tampered, sign(BODY, APP_SECRET), APP_SECRET)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifyMetaSignature(BODY, null, APP_SECRET)).toBe(false);
  });

  it("rejects when no app secret is configured", () => {
    expect(verifyMetaSignature(BODY, sign(BODY, APP_SECRET), "")).toBe(false);
  });

  it("rejects a malformed header", () => {
    expect(verifyMetaSignature(BODY, "not-a-signature", APP_SECRET)).toBe(false);
  });
});

function webhookPayload() {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "123",
        changes: [
          {
            field: "messages",
            value: {
              messages: [
                {
                  from: "15551234567",
                  id: "wamid.audio1",
                  type: "audio",
                  audio: { id: "media_abc", mime_type: "audio/ogg; codecs=opus" }
                },
                {
                  from: "15557654321",
                  id: "wamid.text1",
                  type: "text",
                  text: { body: "hola" }
                },
                {
                  from: "15551234567",
                  id: "wamid.sticker1",
                  type: "sticker",
                  sticker: { id: "media_xyz" }
                }
              ],
              statuses: [{ id: "wamid.audio1", status: "delivered" }]
            }
          },
          { field: "not-messages", value: { messages: [{ id: "wamid.evil" }] } }
        ]
      }
    ]
  };
}

describe("extractInboundMessages", () => {
  it("dispatches voice notes and texts, ignores everything else", () => {
    const { audio, text } = extractInboundMessages(webhookPayload());
    expect(audio).toEqual([
      {
        from: "15551234567",
        messageId: "wamid.audio1",
        mediaId: "media_abc",
        mimeType: "audio/ogg; codecs=opus"
      }
    ]);
    expect(text).toEqual([{ from: "15557654321", messageId: "wamid.text1", body: "hola" }]);
  });

  it("never throws on garbage shapes", () => {
    expect(extractInboundMessages(null)).toEqual({ audio: [], text: [] });
    expect(extractInboundMessages({ entry: [{ changes: "nope" }] })).toEqual({
      audio: [],
      text: []
    });
    expect(extractInboundMessages({ entry: [{ changes: [{ field: "messages" }] }] })).toEqual({
      audio: [],
      text: []
    });
  });
});
