import { NextRequest, NextResponse } from "next/server";
import { guardInterpreter } from "@/lib/interpreter/guard";
import { interpreterMediatorEnabled } from "@/lib/interpreter/flag";
import { loadInterpreterContext } from "@/lib/interpreter/contextStore";
import { buildInterpreterPlan } from "@/lib/interpreter/plan";
import { parseStyle } from "@/lib/interpreter/mediator";
import { isSupportedLanguageCode } from "@/lib/realtime/languages";

export const runtime = "nodejs";
export const maxDuration = 30;

// The GPT-Live leg of Interpreter mode. gpt-live-1 has no ephemeral client
// secret: "Your browser creates an SDP offer. Your application server
// exchanges it for an answer with POST /v1/live/sessions, using the project
// API key" (OpenAI's WebRTC guide, read 2026-11-09). So this route IS the
// mint: it takes one leg's SDP offer, adds the model, the voice and the
// briefing on the server, and returns the SDP answer. The key and the briefing
// never reach the browser.
//
// Same door as …/interpreter/session — flag 404, guardSpend 401, founder 404
// — asked again here, because this is the request that starts the billing
// (a GPT-Live session bills per second from creation, silence included).
//
// The plan is REBUILT here rather than trusted from the client: the browser
// sends which leg it is and the table's two languages, and gets the direction,
// voice and briefing the server says that leg has.

const OPENAI_BASE = (process.env.OPENAI_API_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
/** An SDP offer is a few kB; this is a ceiling, not an expectation. */
const MAX_SDP_CHARS = 20_000;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await guardInterpreter(req);
  if (!guard.ok) return guard.response;

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      { error: "OpenAI is not configured on this deployment.", code: "not_configured" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    sdp?: unknown;
    leg?: unknown;
    mine?: unknown;
    theirs?: unknown;
    style?: unknown;
  };
  const sdp = typeof body.sdp === "string" ? body.sdp : "";
  if (!sdp.startsWith("v=") || sdp.length > MAX_SDP_CHARS) {
    return NextResponse.json({ error: "Bad SDP offer." }, { status: 400 });
  }
  const mine = typeof body.mine === "string" && isSupportedLanguageCode(body.mine) ? body.mine : "en";
  const rawTheirs =
    typeof body.theirs === "string" && isSupportedLanguageCode(body.theirs) ? body.theirs : "es";
  const theirs = rawTheirs === mine ? (mine === "en" ? "es" : "en") : rawTheirs;

  const stored = await loadInterpreterContext();
  const plan = buildInterpreterPlan({
    engine: "openai-live",
    pair: { a: mine, b: theirs },
    context: stored.context,
    style: interpreterMediatorEnabled() ? parseStyle(body.style) ?? undefined : undefined
  });
  const index = typeof body.leg === "number" && Number.isInteger(body.leg) ? body.leg : -1;
  const leg = plan.legs[index];
  if (!leg) return NextResponse.json({ error: "Unknown leg." }, { status: 400 });

  try {
    const res = await fetch(`${OPENAI_BASE}/live/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        session: {
          model: plan.model,
          instructions: leg.instructions ?? "",
          audio: { output: { voice: leg.voice } }
          // No `delegation`: the default is client delegation, and the
          // briefing tells the model never to delegate. An interpreter has
          // no backend, so there is no second line item on the bill.
        },
        transport: { type: "webrtc", sdp }
      }),
      cache: "no-store"
    });
    const payload = (await res.json().catch(() => null)) as {
      session?: { id?: unknown };
      transport?: { sdp?: unknown };
      error?: { message?: unknown };
    } | null;
    const answer = typeof payload?.transport?.sdp === "string" ? payload.transport.sdp : "";
    if (!res.ok || !answer) {
      const message =
        typeof payload?.error?.message === "string" ? payload.error.message.slice(0, 200) : `HTTP ${res.status}`;
      return NextResponse.json(
        { error: "Could not start the interpreter.", details: message },
        { status: 502, headers: { "Cache-Control": "no-store" } }
      );
    }
    return NextResponse.json({ sdp: answer }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const details = (error instanceof Error ? error.message : "Unexpected error.").split(apiKey).join("<key>");
    return NextResponse.json(
      { error: "Could not start the interpreter.", details },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }
}
