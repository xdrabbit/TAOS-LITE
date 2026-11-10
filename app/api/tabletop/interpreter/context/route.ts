import { NextRequest, NextResponse } from "next/server";
import { guardInterpreter } from "@/lib/interpreter/guard";
import { INTERPRETER_CONTEXT_MAX_CHARS } from "@/lib/interpreter/briefing";
import { loadInterpreterContext, saveInterpreterContext } from "@/lib/interpreter/contextStore";

export const runtime = "nodejs";
export const maxDuration = 15;

// The founders' context block for Interpreter mode: read it into the edit box
// on /tabletop, write it back. Same door as every interpreter route (flag 404,
// session 401, founder 404); spends nothing.
//
// The block is PERSONAL. It lives in the database only
// (lib/interpreter/contextStore.ts) and this route logs nothing about it — not
// its text, not on a failure either.

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(req: NextRequest): Promise<NextResponse> {
  const guard = await guardInterpreter(req);
  if (!guard.ok) return guard.response;
  const stored = await loadInterpreterContext();
  return NextResponse.json(
    {
      context: stored.context,
      status: stored.status,
      updatedAt: stored.updatedAt,
      maxChars: INTERPRETER_CONTEXT_MAX_CHARS
    },
    { headers: NO_STORE }
  );
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const guard = await guardInterpreter(req);
  if (!guard.ok) return guard.response;
  const body = (await req.json().catch(() => null)) as { context?: unknown } | null;
  if (!body || typeof body.context !== "string") {
    return NextResponse.json({ error: "Bad context." }, { status: 400, headers: NO_STORE });
  }
  if (body.context.length > INTERPRETER_CONTEXT_MAX_CHARS * 2) {
    return NextResponse.json({ error: "Too long." }, { status: 413, headers: NO_STORE });
  }
  const saved = await saveInterpreterContext(body.context, guard.user.id);
  if (!saved.ok) {
    // missing_table: the migration has not been applied to this database yet.
    return NextResponse.json(
      { error: "Could not save.", status: saved.status },
      { status: saved.status === "missing_table" ? 409 : 503, headers: NO_STORE }
    );
  }
  return NextResponse.json(
    { context: saved.context, status: "ok", updatedAt: saved.updatedAt, maxChars: INTERPRETER_CONTEXT_MAX_CHARS },
    { headers: NO_STORE }
  );
}
