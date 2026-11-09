// Where the interpreter's context block lives. Server-only: the table has RLS
// enabled and NO policies, so the service role is the only reader and writer
// and these two functions are the only door (the lib/review/store.ts pattern,
// supabase/migrations/20261109_interpreter_context.sql).
//
// The block is PERSONAL — names, relationships, nicknames. So:
//   - it is never seeded from the repo and never written to a log; callers
//     may log its LENGTH and nothing else,
//   - a read that fails for any reason is an EMPTY context, not an error: the
//     interpreter still interprets without it, and a dinner must not fail to
//     start because a table is missing. `status` says which it was, so the
//     edit box can tell a founder the truth.

import { hasServiceRoleKey, supabaseAdmin } from "@/lib/supabaseAdmin";
import { clampContext } from "./briefing";

export const INTERPRETER_CONTEXT_TABLE = "taos_lite_interpreter_context";
export const INTERPRETER_CONTEXT_ROW = "founders";

export type ContextStatus =
  /** Read fine (the text may still be empty — nobody has written one yet). */
  | "ok"
  /** The migration has not been applied to this database. */
  | "missing_table"
  /** No service-role key on this deployment, or the query failed. */
  | "unavailable";

export interface StoredContext {
  context: string;
  status: ContextStatus;
  updatedAt: string | null;
}

/** PostgREST's and Postgres's ways of saying "that table is not there". */
function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return /could not find the table|does not exist/i.test(error.message ?? "");
}

export async function loadInterpreterContext(): Promise<StoredContext> {
  if (!hasServiceRoleKey) return { context: "", status: "unavailable", updatedAt: null };
  try {
    const { data, error } = await supabaseAdmin
      .from(INTERPRETER_CONTEXT_TABLE)
      .select("context, updated_at")
      .eq("id", INTERPRETER_CONTEXT_ROW)
      .maybeSingle();
    if (error) {
      return {
        context: "",
        status: isMissingTable(error) ? "missing_table" : "unavailable",
        updatedAt: null
      };
    }
    const row = data as { context?: unknown; updated_at?: unknown } | null;
    return {
      context: clampContext(typeof row?.context === "string" ? row.context : ""),
      status: "ok",
      updatedAt: typeof row?.updated_at === "string" ? row.updated_at : null
    };
  } catch {
    return { context: "", status: "unavailable", updatedAt: null };
  }
}

export async function saveInterpreterContext(
  context: string,
  userId: string
): Promise<{ ok: true; context: string; updatedAt: string } | { ok: false; status: ContextStatus }> {
  if (!hasServiceRoleKey) return { ok: false, status: "unavailable" };
  const clean = clampContext(context);
  const updatedAt = new Date().toISOString();
  try {
    const { error } = await supabaseAdmin
      .from(INTERPRETER_CONTEXT_TABLE)
      .upsert(
        { id: INTERPRETER_CONTEXT_ROW, context: clean, updated_at: updatedAt, updated_by: userId },
        { onConflict: "id" }
      );
    if (error) {
      return { ok: false, status: isMissingTable(error) ? "missing_table" : "unavailable" };
    }
    return { ok: true, context: clean, updatedAt };
  } catch {
    return { ok: false, status: "unavailable" };
  }
}
