import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, hasServiceRoleKey } from "@/lib/supabaseAdmin";
import { DIRECTIONS, emptyModel } from "@/lib/predict/model.mjs";
import type { Direction } from "@/lib/predict/model.mjs";

export const runtime = "nodejs";

const MODEL_TABLE = "taos_lite_predict_models";

// ── Only two directions are TRAINED (8/19) ──────────────────────────────────
// The prediction model is not a language feature — it is Tom & Liz's own
// conversation history, n-grammed (lib/predict/model.mjs). There is history in
// English and history in Spanish and there is none in Bosnian, so EN⇄ES is
// what exists to serve, and widening the catalog did not change that.
//
// What DID need fixing is what this route said about it: an unrecognised
// direction used to fall through to "en-es", which handed someone typing in
// Bosnian a model that suggests ENGLISH words. Ghost text in the wrong
// language is worse than no ghost text — so an untrained direction now gets a
// null model, which lib/predict/engine.ts already reads as "predict nothing".
// Typing, translating and the pills all keep working; only the suggestions go
// quiet, which is the honest answer.
function parseDirection(value: string | null): Direction | null {
  return DIRECTIONS.includes(value as Direction) ? (value as Direction) : null;
}

// Serve the precomputed model for one direction. The client fetches this ONCE on
// mount (and on direction switch), then runs all keystroke prediction in-memory.
// If no model has been built yet (fresh install / empty history), we return an
// empty-but-valid model so the client silently no-ops rather than crashing.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const direction = parseDirection(req.nextUrl.searchParams.get("direction"));

  // No model was ever built for this pair, and none ever will be until there
  // is history in it. `model: null` is the engine's own no-op signal.
  if (direction === null) {
    return NextResponse.json(
      { model: null, builtAt: null, trained: false },
      { headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=86400" } }
    );
  }

  // Reads bypass RLS via the service-role client (never exposed to the browser).
  // Without the key we still return an empty-but-valid model so the typing
  // surface keeps working — but log it so the misconfig is visible.
  if (!hasServiceRoleKey) {
    console.error(
      "[predict/model] SUPABASE_SERVICE_ROLE_KEY is not set — serving empty model."
    );
    return NextResponse.json({ model: emptyModel(direction), builtAt: null });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from(MODEL_TABLE)
      .select("model, built_at")
      .eq("direction", direction)
      .maybeSingle();
    if (error) throw error;

    const model = (data?.model as unknown) ?? emptyModel(direction);
    const builtAt = (data?.built_at as string | undefined) ?? null;

    return NextResponse.json(
      { model, builtAt },
      {
        // Fresh enough for a nightly-rebuilt model; served fast from the edge
        // cache, revalidated in the background.
        headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=86400" }
      }
    );
  } catch (e) {
    // Never break the typing surface on a model-fetch failure.
    console.error(
      `[predict/model] fetch failed for ${direction}: ${e instanceof Error ? e.message : String(e)}`
    );
    return NextResponse.json({ model: emptyModel(direction), builtAt: null });
  }
}
