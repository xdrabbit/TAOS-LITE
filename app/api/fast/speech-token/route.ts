import { NextRequest, NextResponse } from "next/server";
import { fastVisibleTo } from "@/lib/release";
import { guardSpend } from "@/lib/spendGuard";
import { checkFastRate } from "@/lib/fast/rateLimit";
import { AZURE_TOKEN_TTL_MS } from "@/lib/fast/dictation";
import {
  FastSpeechMeterUnavailableError,
  mintFastSpeechSession,
  settleFastSpeechSession,
  type SpeechEndReason
} from "@/lib/fast/speechMeter";

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
// ── The gate is /api/fast's; the METER is this route's own ─────────────────
// Same fastVisibleTo() 404-not-403, so a stranger cannot mint a credential to
// a resource they cannot reach the screen for. Same checkFastRate() buckets as
// typing and as the batch mic, so a storm of mints is refused for free before
// anything else runs.
//
// But a chip from the typing bucket is NOT a meter for this, and shipping it
// as one was the mistake in #49: that bucket counts TRANSLATIONS, and what
// this route hands out is ten minutes of Azure recognition authority. One chip
// bought roughly nine minutes of audio nothing could see, and it was spent on
// MOUNT — every /fast page view, pressed or not.
//
// So this route now reserves against a ledger of its own, in audio seconds,
// before it mints: lib/fast/speechMeter.ts. Minting is free (issueToken is not
// billed; only the recognition it unlocks is), which is exactly why the
// reservation has to be about the AUDIO rather than about the request.
//
// The client reserves on EVERY press and settles when the stream stops
// (POST /api/fast/speech-settle). An unsettled reservation is reaped at its
// full grant once its hold window passes.
//
// ── Reserving and issuing are two different things ─────────────────────────
// A body of `{"reuse": true}` says the caller still holds a live JWT and wants
// only the reservation. That is the common case after the first press of a
// visit, and it exists because discarding a JWT client-side does not revoke
// it: the first cut minted per press, so a ten-minute visit could leave twenty
// live credentials behind it. Now one credential covers its own ten minutes
// and every press re-authorises against the ledger underneath it.
//
// The claim is not verifiable and does not need to be. A caller that lies and
// says it has a token gets a session id and nothing to stream with. A caller
// that lies the other way — demanding a fresh token every time — meets
// `fastSpeechLiveTokenLimit()`, which counts an account's UNEXPIRED tokens and
// refuses past the ceiling. That is the only bound Azure's fixed, unrevokable
// ten-minute TTL leaves room for, and speechMeter's header states the residual
// exposure as a number rather than waving at it.
//
// ── And a slot is only held by a token that EXISTS ─────────────────────────
// Because the reservation is written before Azure is called, every failure
// below happens with the row already claiming a ten-minute credential. Each of
// them calls `release()`, which now clears that claim as well as the
// reservation — otherwise an unconfigured resource, a rotated key or a
// Microsoft outage would spend the ceiling six presses deep and leave the
// account on the batch mic for ten minutes with nothing to show why.

function notFound(): NextResponse {
  return NextResponse.json(
    { error: "not_found" },
    { status: 404, headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * Hand a reservation back — AND its live-token slot — when nothing was issued.
 *
 * Zero seconds, because nothing was streamed: a token that was never minted
 * cannot have been used, and holding its thirty seconds until the reaper comes
 * would charge somebody for an outage at Microsoft.
 *
 * `releaseToken` is the half the second review added, and it is the more
 * expensive one to get wrong. The reservation is taken BEFORE Azure is asked
 * for the credential, so the row already claims a ten-minute JWT by the time
 * any of the failures below are known. Settling it without clearing that claim
 * leaves a slot held on behalf of a token that does not exist — and
 * `fastSpeechLiveTokenLimit()` is a hard refusal, so six failed mints inside
 * ten minutes turn the streaming mic into the batch mic for the whole account.
 * Every path that reaches this function is one where the server itself knows
 * no credential left the building, which is what makes clearing it a fact
 * rather than a favour.
 */
async function release(
  userId: string | undefined,
  email: string | null,
  sessionId: string | null,
  reason: SpeechEndReason
): Promise<void> {
  if (!sessionId || !userId) return;
  await settleFastSpeechSession({ id: userId, email }, sessionId, 0, reason, {
    releaseToken: true
  });
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

  // A body is optional here and an unreadable one is not an error: the only
  // thing it can say is "I already hold a token", and the safe reading of
  // silence is that the caller does not. That costs a credential, never a
  // refusal.
  let reuse = false;
  try {
    const payload = (await req.json()) as Record<string, unknown> | null;
    reuse = payload?.reuse === true;
  } catch {
    reuse = false;
  }

  // The reservation, before the credential. A refusal here has cost nothing:
  // no token minted is no socket opened.
  let minted;
  try {
    minted = await mintFastSpeechSession({ id: guard.user?.id ?? "unknown", email }, { reuse });
  } catch (error) {
    if (error instanceof FastSpeechMeterUnavailableError) {
      // The same machine-readable shape as an unconfigured resource, and for
      // the same reason: the caller's job on this answer is to stop asking and
      // use the batch mic, which IS metered end to end.
      return NextResponse.json(
        { error: "speech_unavailable" },
        { status: 503, headers: { "Cache-Control": "no-store" } }
      );
    }
    throw error;
  }

  if (!minted.ok) {
    // Two different refusals, one machine-readable shape, because the caller
    // does the same thing with both: stop asking and use the batch mic. They
    // are named apart so a runtime log can tell "this account talked for ten
    // minutes" from "this account asked for its seventh live credential",
    // which are very different sentences.
    return NextResponse.json(
      {
        error: minted.reason === "live_tokens" ? "speech_tokens_live" : "speech_budget_spent",
        usedSeconds: minted.usedSeconds,
        budgetSeconds: minted.budget
      },
      { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "60" } }
    );
  }

  // Reservation only: the caller says it still holds a credential, so there is
  // nothing to issue and nothing to reach Azure for. The reservation is real
  // either way — this is the press that just re-authorised.
  if (!minted.issued) {
    return NextResponse.json(
      { sessionId: minted.sessionId, grantedSeconds: minted.grantedSeconds },
      { headers: { "Cache-Control": "no-store, no-cache, must-revalidate, private" } }
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
    await release(guard.user?.id, email, minted.sessionId, "error");
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
    await release(guard.user?.id, email, minted.sessionId, "error");
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
    await release(guard.user?.id, email, minted.sessionId, "error");
    return NextResponse.json(
      { error: "speech_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }

  // issueToken answers with the raw JWT as text/plain, not JSON.
  const token = (await res.text()).trim();
  if (!token) {
    await release(guard.user?.id, email, minted.sessionId, "error");
    return NextResponse.json(
      { error: "speech_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }

  return NextResponse.json(
    {
      token,
      region,
      expiresInMs: AZURE_TOKEN_TTL_MS,
      // What the browser has to hand back when the stream stops. Without it
      // the reservation stays open until the token expires and is then reaped
      // at its full length — correct, but expensive for somebody who only said
      // three words.
      sessionId: minted.sessionId,
      grantedSeconds: minted.grantedSeconds
    },
    {
      headers: {
        // A bearer credential, on a shared CDN. Never store it anywhere.
        "Cache-Control": "no-store, no-cache, must-revalidate, private"
      }
    }
  );
}
