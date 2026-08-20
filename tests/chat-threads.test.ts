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
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
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

// ── The route behind the list ──────────────────────────────────────────────
// GET /api/chat/threads run against real rows, for the same reason the invite
// tests do it: what matters here is which rows it is allowed to see and which
// language it resolves a preview in, and neither survives being mocked
// call-by-call.
interface Row {
  [key: string]: unknown;
}

const store = {
  taos_lite_chat_threads: [] as Row[],
  taos_lite_chat_members: [] as Row[],
  taos_lite_chat_messages: [] as Row[]
};

const profiles: Record<string, { email?: string | null; user_metadata?: Record<string, unknown> }> =
  {};

function makeBuilder(table: keyof typeof store) {
  const q = {
    filters: [] as Array<[string, string, unknown]>,
    ins: [] as Array<[string, unknown[]]>,
    order: null as null | { col: string; ascending: boolean },
    limit: Infinity
  };

  function run(): Promise<{ data: unknown; error: unknown }> {
    let rows = store[table].filter(
      (r) =>
        q.filters.every(([, col, val]) => r[col] === val) &&
        q.ins.every(([col, vals]) => vals.includes(r[col]))
    );
    if (q.order) {
      const { col, ascending } = q.order;
      rows = [...rows].sort((a, b) => {
        const av = String(a[col] ?? "");
        const bv = String(b[col] ?? "");
        return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    if (Number.isFinite(q.limit)) rows = rows.slice(0, q.limit);
    return Promise.resolve({ data: rows, error: null });
  }

  const builder = {
    select() {
      return builder;
    },
    eq(col: string, val: unknown) {
      q.filters.push(["eq", col, val]);
      return builder;
    },
    in(col: string, vals: unknown[]) {
      q.ins.push([col, vals]);
      return builder;
    },
    order(col: string, opts?: { ascending?: boolean }) {
      q.order = { col, ascending: opts?.ascending !== false };
      return builder;
    },
    limit(n: number) {
      q.limit = n;
      return builder;
    },
    async maybeSingle() {
      const r = await run();
      return { ...r, data: (r.data as Row[])[0] ?? null };
    },
    then(onOk: (v: { data: unknown; error: unknown }) => unknown, onErr?: (e: unknown) => unknown) {
      return run().then(onOk, onErr);
    }
  };
  return builder;
}

vi.mock("@/lib/supabaseAdmin", () => ({
  hasServiceRoleKey: true,
  supabaseAdmin: {
    from: (table: keyof typeof store) => makeBuilder(table),
    auth: {
      admin: {
        getUserById: async (id: string) =>
          profiles[id]
            ? { data: { user: { id, ...profiles[id] } }, error: null }
            : { data: { user: null }, error: null }
      }
    }
  }
}));

let caller: { id: string; email: string } | null = { id: ME, email: "me@example.com" };
vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async () => caller
}));

const { GET: threadsGet } = await import("@/app/api/chat/threads/route");

function get(): NextRequest {
  return new NextRequest("https://taoslite.com/api/chat/threads", {
    headers: { authorization: "Bearer whatever" }
  });
}

async function listed(): Promise<{
  status: number;
  myUserId?: string;
  threads: ChatThreadSummary[];
  error?: string;
}> {
  const res = await threadsGet(get());
  const body = (await res.json()) as { myUserId?: string; threads?: ChatThreadSummary[]; error?: string };
  return { status: res.status, myUserId: body.myUserId, threads: body.threads ?? [], error: body.error };
}

function seedThread(
  id: string,
  members: Array<{ user_id: string; lang: string }>,
  createdAt = "2026-07-01T00:00:00.000Z"
): void {
  store.taos_lite_chat_threads.push({ id, created_at: createdAt });
  for (const m of members) store.taos_lite_chat_members.push({ thread_id: id, ...m });
}

function seedMessage(threadId: string, over: Partial<Row> & { created_at: string }): void {
  store.taos_lite_chat_messages.push({
    thread_id: threadId,
    sender_id: THEM,
    kind: "text",
    body: "hola",
    body_translated: "hello",
    ...over
  });
}

afterEach(() => {
  store.taos_lite_chat_threads = [];
  store.taos_lite_chat_members = [];
  store.taos_lite_chat_messages = [];
  for (const key of Object.keys(profiles)) delete profiles[key];
  caller = { id: ME, email: "me@example.com" };
});

describe("GET /api/chat/threads", () => {
  it("returns every chat I am in, not just the first", async () => {
    // The whole point. lib/chat.ts used to answer with one membership and
    // /api/chat/join refused to make a second.
    seedThread("thread-a", [
      { user_id: ME, lang: "en" },
      { user_id: THEM, lang: "es" }
    ]);
    seedThread("thread-b", [{ user_id: ME, lang: "en" }]);
    const { status, myUserId, threads } = await listed();
    expect(status).toBe(200);
    expect(myUserId).toBe(ME);
    expect(threads.map((t) => t.threadId).sort()).toEqual(["thread-a", "thread-b"]);
  });

  it("never shows a chat I am not in", async () => {
    // The service role bypasses RLS, so the fence the policies would have
    // drawn is written by hand: every query is rooted in MY membership rows.
    seedThread("not-mine", [
      { user_id: THEM, lang: "es" },
      { user_id: "user-third", lang: "fr" }
    ]);
    seedMessage("not-mine", { created_at: "2026-08-19T10:00:00.000Z", body: "private" });
    const { threads } = await listed();
    expect(threads).toEqual([]);
  });

  it("previews each thread in MY language for THAT thread", async () => {
    // Per-membership languages stop being a schema detail here: one account,
    // two chats, two reading languages, two previews.
    seedThread("thread-en", [
      { user_id: ME, lang: "en" },
      { user_id: THEM, lang: "es" }
    ]);
    seedThread("thread-pl", [
      { user_id: ME, lang: "pl" },
      { user_id: "user-guide", lang: "es" }
    ]);
    seedMessage("thread-en", {
      created_at: "2026-08-19T10:00:00.000Z",
      body: "¿nos vemos?",
      body_translated: "shall we meet?"
    });
    seedMessage("thread-pl", {
      created_at: "2026-08-19T11:00:00.000Z",
      sender_id: "user-guide",
      body: "¿nos vemos?",
      body_translated: "spotkamy się?"
    });
    const { threads } = await listed();
    const byId = Object.fromEntries(threads.map((t) => [t.threadId, t]));
    expect(byId["thread-en"].myLang).toBe("en");
    expect(byId["thread-en"].preview).toBe("shall we meet?");
    expect(byId["thread-pl"].myLang).toBe("pl");
    expect(byId["thread-pl"].preview).toBe("spotkamy się?");
  });

  it("previews the LAST message, not the first one it finds", async () => {
    seedThread("thread-a", [
      { user_id: ME, lang: "en" },
      { user_id: THEM, lang: "es" }
    ]);
    seedMessage("thread-a", { created_at: "2026-08-01T10:00:00.000Z", body_translated: "older" });
    seedMessage("thread-a", { created_at: "2026-08-19T10:00:00.000Z", body_translated: "newest" });
    seedMessage("thread-a", { created_at: "2026-08-10T10:00:00.000Z", body_translated: "middle" });
    const { threads } = await listed();
    expect(threads[0].preview).toBe("newest");
    expect(threads[0].updatedAt).toBe("2026-08-19T10:00:00.000Z");
  });

  it("labels a row with the other member's own name", async () => {
    seedThread("thread-a", [
      { user_id: ME, lang: "en" },
      { user_id: THEM, lang: "es" }
    ]);
    profiles[THEM] = { email: "them@example.com", user_metadata: { full_name: "Ada L" } };
    const { threads } = await listed();
    expect(threads[0].partnerName).toBe("Ada L");
    expect(threads[0].partnerLang).toBe("es");
  });

  it("says 'Someone' rather than 'waiting' when a profile will not load", async () => {
    // A partner we cannot name is not an empty thread. Confusing the two puts
    // "Waiting for someone" on a chat with somebody already in it.
    seedThread("thread-a", [
      { user_id: ME, lang: "en" },
      { user_id: THEM, lang: "es" }
    ]);
    const { threads } = await listed();
    expect(threads[0].partnerName).toBe(CHAT_LIST_SOMEONE);
    expect(threads[0].partnerName).not.toBe(null);
  });

  it("marks a thread nobody has joined yet as having no partner at all", async () => {
    seedThread("thread-solo", [{ user_id: ME, lang: "en" }]);
    const { threads } = await listed();
    expect(threads[0].partnerName).toBe(null);
    expect(threads[0].partnerLang).toBe(null);
    expect(threadRowLabel(threads[0].partnerName)).toBe(CHAT_LIST_WAITING);
  });

  it("sorts an empty thread by when it was started", async () => {
    // It has to land somewhere, and the moment it was started is the only
    // thing that has happened to it.
    seedThread("thread-empty", [{ user_id: ME, lang: "en" }], "2026-08-19T19:02:19.000Z");
    seedThread("thread-old", [
      { user_id: ME, lang: "en" },
      { user_id: THEM, lang: "es" }
    ]);
    seedMessage("thread-old", { created_at: "2026-07-18T16:17:57.000Z" });
    const { threads } = await listed();
    expect(threads.map((t) => t.threadId)).toEqual(["thread-empty", "thread-old"]);
    expect(threads[0].preview).toBe(CHAT_LIST_NO_MESSAGES);
  });

  it("answers an empty list, not an error, for an account with no chats", async () => {
    const { status, threads } = await listed();
    expect(status).toBe(200);
    expect(threads).toEqual([]);
  });

  it("refuses a caller with no session", async () => {
    caller = null;
    seedThread("thread-a", [{ user_id: ME, lang: "en" }]);
    const { status, threads } = await listed();
    expect(status).toBe(401);
    expect(threads).toEqual([]);
  });
});

// ── The screen ─────────────────────────────────────────────────────────────
// Source-shape assertions, the same tool tests/chat-labels.test.ts uses on
// this component: what is being pinned is which state a thing is drawn from,
// and that is legible in the source and invisible to any assertion about
// rendered HTML that a phone-free suite could make.
describe("what /chat draws", () => {
  /** Source with its commentary stripped — the comments discuss the very
   *  things being asserted, including the refusal that was deleted. */
  function code(path: string): string {
    return readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  }
  const shell = code("components/ChatShell.tsx");
  const list = code("components/ChatThreadList.tsx");
  const join = code("components/ChatJoinShell.tsx");

  it("no longer tells anybody that TAOS holds one chat at a time", () => {
    // The sentence Tom hit, gone from the app rather than reworded — there is
    // nowhere left in the code where it could be true.
    for (const src of [shell, list, join, code("lib/chatInvite.ts")]) {
      expect(src).not.toContain("one at a time");
      expect(src).not.toContain("uno a la vez");
    }
  });

  it("swaps the messages when the open thread changes", () => {
    // The worst bug this screen could have is a bubble from chat A appearing
    // in chat B. History and the live subscription are keyed on the open
    // thread, so switching tears the old one down.
    expect(shell).toMatch(/subscribeMessages\(activeId/);
    expect(shell).toMatch(/listMessages\(activeId\)/);
    expect(shell).toMatch(/\[session, activeId, myUserId\]/);
  });

  it("swaps the language row with it", () => {
    // Every language on screen resolves from the OPEN thread, and the open
    // thread is derived from the list rather than stored beside it — so one
    // source of truth, and no render where the header and the list disagree.
    expect(shell).toMatch(/const thread = threads\?\.find\(\(t\) => t\.threadId === activeId\)/);
    expect(shell).toMatch(/isPairLangCode\(thread\?\.myLang\)/);
    expect(shell).toMatch(/isPairLangCode\(thread\?\.partnerLang\)/);
    expect(shell).toContain("theyReadLine(partnerLang)");
    expect(shell).toContain("outgoingLine(partnerLang)");
  });

  it("writes a language change to THIS thread's row only", () => {
    // lang is per-membership. A write that reached every row would silently
    // re-language a conversation nobody was looking at.
    expect(shell).toMatch(/row\.threadId === t\.threadId \? \{ \.\.\.row, myLang: lang \}/);
    expect(shell).toMatch(/setMyChatLanguage\(t\.threadId, code\)/);
  });

  it("clears the per-tap confirmation when the thread changes", () => {
    // The confirmation answers a tap in ONE chat. Carried across a switch it
    // would claim a language change in a thread that never had one.
    expect(shell).toMatch(/setConfirmedLang\(null\)[\s\S]{0,120}\}, \[activeId\]\)/);
  });

  it("keeps a door to the list from inside a single chat", () => {
    // One chat still opens straight into itself. Without this the account that
    // has exactly one chat is the account that can never start a second.
    expect(shell).toContain("CHAT_LIST_BACK");
    expect(shell).toContain("onClick={openList}");
    expect(shell).toMatch(/canReachList = loaded && threads\.length > 0/);
  });

  it("asks for the list out loud, so a solo chat cannot bounce back into itself", () => {
    // initialThreadId auto-opens the only chat on every load. A "Chats" tap
    // that only cleared the open thread would be undone by the next refresh.
    expect(shell).toMatch(/listOpen/);
    expect(shell).toMatch(/showList = loaded && threads\.length > 0 && \(listOpen \|\| !thread\)/);
  });

  it("starts a NEW chat from the list and invites into the open one", () => {
    // The whole distinction, at the two call sites that make it: Start passes
    // no thread, Invite passes the one on screen.
    expect(shell).toMatch(/onStart=\{\(\) => startOrInvite\(\)\}/);
    expect(shell).toMatch(/onInvite=\{\(\) => startOrInvite\(thread\.threadId\)\}/);
    expect(shell).toContain("<ChatThreadList");
  });

  it("sends somebody who just joined to the thread they joined", () => {
    // A bare /chat would open whichever chat sorts first, which for a person
    // who has just followed an invitation is any chat but the right one.
    expect(join).toMatch(/router\.replace\(`\/chat\?t=\$\{encodeURIComponent\(threadId\)\}`\)/);
  });

  it("shows a row's own preview and stamp, and nobody's name but theirs", () => {
    expect(list).toContain("threadRowLabel(t.partnerName)");
    expect(list).toContain("{t.preview}");
    expect(list).toContain("formatThreadStamp(t.updatedAt)");
    expect(list).not.toMatch(/\b(Tom|Liz)\b/);
  });
});
