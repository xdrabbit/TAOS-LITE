import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authServer";
import { CHAT_VOICE_BUCKET, isVoicePathForThread } from "@/lib/chatVoice";
import { isFounder } from "@/lib/release";
import { hasServiceRoleKey, supabaseAdmin } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const maxDuration = 60;

// The orphan sweep: voice audio in the bucket that no message row points at.
//
// ── Why this cannot be a trigger ───────────────────────────────────────────
// Everything else in this hygiene pass is a cascade. The audio cannot be,
// because Postgres is not allowed to touch it: storage.objects carries
// Supabase's `protect_objects_delete` trigger, which refuses every SQL DELETE
// with "Direct deletion from storage tables is not allowed. Use the Storage
// API instead." So no amount of FK or trigger work in a migration can make a
// stored object follow the row that named it.
//
// DELETE /api/chat/thread/[id] handles the path people actually take — it
// holds the Storage API and removes the folder before it removes the rows.
// What it cannot cover is every OTHER way rows can leave:
//
//   * An account deleted in the Supabase dashboard. The new
//     taos_lite_chat_purge_trg takes the person's threads with them (which is
//     the fix for the stranded-half asymmetry), and every voice note in those
//     threads is left in the bucket with nothing pointing at it.
//   * A member deleting a thread straight through the RLS policy with
//     supabase-js instead of the route. Nothing in the app does this; the
//     policy allows it.
//   * An upload whose message insert failed and whose best-effort cleanup
//     also failed.
//
// An object with no message row is garbage by construction — the app has
// exactly one writer for this bucket (/api/chat/voice) and it writes the row
// in the same request. So the sweep does not need a queue or a tombstone
// table: the two lists ARE the answer, and their difference is the garbage.
//
// GET reports, POST removes. Report first is not politeness — this deletes
// audio nobody can get back, and the count is worth reading before it runs.
//
// Founders only. It reads every path in a private bucket belonging to other
// people's conversations, and there is no version of this a customer needs.

interface Orphans {
  /** Every object in the bucket, across all threads. */
  objects: number;
  /** Objects a message row points at. */
  owned: number;
  /** Objects nothing points at — the sweepable set. */
  orphans: string[];
  /** Rows whose audio is already missing. Not fixable here; worth knowing. */
  danglingRows: number;
}

async function findOrphans(): Promise<Orphans | { error: string }> {
  // The bucket is one folder per thread (see lib/chatVoice.ts — that first
  // segment is also what the storage read policy checks membership against).
  const { data: folders, error: rootErr } = await supabaseAdmin.storage
    .from(CHAT_VOICE_BUCKET)
    .list("", { limit: 1000 });
  if (rootErr) return { error: "Could not list the voice bucket." };

  const paths: string[] = [];
  for (const folder of folders ?? []) {
    // A folder entry has no id; a file at the root would have one. A stray
    // file at the root belongs to no thread, so it is an orphan by the same
    // definition — it is included rather than skipped.
    if (folder.id) {
      paths.push(folder.name);
      continue;
    }
    const { data: files, error } = await supabaseAdmin.storage
      .from(CHAT_VOICE_BUCKET)
      .list(folder.name, { limit: 1000 });
    if (error) return { error: "Could not list the voice bucket." };
    for (const file of files ?? []) {
      const path = `${folder.name}/${file.name}`;
      if (isVoicePathForThread(path, folder.name)) paths.push(path);
    }
  }

  const { data: rows, error: rowErr } = await supabaseAdmin
    .from("taos_lite_chat_messages")
    .select("audio_path")
    .not("audio_path", "is", null);
  if (rowErr) return { error: "Could not read the message rows." };

  const owned = new Set((rows ?? []).map((r) => r.audio_path as string));
  const stored = new Set(paths);
  return {
    objects: paths.length,
    owned: paths.filter((p) => owned.has(p)).length,
    orphans: paths.filter((p) => !owned.has(p)),
    danglingRows: Array.from(owned).filter((p) => !stored.has(p)).length
  };
}

async function guard(req: NextRequest): Promise<NextResponse | null> {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  }
  if (!isFounder(user.email)) {
    return NextResponse.json({ error: "Not available." }, { status: 403 });
  }
  if (!hasServiceRoleKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: missing SUPABASE_SERVICE_ROLE_KEY." },
      { status: 500 }
    );
  }
  return null;
}

/** What would be swept, without sweeping it. The healthy answer is zero. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const denied = await guard(req);
  if (denied) return denied;

  const found = await findOrphans();
  if ("error" in found) return NextResponse.json(found, { status: 502 });
  return NextResponse.json({ ...found, orphanCount: found.orphans.length, swept: 0 });
}

/** Sweep. Irreversible, which is why GET exists. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const denied = await guard(req);
  if (denied) return denied;

  const found = await findOrphans();
  if ("error" in found) return NextResponse.json(found, { status: 502 });
  if (!found.orphans.length) {
    return NextResponse.json({ ...found, orphanCount: 0, swept: 0 });
  }

  const { error } = await supabaseAdmin.storage
    .from(CHAT_VOICE_BUCKET)
    .remove(found.orphans);
  if (error) {
    return NextResponse.json({ error: "Could not remove the orphaned audio." }, { status: 502 });
  }
  return NextResponse.json({
    ...found,
    orphanCount: found.orphans.length,
    swept: found.orphans.length
  });
}
