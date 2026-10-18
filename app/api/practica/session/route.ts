import { NextRequest, NextResponse } from "next/server";
import { practicaConfigured, practicaVisibleTo } from "@/lib/practica/access";
import { selectFaceProvider } from "@/lib/practica/face";
import { sceneFirstMessage, scenePrompt } from "@/lib/practica/prompt";
import { practicaScene, practicaTrip } from "@/lib/practica/scenes";
import { guardSpend } from "@/lib/spendGuard";

export const runtime = "nodejs";
export const maxDuration = 20;

function unavailable(status = 404): NextResponse {
  return NextResponse.json(
    { error: "not_enabled" },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

async function elevenLabsCredential(
  kind: "token" | "signed-url",
  agentId: string,
  apiKey: string
): Promise<string> {
  const path =
    kind === "token"
      ? "/v1/convai/conversation/token"
      : "/v1/convai/conversation/get-signed-url";
  const res = await fetch(
    `https://api.elevenlabs.io${path}?agent_id=${encodeURIComponent(agentId)}`,
    { headers: { "xi-api-key": apiKey }, cache: "no-store", signal: AbortSignal.timeout(12_000) }
  );
  if (!res.ok) throw new Error(`ElevenLabs credential failed (${res.status}).`);
  const body = (await res.json()) as { token?: string; signed_url?: string };
  const value = kind === "token" ? body.token : body.signed_url;
  if (!value) throw new Error("ElevenLabs returned an empty credential.");
  return value;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!practicaConfigured()) return unavailable();
  const guard = await guardSpend(req);
  const email = guard.ok ? guard.user?.email : null;
  if (!practicaVisibleTo(email, true)) return unavailable();
  if (!guard.ok || !guard.user) return unavailable();

  const body = (await req.json().catch(() => ({}))) as {
    tripId?: string;
    sceneIndex?: number;
  };
  const tripId = typeof body.tripId === "string" ? body.tripId : "";
  const sceneIndex = Number.isInteger(body.sceneIndex) ? Number(body.sceneIndex) : -1;
  const trip = practicaTrip(tripId);
  const scene = practicaScene(tripId, sceneIndex);
  if (!trip || !scene) {
    return NextResponse.json(
      { error: "unknown_scene" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  const apiKey = process.env.ELEVENLABS_API_KEY!.trim();
  const agentId = process.env.ELEVENLABS_AGENT_ID!.trim();
  const face = selectFaceProvider(process.env.TAOS_PRACTICA_FACE);

  try {
    if (face === "anam") {
      const anamKey = process.env.ANAM_API_KEY?.trim();
      const avatarId = process.env.ANAM_AVATAR_ID?.trim();
      // Anam documents that non-ZDR sessions retain transcripts. The current
      // ElevenLabs/avatar-only token schema does not expose a ZDR flag, so the
      // operator must confirm it is enabled for the account before this path
      // can run. Default `none` never reaches Anam.
      const zdrConfirmed = process.env.ANAM_ZERO_DATA_RETENTION_CONFIRMED?.trim() === "1";
      if (!anamKey || !avatarId || !zdrConfirmed) return unavailable(503);

      const signedUrl = await elevenLabsCredential("signed-url", agentId, apiKey);
      const anam = await fetch("https://api.anam.ai/v1/auth/session-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${anamKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          clientLabel: "taos-practica",
          personaConfig: {
            avatarId,
            avatarModel: "cara-4",
            directorNotes: { presetStyle: "warm", expressivity: 0.5 }
          },
          environment: {
            type: "elevenlabs_agent",
            elevenLabsAgentSettings: {
              signedUrl,
              agentId,
              userId: `taos-${guard.user.id}`,
              conversationConfigOverride: {
                agent: {
                  prompt: { prompt: scenePrompt(trip, scene) },
                  firstMessage: sceneFirstMessage(scene)
                }
              }
            }
          }
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(12_000)
      });
      if (!anam.ok) throw new Error(`Anam session failed (${anam.status}).`);
      const payload = (await anam.json()) as { sessionToken?: string };
      if (!payload.sessionToken) throw new Error("Anam returned an empty session token.");
      return NextResponse.json(
        { face, anamSessionToken: payload.sessionToken },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    const conversationToken = await elevenLabsCredential("token", agentId, apiKey);
    return NextResponse.json(
      { face, conversationToken },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error(
      `[taos-practica] session_mint_failed trip=${trip.id} scene=${sceneIndex} error=${
        error instanceof Error ? error.message : "unknown"
      }`
    );
    return NextResponse.json(
      { error: "session_unavailable" },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }
}
