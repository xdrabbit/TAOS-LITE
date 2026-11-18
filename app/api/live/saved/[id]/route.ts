import { NextRequest, NextResponse } from "next/server";
import { guardLiveSaved } from "@/lib/live/saveAccess";
import { deleteSavedLive, LiveSavedError, liveSaveTablesReady, readSavedLive } from "@/lib/live/savedStore";
import { savedConversationAsText, UUID_RE } from "@/lib/live/saved";
import { languageNative } from "@/lib/languages/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

// GET    /api/live/saved/<id>               → { session, lines, total, complete }
// GET    /api/live/saved/<id>?format=text   → the conversation as a .txt download
// DELETE /api/live/saved/<id>               → { deleted: true }
//
// One saved /live conversation — the signed-in user's own, or a 404 that does
// not say whether the id exists. Logs carry the id and a line count, never the
// text.
//
// The whole conversation, however long (lib/live/savedStore.ts reads it in
// pages). `total` is the database's own count and `complete` says whether
// `lines` is all of it; when it is not, the .txt says so in words.
const noStore = { "Cache-Control": "no-store" };

function notFound(): NextResponse {
  return NextResponse.json({ error: "Not found." }, { status: 404, headers: noStore });
}

export async function GET(req: NextRequest, ctx: { params: { id: string } }): Promise<NextResponse> {
  const guard = await guardLiveSaved(req);
  if (!guard.ok) return guard.response;
  const id = ctx.params.id;
  if (!UUID_RE.test(id) || !(await liveSaveTablesReady())) return notFound();
  try {
    const found = await readSavedLive(guard.user.id, id);
    if (!found) return notFound();
    const asText = new URL(req.url).searchParams.get("format") === "text";
    console.info(
      `[taos-live-save] read session=${id} lines=${found.lines.length} total=${found.total} complete=${found.complete ? 1 : 0} format=${asText ? "text" : "json"}`
    );
    if (asText) {
      const day = found.session.started_at.slice(0, 10);
      return new NextResponse(savedConversationAsText(found.session, found.lines, languageNative, found.total), {
        headers: {
          ...noStore,
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename="taos-live-${day}-${id.slice(0, 8)}.txt"`
        }
      });
    }
    return NextResponse.json(found, { headers: noStore });
  } catch (error) {
    const code = error instanceof LiveSavedError ? error.code : "failed";
    console.error(`[taos-live-save] read_failed session=${id} code=${code}`);
    return NextResponse.json({ error: "Could not load." }, { status: 502, headers: noStore });
  }
}

export async function DELETE(req: NextRequest, ctx: { params: { id: string } }): Promise<NextResponse> {
  const guard = await guardLiveSaved(req);
  if (!guard.ok) return guard.response;
  const id = ctx.params.id;
  if (!UUID_RE.test(id) || !(await liveSaveTablesReady())) return notFound();
  try {
    const deleted = await deleteSavedLive(guard.user.id, id);
    console.info(`[taos-live-save] delete session=${id} deleted=${deleted ? 1 : 0}`);
    return deleted ? NextResponse.json({ deleted: true }, { headers: noStore }) : notFound();
  } catch (error) {
    const code = error instanceof LiveSavedError ? error.code : "failed";
    console.error(`[taos-live-save] delete_failed session=${id} code=${code}`);
    return NextResponse.json({ error: "Could not delete." }, { status: 502, headers: noStore });
  }
}
