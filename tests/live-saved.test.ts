// /live "Save this conversation" — the server half (Tom and Liz, 2026-11-17).
//
// Conservative on purpose, and each default is pinned here:
//
//   · TEXT ONLY — there is nowhere in the request, the store or the schema to
//     put audio;
//   · founders only unless TAOS_LIVE_SAVE widens it, and a knob that cannot be
//     read is `founders`, not `all`;
//   · writes go through the service role AFTER the auth and audience checks;
//     the tables' own RLS gives a user select + delete on their own rows and
//     no way to insert or update;
//   · tables missing → `ready:false` / `not_ready`, never an error;
//   · reading and deleting what you saved needs only a sign-in;
//   · no log line ever carries what anybody said.
//
// The routes are the real handlers; only auth and the Supabase client are
// stand-ins (a small in-memory PostgREST below).
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { liveSaveAllowed, liveSaveAudience } from "@/lib/live/saveAccess";
import { savedConversationAsText, type SavedLiveLine, type SavedLiveSession } from "@/lib/live/saved";

// ── Stand-ins ───────────────────────────────────────────────────────────────

let caller: { id: string; email: string } | null = null;

vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async (req: Request) => {
    const header = req.headers.get("authorization") ?? "";
    return header.startsWith("Bearer ") && caller ? caller : null;
  }
}));

type Row = Record<string, unknown>;
const db: {
  tables: Record<string, Row[]> | null;
  profiles: Row[];
  writes: number;
  /** PostgREST's row cap. Production's is 1,000, whatever `.limit()` asks for. */
  maxRows: number;
  /** Every select that was run: the table and the rows it asked for. */
  reads: Array<{ table: string; from: number; asked: number }>;
} = {
  tables: null,
  profiles: [],
  writes: 0,
  maxRows: 1000,
  reads: []
};
const SESSIONS = "taos_lite_live_sessions";
const LINES = "taos_lite_live_lines";

function table(name: string) {
  const filters: Array<[string, unknown]> = [];
  let op: "select" | "update" | "delete" | "upsert" = "select";
  let payload: Row = {};
  let conflict: string[] = [];
  let columns = "";
  let wantCount = false;
  const orders: Array<[string, boolean]> = [];
  let from = 0;
  let asked = Infinity;
  const run = (): { data: Row[] | null; error: Row | null; count?: number | null } => {
    if (name === "profiles") return { data: db.profiles.filter((r) => filters.every(([k, v]) => r[k] === v)), error: null };
    if (!db.tables) return { data: null, error: { code: "PGRST205", message: "Could not find the table" } };
    const rows = db.tables[name];
    const hit = (r: Row) => filters.every(([k, v]) => r[k] === v);
    if (op === "upsert") {
      db.writes += 1;
      if (!rows.some((r) => conflict.every((k) => r[k] === payload[k]))) rows.push({ ...payload });
      return { data: null, error: null };
    }
    if (op === "update") {
      db.writes += 1;
      const touched = rows.filter(hit);
      touched.forEach((r) => Object.assign(r, payload));
      return { data: touched.map((r) => ({ id: r.id })), error: null };
    }
    if (op === "delete") {
      db.writes += 1;
      const gone = rows.filter(hit);
      db.tables[name] = rows.filter((r) => !hit(r));
      if (name === SESSIONS) {
        db.tables[LINES] = db.tables[LINES].filter((l) => !gone.some((g) => g.id === l.session_id));
      }
      return { data: gone.map((r) => ({ id: r.id })), error: null };
    }
    const found = rows.filter(hit).map((r) =>
      columns.includes(`${LINES}(count)`)
        ? { ...r, [LINES]: [{ count: db.tables![LINES].filter((l) => l.session_id === r.id).length }] }
        : r
    );
    for (const [col, ascending] of [...orders].reverse()) {
      found.sort((a, b) => (a[col]! < b[col]! ? -1 : a[col]! > b[col]! ? 1 : 0) * (ascending ? 1 : -1));
    }
    db.reads.push({ table: name, from, asked });
    // What the real one does (measured against production, 2026-11-17): a
    // range that starts past the end is a 416; otherwise at most `maxRows`
    // rows come back, with a success status and no error, however many were
    // asked for.
    if (from > 0 && from >= found.length) {
      return { data: null, error: { code: "PGRST103", message: "Requested range not satisfiable" }, count: null };
    }
    return {
      data: found.slice(from, from + Math.min(asked, db.maxRows)),
      error: null,
      count: wantCount ? found.length : null
    };
  };
  const q: Record<string, unknown> = {
    select: (c: string, o?: { count?: string }) => ((columns = c ?? ""), (wantCount = o?.count === "exact"), q),
    upsert: (p: Row, o: { onConflict: string }) => ((op = "upsert"), (payload = p), (conflict = o.onConflict.split(",")), q),
    update: (p: Row) => ((op = "update"), (payload = p), q),
    delete: () => ((op = "delete"), q),
    eq: (k: string, v: unknown) => (filters.push([k, v]), q),
    order: (col: string, o?: { ascending?: boolean }) => (orders.push([col, o?.ascending !== false]), q),
    limit: (n: number) => ((asked = n), q),
    range: (a: number, b: number) => ((from = a), (asked = b - a + 1), q),
    maybeSingle: async () => {
      const r = run();
      return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : null, error: r.error };
    },
    then: (resolve: (v: unknown) => void) => resolve(run())
  };
  return q;
}

vi.mock("@/lib/supabaseAdmin", () => ({
  hasServiceRoleKey: true,
  supabaseAdmin: { from: (name: string) => table(name) }
}));

const FOUNDER = { id: "11111111-1111-4111-8111-111111111111", email: "xdrabbit@gmail.com" };
const STRANGER = { id: "22222222-2222-4222-8222-222222222222", email: "someone@example.com" };
const SID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HEARD = "¿Dónde está el baño, por favor?";
const TEXT = "Where is the bathroom, please?";

let logs: string[] = [];

beforeEach(async () => {
  caller = FOUNDER;
  db.tables = { [SESSIONS]: [], [LINES]: [] };
  db.profiles = [];
  db.writes = 0;
  db.maxRows = 1000;
  db.reads = [];
  delete process.env.TAOS_LIVE_SAVE;
  logs = [];
  for (const level of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  }
  (await import("@/lib/live/savedStore")).resetLiveSaveReadiness();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TAOS_LIVE_SAVE;
});

function request(path: string, init: { method?: string; body?: unknown; signedIn?: boolean } = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(init.signedIn === false ? {} : { authorization: "Bearer token" })
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
  });
}

const body = (over: { session?: Row; line?: Row } = {}) => ({
  session: { id: SID, mine: "en", theirs: "es", style: "verbatim", auto: true, startedAt: "2026-11-17T20:00:00.000Z", ...over.session },
  line: { seq: 1, heard: HEARD, heardLang: "es", text: TEXT, textLang: "en", detect: "hit", ...over.line }
});

async function status(signedIn = true) {
  const { GET } = await import("@/app/api/live/saved/status/route");
  const res = await GET(request("/api/live/saved/status", { signedIn }));
  return { res, json: (await res.json()) as Record<string, unknown> };
}
async function save(b: unknown, signedIn = true) {
  const { POST } = await import("@/app/api/live/saved/lines/route");
  return POST(request("/api/live/saved/lines", { method: "POST", body: b, signedIn }));
}
async function list(query = "") {
  const { GET } = await import("@/app/api/live/saved/route");
  const res = await GET(request(`/api/live/saved${query}`));
  return { res, json: (await res.json()) as { ready: boolean; canSave: boolean; sessions: Row[]; more: boolean } };
}
async function one(id: string, method: "GET" | "DELETE" = "GET", query = "") {
  const route = await import("@/app/api/live/saved/[id]/route");
  return route[method](request(`/api/live/saved/${id}${query}`, { method }), { params: { id } });
}

// ── The knob ────────────────────────────────────────────────────────────────

describe("TAOS_LIVE_SAVE", () => {
  it("is founders unless it says exactly subscribers or all", () => {
    expect(liveSaveAudience(undefined)).toBe("founders");
    expect(liveSaveAudience("")).toBe("founders");
    expect(liveSaveAudience("everyone")).toBe("founders");
    expect(liveSaveAudience("1")).toBe("founders");
    expect(liveSaveAudience(" Subscribers ")).toBe("subscribers");
    expect(liveSaveAudience("ALL")).toBe("all");
  });

  it("founders are in every audience; a stranger only in the wider ones", async () => {
    const paid = async () => true;
    const free = async () => false;
    for (const audience of ["founders", "subscribers", "all"] as const) {
      expect(await liveSaveAllowed(FOUNDER, { audience, isSubscriber: free })).toBe(true);
    }
    expect(await liveSaveAllowed(STRANGER, { audience: "founders", isSubscriber: paid })).toBe(false);
    expect(await liveSaveAllowed(STRANGER, { audience: "subscribers", isSubscriber: free })).toBe(false);
    expect(await liveSaveAllowed(STRANGER, { audience: "subscribers", isSubscriber: paid })).toBe(true);
    expect(await liveSaveAllowed(STRANGER, { audience: "all", isSubscriber: free })).toBe(true);
  });

  it("is read per request, so widening it needs no deploy", async () => {
    caller = STRANGER;
    expect((await status()).json).toEqual({ allowed: false, ready: false, hasSaved: false });
    process.env.TAOS_LIVE_SAVE = "all";
    expect((await status()).json).toEqual({ allowed: true, ready: true, hasSaved: false });
    process.env.TAOS_LIVE_SAVE = "subscribers";
    expect((await status()).json.allowed).toBe(false);
    db.profiles = [{ id: STRANGER.id, subscription_status: "active", tier: "basic" }];
    expect((await status()).json.allowed).toBe(true);
  });
});

// ── Degrading cleanly ───────────────────────────────────────────────────────

describe("before the migration is applied", () => {
  beforeEach(() => {
    db.tables = null;
  });

  it("status says allowed but not ready — the toggle's disabled state — with no error", async () => {
    const { res, json } = await status();
    expect(res.status).toBe(200);
    expect(json).toEqual({ allowed: true, ready: false, hasSaved: false });
  });

  it("a write is refused as not_ready and nothing is attempted", async () => {
    const res = await save(body());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_ready" });
    expect(db.writes).toBe(0);
  });

  it("the list is empty and says so; one conversation is a plain 404", async () => {
    const { res, json } = await list();
    expect(res.status).toBe(200);
    expect(json).toEqual({ ready: false, canSave: true, sessions: [], more: false });
    expect((await one(SID)).status).toBe(404);
  });
});

// ── Writing ─────────────────────────────────────────────────────────────────

describe("POST /api/live/saved/lines", () => {
  it("is behind sign-in, then the audience — a stranger gets a 404, not a 403", async () => {
    expect((await save(body(), false)).status).toBe(401);
    caller = STRANGER;
    expect((await save(body())).status).toBe(404);
    expect(db.writes).toBe(0);
  });

  it("creates the session with its first line and stores the line as text", async () => {
    expect((await save(body())).status).toBe(200);
    expect(db.tables![SESSIONS]).toHaveLength(1);
    expect(db.tables![SESSIONS][0]).toMatchObject({
      id: SID,
      user_id: FOUNDER.id,
      lang_mine: "en",
      lang_theirs: "es",
      style: "verbatim",
      auto: true,
      started_at: "2026-11-17T20:00:00.000Z"
    });
    expect(db.tables![LINES]).toEqual([
      {
        session_id: SID,
        user_id: FOUNDER.id,
        seq: 1,
        heard_text: HEARD,
        heard_lang: "es",
        translation: TEXT,
        translation_lang: "en",
        detect: "hit"
      }
    ]);
  });

  it("is idempotent per (session, seq): a retried line is one row", async () => {
    await save(body());
    await save(body());
    await save(body({ line: { seq: 2, heard: "Gracias.", text: "Thanks." } }));
    expect(db.tables![SESSIONS]).toHaveLength(1);
    expect(db.tables![LINES].map((l) => l.seq)).toEqual([1, 2]);
  });

  it("a miss stores no language, whatever the body claims", async () => {
    await save(body({ line: { detect: "miss", heardLang: "es", textLang: "en" } }));
    expect(db.tables![LINES][0]).toMatchObject({ heard_lang: null, translation_lang: null, detect: "miss" });
  });

  it("cannot write into somebody else's session by sending its id", async () => {
    await save(body());
    process.env.TAOS_LIVE_SAVE = "all";
    caller = STRANGER;
    const res = await save(body({ line: { seq: 7, heard: "x y z", text: "planted" } }));
    expect(res.status).toBe(404);
    expect(db.tables![SESSIONS][0].user_id).toBe(FOUNDER.id);
    expect(db.tables![LINES].map((l) => l.seq)).toEqual([1]);
  });

  it("refuses what it does not store: no id, no text, an unknown language, a non-numeric seq", async () => {
    for (const bad of [
      body({ session: { id: "nope" } }),
      body({ line: { text: "   " } }),
      body({ session: { mine: "klingon" } }),
      body({ line: { seq: "1" } }),
      null,
      "text"
    ]) {
      expect((await save(bad)).status).toBe(400);
    }
    expect(db.writes).toBe(0);
  });

  it("has nowhere to put audio: an extra field is simply not stored", async () => {
    await save({ ...body(), audio: "AAAA", line: { ...body().line, audio: "AAAA", clip_path: "x.webm" } });
    expect(Object.keys(db.tables![LINES][0]).sort()).toEqual(
      ["detect", "heard_lang", "heard_text", "seq", "session_id", "translation", "translation_lang", "user_id"].sort()
    );
  });
});

// ── Reading, exporting, deleting ────────────────────────────────────────────

describe("the user's own saved conversations", () => {
  beforeEach(async () => {
    await save(body());
    await save(body({ line: { seq: 2, heard: "Down the hall.", heardLang: "en", text: "Al fondo.", textLang: "es" } }));
    await save(body({ line: { seq: 3, heard: "Gracias.", text: "Thanks.", detect: "miss" } }));
  });

  it("lists them with a line count, and only one's own", async () => {
    const mine = await list();
    expect(mine.json.sessions).toHaveLength(1);
    expect(mine.json.sessions[0]).toMatchObject({ id: SID, line_count: 3, auto: true });
    caller = STRANGER;
    const theirs = await list();
    // Signed in is enough to ask; they simply have none, and may not add any.
    expect(theirs.json).toEqual({ ready: true, canSave: false, sessions: [], more: false });
  });

  it("reads one in order; somebody else's id is a 404", async () => {
    const res = await one(SID);
    const json = (await res.json()) as { session: Row; lines: Row[]; total: number; complete: boolean };
    expect(json.session.id).toBe(SID);
    expect(json.lines.map((l) => l.seq)).toEqual([1, 2, 3]);
    expect(json.total).toBe(3);
    expect(json.complete).toBe(true);
    caller = STRANGER;
    expect((await one(SID)).status).toBe(404);
    expect((await one(SID, "DELETE")).status).toBe(404);
    expect(db.tables![SESSIONS]).toHaveLength(1);
  });

  it("exports it as a text file: every line, both halves, each with its language", async () => {
    const res = await one(SID, "GET", "?format=text");
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="taos-live-2026-11-17-aaaaaaaa.txt"');
    const text = await res.text();
    expect(text).toContain("English ⇄ Español · word for word · auto-detect");
    expect(text).toContain(`1.\n[Español] ${HEARD}\n[English] ${TEXT}`);
    expect(text).toContain("2.\n[English] Down the hall.\n[Español] Al fondo.");
    expect(text).toContain("3. (language not detected)\n[??] Gracias.\n[??] Thanks.");
  });

  it("deletes it for good, lines and all — and a second delete is a 404", async () => {
    const res = await one(SID, "DELETE");
    expect(await res.json()).toEqual({ deleted: true });
    expect(db.tables![SESSIONS]).toEqual([]);
    expect(db.tables![LINES]).toEqual([]);
    expect((await one(SID, "DELETE")).status).toBe(404);
  });

  it("stays readable and deletable after the audience is narrowed past its owner", async () => {
    process.env.TAOS_LIVE_SAVE = "all";
    caller = STRANGER;
    const theirs = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    expect((await save(body({ session: { id: theirs } }))).status).toBe(200);
    delete process.env.TAOS_LIVE_SAVE;
    expect((await save(body({ session: { id: theirs }, line: { seq: 2 } }))).status).toBe(404);
    expect((await list()).json.sessions.map((s) => s.id)).toEqual([theirs]);
    // Copilot on #137: …and the way to it stays on /live. `allowed` is false
    // now, so the screen has no Save chip; `hasSaved` is what draws the link.
    expect((await status()).json).toEqual({ allowed: false, ready: false, hasSaved: true });
    expect((await one(theirs)).status).toBe(200);
    expect((await one(theirs, "DELETE")).status).toBe(200);
    // Nothing left: the link goes with it.
    expect((await status()).json).toEqual({ allowed: false, ready: false, hasSaved: false });
  });

  it("someone who never saved and may not save is told nothing new — and nobody else's count is theirs", async () => {
    caller = STRANGER;
    // The founder's conversation from beforeEach is in the table.
    expect(db.tables![SESSIONS]).toHaveLength(1);
    expect((await status()).json).toEqual({ allowed: false, ready: false, hasSaved: false });
  });

  it("never logs what anybody said — ids and counts only", async () => {
    await one(SID);
    await one(SID, "GET", "?format=text");
    await list();
    await one(SID, "DELETE");
    const all = logs.join("\n");
    expect(logs.some((l) => l.startsWith("[taos-live-save] line session="))).toBe(true);
    for (const said of [HEARD, TEXT, "baño", "bathroom", "Gracias", "Thanks", "Al fondo", "Down the hall"]) {
      expect(all).not.toContain(said);
    }
    expect(all).toContain(`[taos-live-save] line session=${SID} seq=1 heard_chars=${HEARD.length} text_chars=${TEXT.length} detect=hit auto=1`);
  });
});

// ── Nothing saved is out of reach (Copilot on #137) ─────────────────────────
//
// Both findings were the same shape: a `.limit()` standing in for "all of it".
// The list stopped at 200 conversations with no way to the 201st, and one
// conversation was read with `.limit(5000)` — which this project's PostgREST
// answers with 1,000 rows and no error (see LIVE_SAVED_LINES_PAGE). The fake
// database above has that cap, so these fail against the old code.

/** Put rows straight into the tables: one write per row through the route is 1,300 round trips. */
function seedConversation(id: string, lines: number, startedAt = "2026-11-17T20:00:00.000Z", userId = FOUNDER.id) {
  db.tables![SESSIONS].push({
    id,
    user_id: userId,
    lang_mine: "en",
    lang_theirs: "es",
    style: "verbatim",
    auto: true,
    started_at: startedAt,
    ended_at: startedAt
  });
  // Stored out of order on purpose: the order is the query's job.
  for (let seq = lines; seq >= 1; seq -= 1) {
    db.tables![LINES].push({
      session_id: id,
      user_id: userId,
      seq,
      heard_text: `oído ${seq}`,
      heard_lang: "es",
      translation: `heard ${seq}`,
      translation_lang: "en",
      detect: "hit",
      created_at: startedAt
    });
  }
}

describe("a long conversation is read and exported whole", () => {
  // Tom and Liz's real use: ninety minutes at one table.
  const LONG = 2345;

  beforeEach(() => seedConversation(SID, LONG));

  it("the row cap is real here: asking for 5,000 in one go gets 1,000 and no error", async () => {
    const { supabaseAdmin } = await import("@/lib/supabaseAdmin");
    const old = await supabaseAdmin.from(LINES).select("seq").eq("session_id", SID).order("seq", { ascending: true }).limit(5000);
    expect(old.error).toBeNull();
    expect(old.data).toHaveLength(1000);
  });

  it("the reader gets every line, in order, with the database's own count", async () => {
    const res = await one(SID);
    const json = (await res.json()) as { lines: Row[]; total: number; complete: boolean };
    expect(json.total).toBe(LONG);
    expect(json.complete).toBe(true);
    expect(json.lines).toHaveLength(LONG);
    expect(json.lines.map((l) => l.seq)).toEqual(Array.from({ length: LONG }, (_, i) => i + 1));
    // Read in pages no bigger than the cap, each starting where the last ended.
    // (The one-row read is liveSaveTablesReady's probe.)
    expect(db.reads.filter((r) => r.table === LINES && r.asked > 1).map((r) => [r.from, r.asked])).toEqual([
      [0, 1000],
      [1000, 1000],
      [2000, 1000]
    ]);
    expect(logs).toContain(`[taos-live-save] read session=${SID} lines=${LONG} total=${LONG} complete=1 format=json`);
  });

  it("the export has the last line as well as the first, and does not call itself incomplete", async () => {
    const text = await (await one(SID, "GET", "?format=text")).text();
    expect(text).toContain("1.\n[Español] oído 1\n[English] heard 1");
    expect(text).toContain(`${LONG}.\n[Español] oído ${LONG}\n[English] heard ${LONG}`);
    expect(text.match(/^\d+\.$/gm)).toHaveLength(LONG);
    expect(text).not.toContain("INCOMPLETE");
  });

  it("does not trust the page size: a smaller cap than the page still reads all of it", async () => {
    db.maxRows = 300;
    const json = (await (await one(SID)).json()) as { lines: Row[]; complete: boolean };
    expect(json.lines).toHaveLength(LONG);
    expect(json.complete).toBe(true);
  });

  it("a page that fails part-way is an error, never a shorter conversation", async () => {
    const { supabaseAdmin } = await import("@/lib/supabaseAdmin");
    const real = supabaseAdmin.from.bind(supabaseAdmin);
    let lineReads = 0;
    const spy = vi.spyOn(supabaseAdmin, "from").mockImplementation(((name: string) => {
      const q = real(name) as unknown as Record<string, unknown>;
      if (name !== LINES) return q;
      const range = q.range as (a: number, b: number) => unknown;
      q.range = (a: number, b: number) => {
        lineReads += 1;
        if (lineReads === 2) q.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: { code: "57014" }, count: null });
        return range(a, b);
      };
      return q;
    }) as never);
    const res = await one(SID);
    spy.mockRestore();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Could not load." });
    expect(logs).toContain(`[taos-live-save] read_failed session=${SID} code=read_failed`);
  });

  it("past the ceiling it says so in the answer and in the file — it is never silently the first part", async () => {
    const store = await import("@/lib/live/savedStore");
    const OVER = store.LIVE_SAVED_LINES_MAX + 7;
    db.tables![SESSIONS] = [];
    db.tables![LINES] = [];
    seedConversation(SID, OVER);
    const json = (await (await one(SID)).json()) as { lines: Row[]; total: number; complete: boolean };
    expect(json.lines).toHaveLength(store.LIVE_SAVED_LINES_MAX);
    expect(json.total).toBe(OVER);
    expect(json.complete).toBe(false);
    const text = await (await one(SID, "GET", "?format=text")).text();
    const notice = `INCOMPLETE: this file holds the first ${store.LIVE_SAVED_LINES_MAX} of ${OVER} lines.`;
    // Under the heading, and again as the last thing in the file.
    expect(text.split("\n").slice(0, 4)).toContain(notice);
    expect(text.endsWith(`${notice}\n`)).toBe(true);
  });
});

describe("the list is paged, and every page can be reached", () => {
  const idOf = (n: number) => `cccccccc-cccc-4ccc-8ccc-${String(n).padStart(12, "0")}`;
  const MANY = 201;

  beforeEach(() => {
    // #1 is the oldest. Two share a started_at, to hold the tiebreak to account.
    for (let n = 1; n <= MANY; n += 1) {
      const minute = n === 100 ? 99 : n;
      seedConversation(idOf(n), 1, new Date(Date.UTC(2026, 10, 1, 0, minute)).toISOString());
    }
  });

  it("a page is 50, newest first, and says there is more", async () => {
    const { LIVE_SAVED_LIST_PAGE } = await import("@/lib/live/savedStore");
    expect(LIVE_SAVED_LIST_PAGE).toBe(50);
    const first = await list();
    expect(first.json.sessions).toHaveLength(50);
    expect(first.json.sessions[0].id).toBe(idOf(MANY));
    expect(first.json.more).toBe(true);
    expect(first.json.sessions[0]).toMatchObject({ line_count: 1 });
  });

  it("walking `offset` reaches all 201 — the oldest included — each exactly once", async () => {
    const seen: string[] = [];
    let more = true;
    let pages = 0;
    while (more) {
      const { json } = await list(`?offset=${seen.length}`);
      seen.push(...json.sessions.map((s) => String(s.id)));
      more = json.more;
      pages += 1;
      expect(pages).toBeLessThan(10);
    }
    expect(pages).toBe(5);
    expect(seen).toHaveLength(MANY);
    expect(new Set(seen).size).toBe(MANY);
    expect(seen[seen.length - 1]).toBe(idOf(1));
    // The oldest can then be opened and deleted like any other.
    expect((await one(idOf(1))).status).toBe(200);
    expect((await one(idOf(1), "DELETE")).status).toBe(200);
  });

  it("an offset past the end is an empty last page, not an error; a bad one is the first page", async () => {
    const past = await list("?offset=5000");
    expect(past.res.status).toBe(200);
    expect(past.json).toMatchObject({ sessions: [], more: false });
    for (const bad of ["?offset=-1", "?offset=abc", "?offset=1.5", "?offset="]) {
      expect((await list(bad)).json.sessions[0].id).toBe(idOf(MANY));
    }
  });

  it("pages only ever hold the caller's own", async () => {
    seedConversation("dddddddd-dddd-4ddd-8ddd-dddddddddddd", 1, "2026-12-01T00:00:00.000Z", STRANGER.id);
    const { json } = await list();
    expect(json.sessions.map((s) => s.id)).not.toContain("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  });
});

describe("the text export, on its own", () => {
  const session: SavedLiveSession = {
    id: SID,
    lang_mine: "en",
    lang_theirs: "es",
    style: "summary",
    auto: false,
    started_at: "2026-11-17T20:00:00.000Z",
    ended_at: "2026-11-17T20:03:00.000Z"
  };
  const line = (over: Partial<SavedLiveLine>): SavedLiveLine => ({
    seq: 1,
    heard_text: "a",
    heard_lang: "es",
    translation: "b",
    translation_lang: "en",
    detect: null,
    created_at: "",
    ...over
  });

  it("orders by seq and leaves out a heard half that was never captured", () => {
    const text = savedConversationAsText(session, [line({ seq: 2, heard_text: "" }), line({ seq: 1 })]);
    expect(text).toBe(
      "TAOS·LITE — /live\n2026-11-17T20:00:00.000Z → 2026-11-17T20:03:00.000Z\nen ← es · summary\n\n1.\n[es] a\n[en] b\n\n2.\n[en] b\n"
    );
  });

  it("handed fewer lines than the conversation has, it says so at the top and at the bottom", () => {
    const text = savedConversationAsText(session, [line({ seq: 1 })], (c) => c, 3);
    expect(text).toBe(
      "TAOS·LITE — /live\n2026-11-17T20:00:00.000Z → 2026-11-17T20:03:00.000Z\nen ← es · summary\n" +
        "INCOMPLETE: this file holds the first 1 of 3 lines.\n\n1.\n[es] a\n[en] b\n\n" +
        "INCOMPLETE: this file holds the first 1 of 3 lines.\n"
    );
  });
});

// ── The schema, as written ──────────────────────────────────────────────────

describe("supabase/migrations/20261117_live_saved_conversations.sql", () => {
  const raw = readFileSync("supabase/migrations/20261117_live_saved_conversations.sql", "utf8");
  // Comments stripped: the claims below are about the SQL, not the prose.
  const sql = raw.replace(/--.*$/gm, "");

  it("makes the two tables with the columns the brief names", () => {
    for (const column of ["user_id", "lang_mine", "lang_theirs", "style", "auto", "started_at", "ended_at"]) {
      expect(sql).toMatch(new RegExp(`taos_lite_live_sessions \\([^;]*\\b${column}\\b`, "s"));
    }
    for (const column of [
      "session_id",
      "seq",
      "heard_text",
      "heard_lang",
      "translation",
      "translation_lang",
      "detect",
      "created_at"
    ]) {
      expect(sql).toMatch(new RegExp(`taos_lite_live_lines \\([^;]*\\b${column}\\b`, "s"));
    }
    expect(sql).toMatch(/references public\.taos_lite_live_sessions \(id\) on delete cascade/);
    expect(sql).toMatch(/unique \(session_id, seq\)/);
  });

  it("stores no audio: no bucket, no path, no bytes", () => {
    expect(sql).not.toMatch(/storage\.|bucket|audio|bytea|_path|mime/i);
  });

  it("RLS on both; a user may select and delete their own rows; nobody may insert or update from a browser", () => {
    for (const t of ["taos_lite_live_sessions", "taos_lite_live_lines"]) {
      expect(sql).toContain(`alter table public.${t} enable row level security;`);
    }
    const policies = [...sql.matchAll(/create policy \w+\s+on public\.(\w+) for (\w+) to (\w+)\s+using \(([^;]+)\);/g)];
    expect(policies.map((p) => `${p[1]} ${p[2]} ${p[3]}`).sort()).toEqual([
      "taos_lite_live_lines delete authenticated",
      "taos_lite_live_lines select authenticated",
      "taos_lite_live_sessions delete authenticated",
      "taos_lite_live_sessions select authenticated"
    ]);
    for (const p of policies) expect(p[4].trim()).toBe("(select auth.uid()) = user_id");
    expect(sql).not.toMatch(/for (insert|update|all)\b/);
    expect(sql).not.toMatch(/with check/);
    expect(sql).not.toMatch(/to (anon|public)\b/);
    expect(sql).toMatch(/revoke all on public\.taos_lite_live_lines from anon;/);
    expect(sql).toMatch(/revoke insert, update[^;]* on public\.taos_lite_live_lines from authenticated;/);
  });

  it("is safe to run twice and never touches another table", () => {
    expect(sql).not.toMatch(/drop table|truncate table|delete from|alter table public\.(?!taos_lite_live_)/);
    expect(sql.match(/create table if not exists/g)).toHaveLength(2);
  });
});

describe("nothing new is applied or stored by default", () => {
  it("the shell never touches storage itself, and the save toggle's key is its own", () => {
    const shell = readFileSync("components/LiveShell.tsx", "utf8");
    expect(shell).not.toMatch(/localStorage|sessionStorage/);
    expect(readFileSync("lib/live/saved.ts", "utf8")).toContain('"taos.live.save"');
  });

  it("every saved-conversation route goes through the guard before it reads a thing", () => {
    for (const route of [
      "app/api/live/saved/route.ts",
      "app/api/live/saved/status/route.ts",
      "app/api/live/saved/lines/route.ts",
      "app/api/live/saved/[id]/route.ts"
    ]) {
      const code = readFileSync(route, "utf8");
      const handlers = code.split(/export async function (?:GET|POST|DELETE)/).slice(1);
      expect(handlers.length).toBeGreaterThan(0);
      for (const handler of handlers) {
        const opens = "Promise<NextResponse> {";
        const first = handler.slice(handler.indexOf(opens) + opens.length).trim();
        expect(first.startsWith("const guard = await guardLiveSaved(req);")).toBe(true);
      }
    }
    expect(readFileSync("lib/live/saveAccess.ts", "utf8")).toContain("const guard = await guardSpend(req);");
  });
});
