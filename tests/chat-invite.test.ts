// The fence around how a second person gets into a /chat thread.
//
// Before 8/19 there was no way. The one row in taos_lite_chat_threads was
// typed into the SQL editor by hand in July, the tables have SELECT policies
// and nothing else, and no route in the app had ever inserted a membership.
// So /chat worked for exactly two accounts and dead-ended for every other one,
// with this, in English, shown to people who were already signed in:
//
//     "This account isn't part of a chat yet. Sign in with your own Google
//      account (not the shared passcode account)."
//
// Tom hit it on his second phone during the RC1 walkthrough. Two things are
// being pinned here, and the second one is the one that will rot first:
//
//   1. The invite mechanics — a token is single-use, it expires, it cannot
//      put a third person in a two-person thread, and it never decides WHO
//      joins (the session does).
//   2. The words. Every refusal on this path has to be a true statement about
//      the LINK. The moment one of them says "sign in" to somebody who is
//      signed in, the bug is back wearing different clothes.
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  CHAT_INVITE_LABEL,
  CHAT_JOIN_ALREADY_MEMBER,
  CHAT_JOIN_BAD_LINK,
  CHAT_JOIN_EXPIRED,
  CHAT_JOIN_FULL,
  CHAT_JOIN_USED,
  CHAT_NO_THREAD_BODY,
  CHAT_NO_THREAD_TITLE,
  CHAT_START_LABEL,
  INVITE_TOKEN_BYTES,
  inviteExpiry,
  invitePath,
  inviteUrl,
  isInviteExpired,
  isInviteToken,
  newInviteToken
} from "@/lib/chatInvite";
import { PRODUCTION_ORIGIN } from "@/lib/authRedirect";

// ── The in-memory database ─────────────────────────────────────────────────
// Enough of supabase-js's builder for the two routes to run against real
// rows: the point of these tests is the ORDER of the checks and what happens
// on a race, and neither survives being mocked call-by-call.
interface Row {
  [key: string]: unknown;
}

const store = {
  taos_lite_chat_threads: [] as Row[],
  taos_lite_chat_members: [] as Row[],
  taos_lite_chat_invites: [] as Row[]
};

/** Set by tests that want the two-member cap to fire the way the trigger does. */
let capMembers = true;

function reset(): void {
  store.taos_lite_chat_threads = [];
  store.taos_lite_chat_members = [];
  store.taos_lite_chat_invites = [];
  capMembers = true;
}

let nextThreadId = 1;

function makeBuilder(table: keyof typeof store) {
  const q = {
    op: "select" as "select" | "insert" | "update" | "delete",
    filters: [] as Array<[string, string, unknown]>,
    payload: null as Row | null,
    count: false,
    head: false
  };

  const rows = (): Row[] =>
    store[table].filter((r) =>
      q.filters.every(([kind, col, val]) => (kind === "is" ? r[col] === val : r[col] === val))
    );

  function run(): Promise<{ data: unknown; error: unknown; count?: number }> {
    if (q.op === "insert") {
      const payload = q.payload as Row;
      if (table === "taos_lite_chat_threads") {
        const row = { id: `thread-${nextThreadId++}`, ...payload };
        store[table].push(row);
        return Promise.resolve({ data: row, error: null });
      }
      if (table === "taos_lite_chat_members" && capMembers) {
        const already = store.taos_lite_chat_members.filter(
          (m) => m.thread_id === payload.thread_id
        ).length;
        // What the BEFORE INSERT trigger in the invites migration does.
        if (already >= 2) {
          return Promise.resolve({ data: null, error: { message: "two members already" } });
        }
      }
      // Column defaults the real schema supplies, so a row the route inserted
      // and a row a test seeded have the same shape.
      const row =
        table === "taos_lite_chat_invites"
          ? { accepted_by: null, accepted_at: null, ...payload }
          : { ...payload };
      store[table].push(row);
      return Promise.resolve({ data: { ...row }, error: null });
    }
    if (q.op === "update") {
      const matched = rows();
      for (const r of matched) Object.assign(r, q.payload);
      return Promise.resolve({ data: matched[0] ?? null, error: null });
    }
    if (q.op === "delete") {
      const doomed = new Set(rows());
      store[table] = store[table].filter((r) => !doomed.has(r));
      return Promise.resolve({ data: null, error: null });
    }
    const matched = rows();
    if (q.count) return Promise.resolve({ data: null, error: null, count: matched.length });
    return Promise.resolve({ data: matched, error: null });
  }

  const builder = {
    select(_columns?: string, opts?: { count?: string; head?: boolean }) {
      if (opts?.count) q.count = true;
      if (opts?.head) q.head = true;
      return builder;
    },
    insert(payload: Row) {
      q.op = "insert";
      q.payload = payload;
      return builder;
    },
    update(payload: Row) {
      q.op = "update";
      q.payload = payload;
      return builder;
    },
    delete() {
      q.op = "delete";
      return builder;
    },
    eq(col: string, val: unknown) {
      q.filters.push(["eq", col, val]);
      return builder;
    },
    is(col: string, val: unknown) {
      q.filters.push(["is", col, val]);
      return builder;
    },
    order() {
      return builder;
    },
    limit() {
      return builder;
    },
    async single() {
      const r = await run();
      const data = Array.isArray(r.data) ? r.data[0] ?? null : r.data;
      return { ...r, data };
    },
    async maybeSingle() {
      const r = await run();
      const data = Array.isArray(r.data) ? r.data[0] ?? null : r.data;
      return { ...r, data };
    },
    then(
      onOk: (v: { data: unknown; error: unknown; count?: number }) => unknown,
      onErr?: (e: unknown) => unknown
    ) {
      return run().then(onOk, onErr);
    }
  };
  return builder;
}

vi.mock("@/lib/supabaseAdmin", () => ({
  hasServiceRoleKey: true,
  supabaseAdmin: { from: (table: keyof typeof store) => makeBuilder(table) }
}));

// Who is calling. The routes must never take identity from the request body —
// only from here.
let caller: { id: string; email: string } | null = { id: "user-b", email: "b@example.com" };

vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async () => caller
}));

const { POST: joinPost } = await import("@/app/api/chat/join/route");
const { POST: invitePost } = await import("@/app/api/chat/invite/route");

function post(path: string, body: unknown, origin = "https://taoslite.com"): NextRequest {
  return new NextRequest(`https://taoslite.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body)
  });
}

function seedThread(id: string, members: Array<{ user_id: string; lang: string }>): void {
  store.taos_lite_chat_threads.push({ id });
  for (const m of members) store.taos_lite_chat_members.push({ thread_id: id, ...m });
}

function seedInvite(token: string, over: Partial<Row> = {}): void {
  store.taos_lite_chat_invites.push({
    token,
    thread_id: "thread-a",
    created_by: "user-a",
    expires_at: inviteExpiry(),
    accepted_by: null,
    accepted_at: null,
    ...over
  });
}

const TOKEN = newInviteToken();

afterEach(() => {
  reset();
  caller = { id: "user-b", email: "b@example.com" };
});

describe("the token", () => {
  it("is long, url-safe, and different every time", () => {
    const a = newInviteToken();
    const b = newInviteToken();
    expect(a).not.toBe(b);
    // 24 bytes of randomness. The token IS the credential — whoever holds it
    // becomes the other half of somebody's private conversation — so this is
    // sized to be unguessable, not to be read down a phone line.
    expect(INVITE_TOKEN_BYTES).toBeGreaterThanOrEqual(16);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(22);
    expect(isInviteToken(a)).toBe(true);
  });

  it("refuses anything that is not one", () => {
    for (const junk of ["", "short", "has spaces in it here", "../../etc/passwd", null, 7, {}]) {
      expect(isInviteToken(junk), String(junk)).toBe(false);
    }
    // A path separator would make the token a route of its own.
    expect(isInviteToken("abcdefghijklmnopqrstuv/w")).toBe(false);
  });

  it("expires, and an unreadable expiry counts as expired", () => {
    expect(isInviteExpired(inviteExpiry())).toBe(false);
    expect(isInviteExpired(new Date(Date.now() - 1000).toISOString())).toBe(true);
    expect(isInviteExpired("whenever")).toBe(true);
  });
});

describe("the link", () => {
  it("points at the deployment it was minted on", () => {
    // The opposite of /translate's QR, which is production forever: this one
    // carries a token that only exists on the database the inviter is talking
    // to, and a preview tester's link has to open the preview.
    const preview = "https://taos-lite-git-feat-trip-mode-xdrabbits-projects.vercel.app";
    expect(inviteUrl(preview, TOKEN)).toBe(`${preview}/chat/join/${TOKEN}`);
    expect(inviteUrl("http://localhost:3017", TOKEN)).toBe(
      `http://localhost:3017/chat/join/${TOKEN}`
    );
  });

  it("falls back to production for an origin we don't know", () => {
    // Same allow-list as Google sign-in and Stripe's success_url — this URL is
    // printed into a QR code for somebody else to scan.
    expect(inviteUrl("https://evil.com", TOKEN)).toBe(`${PRODUCTION_ORIGIN}/chat/join/${TOKEN}`);
    expect(inviteUrl(null, TOKEN)).toBe(`${PRODUCTION_ORIGIN}/chat/join/${TOKEN}`);
  });

  it("is one path, so the page and the QR cannot drift", () => {
    expect(invitePath(TOKEN)).toBe(`/chat/join/${TOKEN}`);
    expect(inviteUrl("https://taoslite.com", TOKEN)).toBe(
      `https://taoslite.com${invitePath(TOKEN)}`
    );
  });
});

describe("starting a chat", () => {
  it("creates the thread and the membership for an account that has neither", async () => {
    const res = await invitePost(post("/api/chat/invite", { lang: "es" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; threadId: string; created: boolean };
    expect(body.created).toBe(true);
    expect(store.taos_lite_chat_threads).toHaveLength(1);
    expect(store.taos_lite_chat_members).toEqual([
      { thread_id: body.threadId, user_id: "user-b", lang: "es" }
    ]);
    // The link is real and the token in it is the one that was stored.
    const token = body.url.split("/").pop() as string;
    expect(isInviteToken(token)).toBe(true);
    expect(store.taos_lite_chat_invites[0]).toMatchObject({
      token,
      thread_id: body.threadId,
      created_by: "user-b",
      accepted_at: null
    });
  });

  it("seeds the creator's language from their phone, validated against the catalog", async () => {
    await invitePost(post("/api/chat/invite", { lang: "Translate this into pirate" }));
    // Not the junk, and not a crash: the column is interpolated into the
    // translation prompts, so an unrecognized code has to become a real one.
    expect(store.taos_lite_chat_members[0].lang).toBe("en");
  });

  it("starts a SECOND chat for somebody who already has one", async () => {
    // The cap, from the other end. This route used to find the FIRST thread
    // the caller belonged to and re-use it forever, which is how an account
    // came to hold exactly one chat. Start is a button on a LIST now.
    seedThread("thread-a", [{ user_id: "user-b", lang: "en" }]);
    const res = await invitePost(post("/api/chat/invite", { lang: "en" }));
    const body = (await res.json()) as { threadId: string; created: boolean };
    expect(body.created).toBe(true);
    expect(body.threadId).not.toBe("thread-a");
    expect(store.taos_lite_chat_threads).toHaveLength(2);
    // Both memberships are real and the first one is untouched.
    expect(store.taos_lite_chat_members).toHaveLength(2);
    expect(store.taos_lite_chat_members[0]).toEqual({
      thread_id: "thread-a",
      user_id: "user-b",
      lang: "en"
    });
  });

  it("mints for the thread it was told to, not for the first one it finds", async () => {
    // "Invite someone" is pressed inside a particular chat. With two threads
    // on the account, the only thing that can say which is the body.
    seedThread("thread-a", [{ user_id: "user-b", lang: "en" }]);
    seedThread("thread-b", [{ user_id: "user-b", lang: "es" }]);
    const res = await invitePost(post("/api/chat/invite", { threadId: "thread-b" }));
    const body = (await res.json()) as { threadId: string; created: boolean };
    expect(body.created).toBe(false);
    expect(body.threadId).toBe("thread-b");
    expect(store.taos_lite_chat_threads).toHaveLength(2);
    expect(store.taos_lite_chat_invites[0]).toMatchObject({ thread_id: "thread-b" });
  });

  it("will not mint a link for a chat that is not mine", async () => {
    // A threadId is a body field, and a body field is never a permission.
    seedThread("thread-a", [{ user_id: "user-a", lang: "en" }]);
    const res = await invitePost(post("/api/chat/invite", { threadId: "thread-a" }));
    expect(res.status).toBe(403);
    expect(store.taos_lite_chat_invites).toHaveLength(0);
    // And it did not quietly start a chat instead.
    expect(store.taos_lite_chat_threads).toHaveLength(1);
  });

  it("retires the previous unused link, so only the one on screen works", async () => {
    seedThread("thread-a", [{ user_id: "user-b", lang: "en" }]);
    seedInvite("oldoldoldoldoldoldoldold");
    await invitePost(post("/api/chat/invite", { threadId: "thread-a" }));
    const live = store.taos_lite_chat_invites.map((i) => i.token);
    expect(live).toHaveLength(1);
    expect(live[0]).not.toBe("oldoldoldoldoldoldoldold");
  });

  it("retires only the named thread's link, never another chat's", async () => {
    // With more than one chat on the account, "tap invite again and the old
    // link stops working" has to mean the old link FOR THIS CHAT.
    seedThread("thread-a", [{ user_id: "user-b", lang: "en" }]);
    seedThread("thread-b", [{ user_id: "user-b", lang: "en" }]);
    seedInvite("aaaaaaaaaaaaaaaaaaaaaaaa", { thread_id: "thread-a" });
    await invitePost(post("/api/chat/invite", { threadId: "thread-b" }));
    expect(store.taos_lite_chat_invites.map((i) => i.token)).toContain(
      "aaaaaaaaaaaaaaaaaaaaaaaa"
    );
  });

  it("will not mint a link for a chat that already has two people", async () => {
    seedThread("thread-a", [
      { user_id: "user-b", lang: "en" },
      { user_id: "user-a", lang: "es" }
    ]);
    const res = await invitePost(post("/api/chat/invite", { threadId: "thread-a" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(CHAT_JOIN_FULL);
    expect(store.taos_lite_chat_invites).toHaveLength(0);
  });

  it("refuses a caller with no session", async () => {
    caller = null;
    const res = await invitePost(post("/api/chat/invite", {}));
    expect(res.status).toBe(401);
    expect(store.taos_lite_chat_threads).toHaveLength(0);
  });
});

describe("joining with a link", () => {
  it("puts the SIGNED-IN account in the thread, whatever the body says", async () => {
    seedThread("thread-a", [{ user_id: "user-a", lang: "en" }]);
    seedInvite(TOKEN);
    const res = await joinPost(
      post("/api/chat/join", { token: TOKEN, lang: "es", userId: "user-somebody-else" })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ threadId: "thread-a", joined: true });
    expect(store.taos_lite_chat_members).toContainEqual({
      thread_id: "thread-a",
      user_id: "user-b",
      lang: "es"
    });
  });

  it("burns the token — the second phone to try gets an honest answer", async () => {
    seedThread("thread-a", [{ user_id: "user-a", lang: "en" }]);
    seedInvite(TOKEN);
    await joinPost(post("/api/chat/join", { token: TOKEN }));

    caller = { id: "user-c", email: "c@example.com" };
    const res = await joinPost(post("/api/chat/join", { token: TOKEN }));
    expect(res.status).toBe(410);
    expect((await res.json()).error).toBe(CHAT_JOIN_USED);
    expect(store.taos_lite_chat_members.filter((m) => m.thread_id === "thread-a")).toHaveLength(2);
  });

  it("never lets a third person in, even if a second link exists", async () => {
    // The route counts, and the database's trigger counts again. This is the
    // second one: a link minted while the thread was still one person, redeemed
    // after it became two.
    seedThread("thread-a", [
      { user_id: "user-a", lang: "en" },
      { user_id: "user-d", lang: "es" }
    ]);
    seedInvite(TOKEN);
    const res = await joinPost(post("/api/chat/join", { token: TOKEN }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(CHAT_JOIN_FULL);
    expect(store.taos_lite_chat_members).toHaveLength(2);
    // And the link was NOT burned by a refusal that was nothing to do with it.
    expect(store.taos_lite_chat_invites[0].accepted_at).toBe(null);
  });

  it("gives the link back when the membership write loses a race", async () => {
    // The claim succeeds, then the cap trigger fires. A link burned by
    // somebody else's race is one its owner has to re-mint for no reason they
    // could ever see.
    seedThread("thread-a", [{ user_id: "user-a", lang: "en" }]);
    seedInvite(TOKEN);
    let calls = 0;
    const realFilter = Array.prototype.filter;
    // Let the route's own count see one member, and the insert see three.
    vi.spyOn(store.taos_lite_chat_members, "filter").mockImplementation(function (
      this: Row[],
      ...args: Parameters<typeof realFilter>
    ) {
      calls += 1;
      const out = realFilter.apply(this, args) as Row[];
      return calls > 1 ? [...out, {}, {}] : out;
    } as never);
    const res = await joinPost(post("/api/chat/join", { token: TOKEN }));
    vi.restoreAllMocks();
    expect(res.status).toBe(409);
    expect(store.taos_lite_chat_invites[0].accepted_at).toBe(null);
    expect(store.taos_lite_chat_invites[0].accepted_by).toBe(null);
  });

  it("refuses an expired link", async () => {
    seedThread("thread-a", [{ user_id: "user-a", lang: "en" }]);
    seedInvite(TOKEN, { expires_at: new Date(Date.now() - 1000).toISOString() });
    const res = await joinPost(post("/api/chat/join", { token: TOKEN }));
    expect(res.status).toBe(410);
    expect((await res.json()).error).toBe(CHAT_JOIN_EXPIRED);
    expect(store.taos_lite_chat_members).toHaveLength(1);
  });

  it("refuses a token nobody minted, without touching anything", async () => {
    seedThread("thread-a", [{ user_id: "user-a", lang: "en" }]);
    const res = await joinPost(post("/api/chat/join", { token: newInviteToken() }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe(CHAT_JOIN_BAD_LINK);
    expect(store.taos_lite_chat_members).toHaveLength(1);
  });

  it("refuses a token that is not token-shaped before it reaches the database", async () => {
    for (const junk of ["", "x", "../../admin", { token: 1 }]) {
      const res = await joinPost(post("/api/chat/join", { token: junk }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(CHAT_JOIN_BAD_LINK);
    }
  });

  it("tells someone who is already in the chat exactly that", async () => {
    // The inviter scanning their own QR, or the joiner reopening the link.
    // Neither is an error and neither should hear the link is broken.
    seedThread("thread-a", [{ user_id: "user-b", lang: "en" }]);
    seedInvite(TOKEN, { created_by: "user-b" });
    const res = await joinPost(post("/api/chat/join", { token: TOKEN }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { joined: boolean; message: string; threadId: string };
    expect(body).toMatchObject({ threadId: "thread-a", joined: false });
    expect(body.message).toBe(CHAT_JOIN_ALREADY_MEMBER);
    expect(store.taos_lite_chat_members).toHaveLength(1);
  });

  it("lets somebody who already has a chat join another one", async () => {
    // The refusal this replaces read "You're already in a chat, and TAOS holds
    // one at a time" — the sentence Tom hit on his own app during the
    // two-phone walkthrough. It was honest about a screen with no switcher.
    // /chat has a list now (lib/chatThreads.ts), so a second membership is a
    // second row rather than a link that appears to do nothing.
    seedThread("thread-a", [{ user_id: "user-a", lang: "en" }]);
    seedThread("thread-mine", [{ user_id: "user-b", lang: "en" }]);
    seedInvite(TOKEN);
    const res = await joinPost(post("/api/chat/join", { token: TOKEN, lang: "es" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ threadId: "thread-a", joined: true });
    // Both memberships, and the one that was already there is untouched —
    // its language included, because lang is per-thread.
    expect(store.taos_lite_chat_members).toEqual([
      { thread_id: "thread-a", user_id: "user-a", lang: "en" },
      { thread_id: "thread-mine", user_id: "user-b", lang: "en" },
      { thread_id: "thread-a", user_id: "user-b", lang: "es" }
    ]);
  });

  it("still refuses a third person, however many chats they are in", async () => {
    // Multiples is about how many threads a PERSON holds. How many people a
    // THREAD holds is unchanged and is not negotiable: the send route
    // translates into exactly one partner language.
    seedThread("thread-full", [
      { user_id: "user-a", lang: "en" },
      { user_id: "user-d", lang: "es" }
    ]);
    seedThread("thread-mine", [{ user_id: "user-b", lang: "en" }]);
    seedInvite(TOKEN, { thread_id: "thread-full" });
    const res = await joinPost(post("/api/chat/join", { token: TOKEN }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(CHAT_JOIN_FULL);
    expect(store.taos_lite_chat_members).toHaveLength(3);
  });

  it("refuses a caller with no session", async () => {
    caller = null;
    seedThread("thread-a", [{ user_id: "user-a", lang: "en" }]);
    seedInvite(TOKEN);
    const res = await joinPost(post("/api/chat/join", { token: TOKEN }));
    expect(res.status).toBe(401);
    expect(store.taos_lite_chat_members).toHaveLength(1);
  });
});

describe("what the screens say", () => {
  /** Source with its commentary stripped — the comments quote the very
   *  sentence being banned, and that history is worth keeping. */
  function code(file: string): string {
    return readFileSync(new URL(`../components/${file}`, import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  }
  const shell = code("ChatShell.tsx");
  const join = code("ChatJoinShell.tsx");

  it("no longer tells a signed-in person to sign in", () => {
    // The exact sentence Tom's second Google account was shown, and the shape
    // of it: /chat renders this only AFTER a session exists, so any
    // instruction to authenticate there is false by construction.
    expect(shell).not.toContain("Sign in with your own Google account");
    expect(shell).not.toContain("shared passcode account");
    const inAppCopy = [
      CHAT_NO_THREAD_TITLE,
      CHAT_NO_THREAD_BODY,
      CHAT_START_LABEL,
      CHAT_INVITE_LABEL,
      CHAT_JOIN_BAD_LINK,
      CHAT_JOIN_USED,
      CHAT_JOIN_EXPIRED,
      CHAT_JOIN_FULL,
      CHAT_JOIN_ALREADY_MEMBER
    ];
    for (const line of inAppCopy) {
      expect(line.toLowerCase(), line).not.toMatch(/sign in|inicia sesión/);
    }
  });

  it("offers the way in from the state that has no chat", () => {
    expect(shell).toContain("ChatStartCard");
    expect(shell).toContain("ChatInviteRow");
    expect(shell).toContain("startOrInvite");
  });

  it("says everything in both languages", () => {
    // "English · Español", the app's convention, because the two people in a
    // thread read the same layout in different languages — and the person
    // being invited has not picked one yet.
    for (const line of [
      CHAT_NO_THREAD_TITLE,
      CHAT_NO_THREAD_BODY,
      CHAT_START_LABEL,
      CHAT_INVITE_LABEL,
      CHAT_JOIN_BAD_LINK,
      CHAT_JOIN_USED,
      CHAT_JOIN_EXPIRED,
      CHAT_JOIN_FULL,
      CHAT_JOIN_ALREADY_MEMBER
    ]) {
      expect(line, line).toContain(" · ");
    }
  });

  it("carries the invite path through sign-in, or the token is lost", () => {
    // A signed-out stranger scanning the QR is the ONLY user this page has on
    // its first render. Google has to bring them back to the invite, not to
    // the home screen.
    expect(join).toContain("redirectPath={invitePath(token)}");
  });
});

describe("the schema", () => {
  const MIGRATIONS = new URL("../supabase/migrations/", import.meta.url);
  const sql = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(new URL(f, MIGRATIONS), "utf8"))
    .join("\n")
    // The commentary talks about the very things being asserted.
    .replace(/^\s*--.*$/gm, "");

  it("creates the invites table", () => {
    expect(sql).toMatch(/create table if not exists public\.taos_lite_chat_invites/i);
    for (const col of ["thread_id", "created_by", "expires_at", "accepted_by", "accepted_at"]) {
      expect(sql, col).toContain(col);
    }
  });

  it("keeps the tokens away from the browser", () => {
    // RLS on, and NOT ONE policy: a signed-in browser has no business listing
    // invite tokens, and every write on this table is the service role's.
    expect(sql).toMatch(/alter table public\.taos_lite_chat_invites\s+enable row level security/i);
    expect(sql).not.toMatch(/create policy[^;]*taos_lite_chat_invites/i);
  });

  it("agrees with the code about what a token looks like", () => {
    const match = sql.match(/check\s*\(\s*token\s*~\s*'([^']+)'\s*\)/i);
    expect(match, "the migration must constrain the token by shape").toBeTruthy();
    const shape = new RegExp(match![1]);
    for (let i = 0; i < 20; i++) {
      const token = newInviteToken();
      expect(shape.test(token), token).toBe(true);
      expect(isInviteToken(token)).toBe(true);
    }
    expect(shape.test("../../etc/passwd")).toBe(false);
    expect(shape.test("")).toBe(false);
  });

  it("does not cap an ACCOUNT at one chat", () => {
    // The cap Tom hit was never in the schema. taos_lite_chat_members is keyed
    // (thread_id, user_id) — one row per person per thread — and nothing has
    // ever constrained user_id on its own, which was confirmed against
    // pg_constraint and pg_indexes on the live project before this PR touched
    // a line of the routes. The base tables predate this migrations folder
    // (they were applied 20260718161757, before the repo kept SQL), so the
    // only thing this file CAN assert is that nothing here reintroduces one.
    expect(sql).not.toMatch(/unique[^;]*\(\s*user_id\s*\)/i);
    // The query the list asks on every /chat load, indexed.
    expect(sql).toMatch(
      /create index if not exists taos_lite_chat_members_user_idx[\s\S]*?\(user_id\)/i
    );
  });

  it("caps a thread at two people in the database too", () => {
    // lib/chat.ts reads a thread as "me and the one other member" — find(),
    // not filter() — and /api/chat/send translates into exactly one partner
    // language. A third member would make a third of the messages invisible
    // to somebody.
    expect(sql).toMatch(/create trigger taos_lite_chat_members_cap_trg/i);
    expect(sql).toMatch(/before insert on public\.taos_lite_chat_members/i);
    // The count is only trustworthy if concurrent joins are serialized.
    expect(sql).toMatch(/for update/i);
  });
});
