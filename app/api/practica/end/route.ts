import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { practicaConfigured, practicaVisibleTo } from "@/lib/practica/access";
import { practicaScene, practicaTrip } from "@/lib/practica/scenes";
import { guardSpend } from "@/lib/spendGuard";

export const runtime = "nodejs";

const END_REASONS = new Set(["timer", "done", "user", "error"]);

function userHash(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 12);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!practicaConfigured()) {
    return NextResponse.json(
      { error: "not_found" },
      { status: 404, headers: { "Cache-Control": "no-store" } }
    );
  }
  const guard = await guardSpend(req);
  const email = guard.ok ? guard.user?.email : null;
  if (!practicaVisibleTo(email, true) || !guard.ok || !guard.user) {
    return NextResponse.json(
      { error: "not_found" },
      { status: 404, headers: { "Cache-Control": "no-store" } }
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    tripId?: string;
    sceneIndex?: number;
    seconds?: number;
    ended?: string;
  };
  const tripId = typeof body.tripId === "string" ? body.tripId : "";
  const sceneIndex = Number.isInteger(body.sceneIndex) ? Number(body.sceneIndex) : -1;
  const ended = typeof body.ended === "string" && END_REASONS.has(body.ended) ? body.ended : "error";
  const rawSeconds = Number(body.seconds);
  const seconds = Number.isFinite(rawSeconds) ? Math.max(0, Math.min(300, Math.round(rawSeconds))) : 0;

  if (!practicaTrip(tripId) || !practicaScene(tripId, sceneIndex)) {
    return NextResponse.json(
      { error: "unknown_scene" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  console.info(
    `[taos-practica] user=${userHash(guard.user.id)} trip=${tripId} scene=${sceneIndex} seconds=${seconds} ended=${ended}`
  );
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
