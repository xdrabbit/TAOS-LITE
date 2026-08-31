import { NextRequest, NextResponse } from "next/server";
import { fastVisibleTo } from "@/lib/release";
import { guardSpend } from "@/lib/spendGuard";
import { checkFastRate } from "@/lib/fast/rateLimit";
import { AZURE_TOKEN_TTL_MS } from "@/lib/fast/dictation";

export const runtime = "nodejs";
// Mints a credential and returns. There is no audio here and no provider call
// worth waiting on — issueToken answers in well under a second or it is
// broken, and a client that waits longer than this has already fallen back.
export const maxDuration = 15;

/** Azure gives up to 10s; a token nobody is waiting for is worth nothing. */
const ISSUE_TIMEOUT_MS = 4000;

// POST /api/fast/speech-token — a short-lived Azure Speech credential.
//
// ── Why this route exists at all ───────────────────────────────────────────
// The live mic on /fast opens a websocket from the PHONE to Azure, because
// that is the only way partial transcripts can arrive while somebody is still
// talking: routing the audio through a Vercel function first would add a hop
// to every 100ms of speech on the one screen whose promise is that the words
// are already there.
//
// A websocket opened by a browser needs a credential IN the browser, and
// AZURE_SPEECH_KEY must never be that credential — it is a permanent,
// unscoped key to a paid resource, and shipping it to a client is shipping it
// to anyone who opens devtools. Azure's answer is issueToken: the key stays
// here, the browser gets a JWT that expires in ten minutes and can do nothing
// but recognise speech. Same shape as /api/realtime/session minting an
// ephemeral OpenAI key rather than handing out OPENAI_API_KEY.
//
// ── The same resource the tutor scores with ────────────────────────────────
// AZURE_SPEECH_KEY / AZURE_SPEECH_REGION, the pair app/api/tutor/assess reads
// for Crawl's pronunciation scoring. That is a SPEECH resource, and it really
// is the right one here: streaming recognition and pronunciation assessment
// are two APIs on the same resource kind. It is emphatically NOT the pair
// lib/fast/azure.ts wants — Azure Translator is a different resource with
// different keys, still uncreated, and crossing the two gives a 401 that
// reads like a bug (that file's header says so at length).
//
// ── The gate and the meter are /api/fast's ─────────────────────────────────
// Same fastVisibleTo() 404-not-403, so a stranger cannot mint a credential to
// a resource they cannot reach the screen for. Same checkFastRate() buckets
// as typing and as the batch mic, for the reason the listen route gives: a
// spend path with its own counter is one the /fast ceiling cannot see. Token
// issuance is not itself billed — the recognition it unlocks is, which is
// exactly why the bucket belongs here rather than nowhere.

function notFound(): NextResponse {
  return NextResponse.json(
    { error: "not_found" },
    { status: 404, headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Identity first, same order as POST /api/fast and /api/fast/listen.
  const guard = await guardSpend(req);
  const email = guard.ok ? (guard.user?.email ?? null) : null;
  if (!fastVisibleTo(email)) return notFound();
  if (!guard.ok) return guard.response;

  const rate = checkFastRate(guard.user?.id ?? "unknown");
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many in a row. Give it a moment.", window: rate.window },
      { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "5" } }
    );
  }

  const key = process.env.AZURE_SPEECH_KEY?.trim();
  const region = process.env.AZURE_SPEECH_REGION?.trim();
  // 503 and a MACHINE-READABLE reason, not a 500 and prose. The caller's whole
  // job on this answer is to stop asking and use the batch mic instead, and it
  // should not have to pattern-match an English sentence to decide that. An
  // unconfigured resource is not an error on this screen — it is the older,
  // slower mic, which still works.
  if (!key || !region) {
    return NextResponse.json(
      { error: "speech_not_configured" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }

  let res: Response;
  try {
    res = await fetch(`https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        // issueToken wants a body-less POST with a declared length. Some
        // proxies drop a POST that declares neither.
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": "0"
      },
      signal: AbortSignal.timeout(ISSUE_TIMEOUT_MS),
      cache: "no-store"
    });
  } catch {
    return NextResponse.json(
      { error: "speech_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }

  if (!res.ok) {
    // Deliberately no provider body forwarded: a 401 here means the KEY is
    // wrong, and Azure's message about it is not something to echo to a
    // client. The server log keeps the status; the phone gets the one fact it
    // can act on.
    console.error(`[fast/speech-token] issueToken failed: HTTP ${res.status}`);
    return NextResponse.json(
      { error: "speech_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }

  // issueToken answers with the raw JWT as text/plain, not JSON.
  const token = (await res.text()).trim();
  if (!token) {
    return NextResponse.json(
      { error: "speech_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }

  return NextResponse.json(
    { token, region, expiresInMs: AZURE_TOKEN_TTL_MS },
    {
      headers: {
        // A bearer credential, on a shared CDN. Never store it anywhere.
        "Cache-Control": "no-store, no-cache, must-revalidate, private"
      }
    }
  );
}
