import { NextRequest, NextResponse } from "next/server";
import { isSupportedLanguageCode } from "@/lib/realtime/languages";
import { buildLiveSession, LIVE_CONTEXT_TOKEN_LIMIT, LIVE_SECRET_TTL_SECONDS } from "@/lib/live/session";
import { guardSpend } from "@/lib/spendGuard";

export const runtime = "nodejs";
export const maxDuration = 30;

// Mints an ephemeral client secret for the /live "Ambient AI" mode: a GA
// Realtime session that listens to ambient conversation (dinner, TV, movie —
// any language, any number of voices) and speaks/writes ultra-short micro-
// summaries in the target language. Same GA endpoints as the tutor
// (app/api/tutor/realtime).
//
// SIGNED-IN ONLY since 8/19. It used to be unauthenticated "to match the rest
// of the /live surface", and the rest of that surface turned out to be the
// problem rather than the precedent (ship report cdf9f02a). Minting is the
// worst place to be open: what this returns is a live OpenAI Realtime session
// that goes on billing after the response, and the only cap on it — the
// session limit and idle auto-off in lib/live/ambient.ts — is client-side,
// which is the wrong side of the wire from anyone who skipped the client.
//
// ── Where the money goes ───────────────────────────────────────────────────
// This is the most exposed realtime surface in the app: /call is founders-only
// and /tabletop is push-to-talk, but /live is a customer screen that runs
// continuously for as long as dinner lasts, and until 2026-08-28 it had no
// context cap at all. The session object is built by lib/live/session.ts and
// the measurements are in docs/realtime-cost-model.md. In descending order of
// what a minute costs:
//   1. audio OUT — the model speaks every summary, $64/Mtok. Unlike /call
//      there is no cheaper text mode to fall back to: the whole point of
//      ambient mode is a voice in an earpiece while you look at the table.
//   2. re-reading the conversation — audio at $32/Mtok, on EVERY response.
//      Uncapped this grows for as long as the session is open; the
//      `truncation` block in the builder is what holds it flat.
//   3. audio IN — $32/Mtok, but only the segments server VAD commits.
//      Streamed silence is not billed, which is why there is no client-side
//      speech gate in lib/live/ambient.ts.

const CLIENT_SECRETS_URL =
  process.env.OPENAI_REALTIME_CLIENT_SECRETS_URL ??
  "https://api.openai.com/v1/realtime/client_secrets";
const CALLS_URL =
  process.env.OPENAI_REALTIME_CALLS_URL ?? "https://api.openai.com/v1/realtime/calls";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = await guardSpend(req);
  if (!guard.ok) return guard.response;

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: missing OPENAI_API_KEY." },
      { status: 500 }
    );
  }

  // Unknown codes fall back to the pair this app started life on rather than
  // reaching the prompt raw: an interpreter told its output language is "xx"
  // answers in whatever it likes, which is worse than answering in English.
  const body = (await req.json().catch(() => ({}))) as { target?: string; source?: string };
  const target =
    typeof body.target === "string" && isSupportedLanguageCode(body.target) ? body.target : "en";
  const rawSource =
    typeof body.source === "string" && isSupportedLanguageCode(body.source) ? body.source : "es";
  // A pair of one repeated language would ask the model to interpret a
  // language into itself; keep the two sides distinct the way the pair rule
  // does (lib/translate/pair.ts).
  const source = rawSource === target ? (target === "en" ? "es" : "en") : rawSource;

  // Full gpt-realtime: the mini tier drifted off-topic and hallucinated into
  // silence at the 7/8 field test. Costs roughly 3x mini (~$1-2/hr of dense
  // speech) — set OPENAI_LIVE_REALTIME_MODEL=gpt-realtime-mini to go back. Do
  // NOT reuse OPENAI_REALTIME_MODEL — that env holds the old translation-only
  // model (see app/api/tutor/realtime).
  const model = process.env.OPENAI_LIVE_REALTIME_MODEL?.trim() || "gpt-realtime";
  const voice = process.env.OPENAI_LIVE_REALTIME_VOICE?.trim() || "marin";
  const transcribeModel =
    process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL?.trim() || "gpt-4o-mini-transcribe";

  const session = buildLiveSession({ target, source, model, voice, transcribeModel });

  try {
    const res = await fetch(CLIENT_SECRETS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        // A minted secret is a spendable, billing session. Two minutes is
        // longer than the client needs (it mints and connects in one breath)
        // and short enough that one lifted out of a log is already dead.
        expires_after: { anchor: "created_at", seconds: LIVE_SECRET_TTL_SECONDS },
        session
      }),
      cache: "no-store"
    });
    const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const detail = payload ? JSON.stringify(payload) : `HTTP ${res.status}`;
      return NextResponse.json(
        { error: "Failed to mint live session.", details: detail },
        { status: 502 }
      );
    }

    const nested = (payload?.client_secret ?? null) as Record<string, unknown> | null;
    const clientSecret =
      (typeof payload?.value === "string" && payload.value) ||
      (nested && typeof nested.value === "string" && nested.value) ||
      "";
    if (!clientSecret) {
      return NextResponse.json(
        { error: "No client secret in OpenAI response.", details: JSON.stringify(payload) },
        { status: 502 }
      );
    }

    // The open bracket of a session that bills until the phone stops it.
    // /call closes its bracket with a [taos-call-cost] line carrying the
    // dollars; /live has no usage report to post (its client never sees a
    // response.done — the summaries arrive as audio), so this line is the
    // whole record. Greppable as [taos-live-mint] in the Vercel runtime logs,
    // and the thing worth seeing is the cap: a mint line showing
    // context_tokens=off is a session that will cost what /live used to.
    console.info(
      `[taos-live-mint] pair=${source}->${target} model=${model} ` +
        `context_tokens=${LIVE_CONTEXT_TOKEN_LIMIT ?? "off"} ttl=${LIVE_SECRET_TTL_SECONDS}s`
    );

    return NextResponse.json({
      clientSecret,
      callUrl: `${CALLS_URL}?model=${encodeURIComponent(model)}`,
      model,
      voice,
      target,
      source
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error.";
    return NextResponse.json({ error: "Live session error.", details: message }, { status: 502 });
  }
}
