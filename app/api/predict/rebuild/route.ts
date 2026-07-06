import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getUserFromRequest } from "@/lib/authServer";
// The build core is plain ESM JS (shared with scripts/build-predict-model.mjs).
import { buildAllModels, DIRECTIONS } from "@/lib/predict/model.mjs";

export const runtime = "nodejs";
// Rebuilding scans the whole history; never cache and never statically optimize.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const HISTORY_TABLE = "taos_lite_translations";
const MODEL_TABLE = "taos_lite_predict_models";

// Page through the full history with the service-role client (bypasses RLS so
// the model sees BOTH Tom's and Liz's messages). READ-ONLY.
async function fetchAllRows(): Promise<Array<{ original_text: string; created_at: string }>> {
  const rows: Array<{ original_text: string; created_at: string }> = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from(HISTORY_TABLE)
      .select("original_text, created_at")
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...(data as Array<{ original_text: string; created_at: string }>));
    if (data.length < PAGE) break;
  }
  return rows;
}

async function rebuild(): Promise<NextResponse> {
  const raw = await fetchAllRows();
  const now = Date.now();
  const models = buildAllModels(raw, now);
  const builtAt = new Date(now).toISOString();

  const upserts = DIRECTIONS.map((direction) => ({
    direction,
    model: models[direction],
    row_count: models[direction].rowCount,
    token_count: models[direction].tokenCount,
    built_at: builtAt
  }));

  const { error } = await supabaseAdmin
    .from(MODEL_TABLE)
    .upsert(upserts, { onConflict: "direction" });
  if (error) {
    return NextResponse.json({ error: "Failed to store models.", details: error.message }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    builtAt,
    historyRows: raw.length,
    models: DIRECTIONS.map((d) => ({
      direction: d,
      rowCount: models[d].rowCount,
      tokenCount: models[d].tokenCount,
      unigrams: Object.keys(models[d].unigrams).length,
      phrases: models[d].phrases.length
    }))
  });
}

// Nightly Vercel Cron hits this with GET. When CRON_SECRET is set, Vercel sends
// it as a Bearer token; we require a match. (If unset — e.g. local dev — allow.)
export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const header = req.headers.get("authorization") ?? "";
    if (header !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
  }
  try {
    return await rebuild();
  } catch (e) {
    const details = e instanceof Error ? e.message : "Unexpected error.";
    return NextResponse.json({ error: "Rebuild failed.", details }, { status: 502 });
  }
}

// Manual "rebuild now" from the /translate UI. Requires a signed-in user (the
// caller sends their Supabase access token). Read-only against history; only
// writes the model rows.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: "Please sign in to rebuild." }, { status: 401 });
  }
  try {
    return await rebuild();
  } catch (e) {
    const details = e instanceof Error ? e.message : "Unexpected error.";
    return NextResponse.json({ error: "Rebuild failed.", details }, { status: 502 });
  }
}
