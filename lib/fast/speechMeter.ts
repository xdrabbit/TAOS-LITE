// The meter on /fast's streaming mic.
//
// ── The shape of the problem ───────────────────────────────────────────────
// Every other spend path in this app runs THROUGH a route: the server sees the
// audio, or the text, or the session, and can count it. This one does not. The
// live mic opens a websocket from the phone straight to Azure, because that is
// the only way a partial transcript can appear while somebody is still
// talking — routing every 100ms of speech through a Vercel function first
// would cost the screen the exact thing it exists for.
//
// So the server never sees a byte of the audio, and the only lever it has is
// the CREDENTIAL. #49 shipped that lever pulled the wrong way twice:
//
//   * `useLiveDictation` minted a token ON MOUNT. Opening /fast — not pressing
//     anything — bought a ten-minute Azure Speech JWT. Roughly nine minutes of
//     standing recognition authority for somebody who came to type a word.
//   * Nothing counted the audio at all. The mint took one chip from the 60/min
//     TYPING bucket, which is a count of translations and has no idea what a
//     second of speech is, and the 30-second utterance cap was a `setTimeout`
//     in a browser — the same place lib/fast/dictation.ts already says a spend
//     bound does not belong.
//
// ── So: reserve per press ──────────────────────────────────────────────────
// A token is minted when the mic is pressed, never before, and minting
// RESERVES one utterance's worth of audio seconds against a rolling hourly
// budget — the shape lib/tutor/meter.ts uses for a realtime session, for the
// same reason. The browser reports what it actually streamed when the stream
// stops, and the settle bills the lesser of that and the reservation. An
// unsettled session is reaped at its full reservation on the owner's next
// press, so a closed tab is never cheaper than a finished sentence.
//
// One round trip is added in front of the mic. It is affordable precisely
// because of the iOS fix this branch also carries: `openMicCapture` opens the
// AudioContext and getUserMedia SYNCHRONOUSLY inside the tap, so the button
// lights and the mic is live before anything is awaited (lib/fast/micCapture.ts).
// The mint overlaps the socket handshake rather than delaying the gesture.
//
// ── What this does not close, said plainly ─────────────────────────────────
// Azure's `issueToken` TTL is ten minutes and is not configurable, and there
// is no narrower scope to ask for. Somebody who lifts a live JWT out of their
// own browser can stream for its full ten minutes, and the server will only
// ever hear the seconds the client chose to report. What changed is the size
// and the visibility: from an unbounded, uncounted hole opened by every page
// view, to a bounded number of tokens an hour, each minted against a ledger
// and reaped if it never settles.
//
// The only thing that would make streamed audio as auditable as typed text is
// to proxy it through a function — which is the trade /fast made on purpose.
// It is written down in ENHANCEMENTS.md rather than pretended away.

import { isFounder } from "@/lib/release";
import { hasServiceRoleKey, supabaseAdmin } from "@/lib/supabaseAdmin";
import { AZURE_TOKEN_TTL_MS, FAST_MAX_DICTATION_MS } from "./dictation";
import type { FastUser } from "./meter";

/** The one log prefix for the streaming meter. */
export const FAST_SPEECH_LOG = "taos.fast.speech";

/**
 * How many seconds of streamed audio one account may buy in a rolling hour.
 *
 * Ten minutes. Azure streaming recognition is about a dollar an hour, so this
 * bounds one account to roughly seventeen cents an hour — and against real
 * use it is enormous: a quickie is a phrase, the utterance cap is thirty
 * seconds, so this is twenty spoken lookups an hour with nothing said between
 * them. Somebody who hits it was not dictating quickies.
 */
export function fastSpeechBudgetSeconds(): number {
  const raw = Number(process.env.TAOS_FAST_SPEECH_SECONDS_PER_HOUR);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 600;
}

/** One utterance's reservation, in seconds — the browser's cap, server-side. */
export function fastSpeechGrantSeconds(): number {
  return Math.ceil(FAST_MAX_DICTATION_MS / 1000);
}

export type SpeechMintResult =
  | { ok: true; sessionId: string | null; grantedSeconds: number; usedSeconds?: number; budget?: number }
  | { ok: false; reason: "budget"; usedSeconds?: number; budget?: number };

/** Raised when production is missing the key the ledger cannot work without. */
export class FastSpeechMeterUnavailableError extends Error {
  constructor() {
    super(
      "Fast speech metering is unavailable: SUPABASE_SERVICE_ROLE_KEY is not set. " +
        "Refusing to mint an unmetered Azure Speech token in production."
    );
    this.name = "FastSpeechMeterUnavailableError";
  }
}

function inProduction(): boolean {
  return process.env.VERCEL_ENV === "production";
}

function meteringAvailable(): boolean {
  return hasServiceRoleKey;
}

/**
 * Reserve one utterance and open a ledger row, or refuse.
 *
 * Refusing costs nothing: the caller has not reached Azure yet, and a token it
 * never mints is a socket it never opens. Same ordering rule as every other
 * spend path here (lib/spendGuard.ts).
 */
export async function mintFastSpeechSession(user: FastUser): Promise<SpeechMintResult> {
  const grantedSeconds = fastSpeechGrantSeconds();

  if (!meteringAvailable()) {
    if (inProduction()) throw new FastSpeechMeterUnavailableError();
    // eslint-disable-next-line no-console
    console.warn(`${FAST_SPEECH_LOG} meter_unavailable · no service-role key · unmetered`);
    return { ok: true, sessionId: null, grantedSeconds };
  }

  const { data, error } = await supabaseAdmin.rpc("fast_speech_mint", {
    p_user_id: user.id,
    p_ttl_ms: AZURE_TOKEN_TTL_MS,
    p_grant_seconds: grantedSeconds,
    p_budget_seconds: fastSpeechBudgetSeconds(),
    // Founders are logged, not ledgered — the same call lib/tutor/meter.ts
    // makes. Their Azure minutes are a real bill and the rows still exist to
    // be queried; they just do not run out.
    p_unlimited: isFounder(user.email)
  });

  if (error) {
    // eslint-disable-next-line no-console
    console.error(`${FAST_SPEECH_LOG} mint_failed · ${error.message}`);
    throw new FastSpeechMeterUnavailableError();
  }

  const verdict = (data ?? {}) as {
    ok?: boolean;
    session_id?: string;
    granted_seconds?: number;
    used_seconds?: number;
    budget?: number;
  };

  if (!verdict.ok) {
    return { ok: false, reason: "budget", usedSeconds: verdict.used_seconds, budget: verdict.budget };
  }

  return {
    ok: true,
    sessionId: verdict.session_id ?? null,
    grantedSeconds: verdict.granted_seconds ?? grantedSeconds,
    usedSeconds: verdict.used_seconds,
    budget: verdict.budget
  };
}

export type SpeechEndReason = "user" | "cap" | "error" | "lost" | "unknown";

/**
 * Close a streaming session and bill what it used.
 *
 * `seconds` is what the BROWSER reported, and it is recorded rather than
 * trusted: the SQL caps it at the reservation, because the party reporting is
 * the one with an interest in the number being small. Returns what was billed,
 * or null when there was nothing to settle — a beacon delivered twice, or one
 * that arrived after the reaper already collected the row, are both normal.
 */
export async function settleFastSpeechSession(
  user: FastUser,
  sessionId: string,
  seconds: number,
  reason: SpeechEndReason
): Promise<number | null> {
  if (!meteringAvailable()) return null;
  const { data, error } = await supabaseAdmin.rpc("fast_speech_settle", {
    p_user_id: user.id,
    p_id: sessionId,
    p_seconds: Math.max(0, Math.round(seconds)),
    p_reason: reason
  });
  if (error) {
    // eslint-disable-next-line no-console
    console.error(`${FAST_SPEECH_LOG} settle_failed · ${sessionId} · ${error.message}`);
    return null;
  }
  return typeof data === "number" ? data : null;
}
