// The fence around /chat's thread list.
//
// /chat held one chat at a time and said so out loud — "You're already in a
// chat, and TAOS holds one at a time" — which Tom hit on his own app during
// the two-phone walkthrough. The refusal was honest: there was no list, so a
// second membership would have looked like the link doing nothing. This file
// pins the list that replaces it, and the two things about it that will rot
// first:
//
//   1. A preview is in the VIEWER's language, resolved per thread. The same
//      message shows differently in two people's lists, and my own message
//      shows as I typed it — the bubbles' rule, one screen out.
//   2. A row is labelled with the other person's OWN name. Nothing here may
//      hardcode a human being's name; the app has no directory and no
//      business inventing one.
import { describe, expect, it } from "vitest";
import {
  CHAT_LIST_BACK,
  CHAT_LIST_CAPTION,
  CHAT_LIST_NO_MESSAGES,
  CHAT_LIST_SOMEONE,
  CHAT_LIST_WAITING,
  NAME_MAX,
  PREVIEW_MAX,
  formatThreadStamp,
  initialThreadId,
  partnerDisplayName,
  sortThreads,
  threadPreview,
  threadRowLabel,
  type ChatThreadSummary
} from "@/lib/chatThreads";

const ME = "user-me";
const THEM = "user-them";

function summary(over: Partial<ChatThreadSummary> & { threadId: string }): ChatThreadSummary {
  return {
    myLang: "en",
    partnerLang: "es",
    partnerName: "Someone Else",
    preview: "hi",
    updatedAt: "2026-08-19T12:00:00.000Z",
    ...over
  };
}

describe("who the row is with", () => {
  it("uses the partner's own Google name", () => {
    expect(
      partnerDisplayName({ email: "someone@example.com", user_metadata: { full_name: "Ada L" } })
    ).toBe("Ada L");
    // Some providers fill `name` instead, and some fill both.
    expect(partnerDisplayName({ email: "x@y.com", user_metadata: { name: "Grace H" } })).toBe(
      "Grace H"
    );
  });

  it("falls back to the email's local part, never the whole address", () => {
    // The row is a label somebody else reads. Their full address is more than
    // the label needs and more than the other person volunteered.
    expect(partnerDisplayName({ email: "guide.paris@example.com" })).toBe("guide.paris");
    expect(partnerDisplayName({ email: "guide.paris@example.com" })).not.toContain("@");
  });

  it("says 'Someone' rather than inventing one", () => {
    expect(partnerDisplayName({ email: null, user_metadata: {} })).toBe(CHAT_LIST_SOMEONE);
    expect(partnerDisplayName({ email: "   ", user_metadata: { full_name: "   " } })).toBe(
      CHAT_LIST_SOMEONE
    );
    // Metadata is provider-shaped and untrusted — a number is not a name.
    expect(partnerDisplayName({ user_metadata: { full_name: 42 } })).toBe(CHAT_LIST_SOMEONE);
  });

  it("answers null when there is no other person yet, and the row says so", () => {
    // Different from an unnameable partner: this thread is a minted invite
    // nobody has opened, and the row has to be about the LINK, not the person.
    expect(partnerDisplayName(null)).toBe(null);
    expect(partnerDisplayName(undefined)).toBe(null);
    expect(threadRowLabel(null)).toBe(CHAT_LIST_WAITING);
    expect(threadRowLabel("Ada L")).toBe("Ada L");
  });

  it("clips a name before it eats the timestamp", () => {
    const long = partnerDisplayName({ user_metadata: { full_name: "x".repeat(200) } });
    expect(long).toBeTruthy();
    expect(long!.length).toBeLessThanOrEqual(NAME_MAX);
    expect(long!.endsWith("…")).toBe(true);
    // Newlines in a display name would break the row's one-line layout.
    expect(partnerDisplayName({ user_metadata: { full_name: "Ada\n\nL" } })).toBe("Ada L");
  });
});

describe("what the row says", () => {
  it("previews THEIR message in the language I read", () => {
    // The whole point of the screen. My list is mine: their Spanish arrives as
    // the English the send route stored for me.
    expect(
      threadPreview(
        { sender_id: THEM, kind: "text", body: "¿nos vemos?", body_translated: "shall we meet?" },
        ME
      )
    ).toBe("shall we meet?");
  });

  it("previews MY message as I typed it, not as they received it", () => {
    // Same rule as the bubbles: the grey translation under my own message is
    // the RECIPIENT's copy, and it has no business being the summary of my
    // own chat in my own list.
    expect(
      threadPreview(
        { sender_id: ME, kind: "text", body: "shall we meet?", body_translated: "¿nos vemos?" },
        ME
      )
    ).toBe("shall we meet?");
  });

  it("falls through to the original when a translation never happened", () => {
    // The send routes store the message untranslated when the provider
    // hiccups. A blank row would hide a message that did arrive.
    expect(
      threadPreview({ sender_id: THEM, kind: "text", body: "hola", body_translated: null }, ME)
    ).toBe("hola");
  });

  it("marks a voice note without stacking two microphones", () => {
    expect(
      threadPreview({ sender_id: THEM, kind: "voice", body: "on my way", body_translated: null }, ME)
    ).toBe("🎤 on my way");
    // The voice route's own fallback body already carries the emoji.
    expect(
      threadPreview(
        { sender_id: ME, kind: "voice", body: "🎤 Voice message", body_translated: null },
        ME
      )
    ).toBe("🎤 Voice message");
  });

  it("says so when there is nothing to preview", () => {
    expect(threadPreview(null, ME)).toBe(CHAT_LIST_NO_MESSAGES);
    expect(
      threadPreview({ sender_id: ME, kind: "text", body: "   ", body_translated: null }, ME)
    ).toBe(CHAT_LIST_NO_MESSAGES);
  });

  it("keeps a preview to one line", () => {
    const long = threadPreview(
      { sender_id: ME, kind: "text", body: "word ".repeat(200), body_translated: null },
      ME
    );
    expect(long.length).toBeLessThanOrEqual(PREVIEW_MAX);
    expect(long).not.toContain("\n");
  });
});

describe("when", () => {
  const NOW = Date.parse("2026-08-19T18:30:00.000Z");

  it("shows a time today and a date before that", () => {
    const today = formatThreadStamp("2026-08-19T09:15:00.000Z", NOW);
    const older = formatThreadStamp("2026-07-18T09:15:00.000Z", NOW);
    expect(today).toBeTruthy();
    expect(older).toBeTruthy();
    // Not the same shape, whatever the phone's locale renders them as: the
    // whole job of the stamp is to tell this week from last month at a glance.
    expect(today).not.toBe(older);
  });

  it("shows nothing rather than 'Invalid Date'", () => {
    expect(formatThreadStamp("whenever", NOW)).toBe("");
    expect(formatThreadStamp(null, NOW)).toBe("");
    expect(formatThreadStamp(undefined, NOW)).toBe("");
  });
});

describe("the order", () => {
  it("is newest first", () => {
    const sorted = sortThreads([
      summary({ threadId: "old", updatedAt: "2026-07-18T16:17:57.000Z" }),
      summary({ threadId: "new", updatedAt: "2026-08-19T19:02:19.000Z" }),
      summary({ threadId: "mid", updatedAt: "2026-08-01T00:00:00.000Z" })
    ]);
    expect(sorted.map((t) => t.threadId)).toEqual(["new", "mid", "old"]);
  });

  it("never reshuffles two threads that share a timestamp", () => {
    // A list that reorders under a thumb between two renders is how you open
    // the wrong conversation.
    const a = summary({ threadId: "aaa", updatedAt: "2026-08-19T12:00:00.000Z" });
    const b = summary({ threadId: "bbb", updatedAt: "2026-08-19T12:00:00.000Z" });
    expect(sortThreads([b, a]).map((t) => t.threadId)).toEqual(["aaa", "bbb"]);
    expect(sortThreads([a, b]).map((t) => t.threadId)).toEqual(["aaa", "bbb"]);
  });

  it("does not mutate what it was handed", () => {
    const input = [summary({ threadId: "b", updatedAt: "2026-01-01T00:00:00.000Z" }), summary({ threadId: "a" })];
    const before = input.map((t) => t.threadId);
    sortThreads(input);
    expect(input.map((t) => t.threadId)).toEqual(before);
  });
});

describe("which thread opens", () => {
  const one = [summary({ threadId: "solo" })];
  const two = [summary({ threadId: "a" }), summary({ threadId: "b" })];

  it("goes straight into the only chat, exactly as before the list existed", () => {
    // Today's behavior, kept: a list of one is a tap that asks a question with
    // one answer.
    expect(initialThreadId(one)).toBe("solo");
  });

  it("shows the list when there is more than one", () => {
    expect(initialThreadId(two)).toBe(null);
  });

  it("opens the thread a link asked for", () => {
    // /chat/join lands somebody on ?t=<the thread they were just let into>.
    expect(initialThreadId(two, "b")).toBe("b");
  });

  it("ignores a thread that is not mine", () => {
    // A stale or copied ?t= must not open an empty thread view.
    expect(initialThreadId(two, "someone-elses-thread")).toBe(null);
    expect(initialThreadId(one, "someone-elses-thread")).toBe("solo");
  });

  it("has nothing to open when there are no chats at all", () => {
    expect(initialThreadId([], "anything")).toBe(null);
  });
});

describe("the words", () => {
  it("are bilingual, like every other sentence in /chat", () => {
    for (const line of [
      CHAT_LIST_CAPTION,
      CHAT_LIST_WAITING,
      CHAT_LIST_SOMEONE,
      CHAT_LIST_NO_MESSAGES
    ]) {
      expect(line, line).toContain(" · ");
    }
    // The back affordance is the exception on purpose: it is a word plus an
    // arrow on a small control, and "Chats" is the same word in both.
    expect(CHAT_LIST_BACK).toContain("Chats");
  });

  it("names no human being", () => {
    // The list labels itself from the other member's auth profile. A name
    // baked into the app would be a name for somebody who never gave it.
    for (const line of [
      CHAT_LIST_CAPTION,
      CHAT_LIST_BACK,
      CHAT_LIST_WAITING,
      CHAT_LIST_SOMEONE,
      CHAT_LIST_NO_MESSAGES
    ]) {
      expect(line, line).not.toMatch(/\b(Tom|Liz)\b/);
    }
  });
});
