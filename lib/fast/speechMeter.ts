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
// ── A reservation is not a credential ──────────────────────────────────────
// Those are two different things and the second review is what separated
// them. Reserving happens once per UTTERANCE; issuing a JWT happens once per
// TEN MINUTES, because that is how long Azure's JWT lives whatever we do.
//
// The first cut minted a fresh token on every press and threw the old one
// away — but "throwing away" a JWT does nothing at Azure, so twenty presses
// left twenty live credentials, each good for its full ten minutes. Holding
// ONE token across its lifetime and re-reserving against it per press is
// strictly less exposure for exactly the same behaviour on screen. The client
// asks with `reuse: true` when it still holds a live token; the server then
// takes the reservation and issues nothing.
//
// That makes a second bound possible, and it is the one Azure's fixed TTL
// leaves room for: a ceiling on how many of an account's tokens may be ALIVE
// at once (`TAOS_FAST_SPEECH_LIVE_TOKENS`). It is a security bound rather
// than a spend bound, so it applies to founders too.
//
// ── What this does not close, said plainly ─────────────────────────────────
// `issueToken`'s TTL is ten minutes, it is not configurable, there is no
// narrower scope to ask for, and Azure offers no revocation for a token
// already issued. So there is no arrangement of this file in which a lifted
// JWT is worth less than the remainder of its ten minutes. What can be
// bounded is how many exist:
//
//   before this branch   a token per PAGE VIEW, unbounded, uncounted
//   first cut            a token per PRESS — up to 20/hour live at once
//   now                  at most TAOS_FAST_SPEECH_LIVE_TOKENS live at once
//                        (default 6), each ledgered, plus the hourly budget
//
// Residual exposure, stated as a number rather than a shrug: somebody willing
// to lift tokens out of their own browser can hold six at a time, so up to
// sixty minutes of recognition authority per ten-minute window — about a
// dollar an hour of Azure at list price, against one account we can see in
// `fast_speech_sessions` and disable. The default is loose on purpose while
// /fast is a founders-only field test that involves a lot of reloading; two
// is the right number once the screen is public, and it is one env var.
//
// The only thing that would make streamed audio as auditable as typed text is
// to proxy it through a function — which is the trade /fast made on purpose.
// It is written down in ENHANCEMENTS.md rather than pretended away.

import { fastSpeechUnlimited } from "@/lib/release";
import { hasServiceRoleKey, supabaseAdmin } from "@/lib/supabaseAdmin";
import { AZURE_TOKEN_TTL_MS, FAST_SPEECH_HOLD_MS, FAST_MAX_DICTATION_MS } from "./dictation";
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

/**
 * How many of one account's Azure tokens may be alive at the same time.
 *
 * The only lever Azure's fixed ten-minute TTL leaves. Six is loose, and it is
 * loose deliberately: a token lives in memory and does not survive a reload,
 * so a founder walking the field-test matrix — Safari tab, installed PWA,
 * force-quit, reopen — legitimately mints several inside one ten-minute
 * window, and the failure mode of a cap that bites is the streaming mic
 * silently becoming the batch mic in the middle of the test that is supposed
 * to judge the streaming mic.
 *
 * Two is the right number for a public /fast. It is this env var and nothing
 * else: TAOS_FAST_SPEECH_LIVE_TOKENS.
 */
export function fastSpeechLiveTokenLimit(): number {
  const raw = Number(process.env.TAOS_FAST_SPEECH_LIVE_TOKENS);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 6;
}

export type SpeechMintRefusal = "budget" | "live_tokens";

export type SpeechMintResult =
  | {
      ok: true;
      sessionId: string | null;
      grantedSeconds: number;
      /** Did this call issue a NEW Azure JWT, or only take a reservation? */
      issued: boolean;
      usedSeconds?: number;
      budget?: number;
    }
  | { ok: false; reason: SpeechMintRefusal; usedSeconds?: number; budget?: number };

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
export async function mintFastSpeechSession(
  user: FastUser,
  /**
   * The caller still holds a live JWT and wants only a reservation.
   *
   * Unverifiable, and it does not need to be: a client that lies gets a
   * session id and no credential, which buys it nothing. Lying the other way
   * — always asking for a fresh token — is what the live-token ceiling is
   * for.
   */
  options: { reuse?: boolean } = {}
): Promise<SpeechMintResult> {
  const grantedSeconds = fastSpeechGrantSeconds();
  const issue = !options.reuse;

  if (!meteringAvailable()) {
    if (inProduction()) throw new FastSpeechMeterUnavailableError();
    // eslint-disable-next-line no-console
    console.warn(`${FAST_SPEECH_LOG} meter_unavailable · no service-role key · unmetered`);
    return { ok: true, sessionId: null, grantedSeconds, issued: issue };
  }

  const { data, error } = await supabaseAdmin.rpc("fast_speech_mint", {
    p_user_id: user.id,
    // The RESERVATION's reaping deadline, which is one utterance and not one
    // token: the JWT outlives this row by design now, and a reservation left
    // open by a closed tab should stop encumbering the hourly budget a minute
    // after the utterance it reserved could possibly have ended.
    p_ttl_ms: FAST_SPEECH_HOLD_MS,
    p_grant_seconds: grantedSeconds,
    p_budget_seconds: fastSpeechBudgetSeconds(),
    // Founders bypass the BUDGET only once /fast is public — see
    // fastSpeechUnlimited() in lib/release.ts for why a meter that exempts
    // the only people who can reach the screen is not a meter.
    p_unlimited: fastSpeechUnlimited(user.email),
    p_issue: issue,
    p_token_ttl_ms: AZURE_TOKEN_TTL_MS,
    // Deliberately NOT conditioned on p_unlimited. This one is not about the
    // bill — it bounds how much recognition authority a stolen credential
    // could carry, and a founder's stolen credential spends the same money.
    p_live_token_limit: fastSpeechLiveTokenLimit()
  });

  if (error) {
    // eslint-disable-next-line no-console
    console.error(`${FAST_SPEECH_LOG} mint_failed · ${error.message}`);
    throw new FastSpeechMeterUnavailableError();
  }

  const verdict = (data ?? {}) as {
    ok?: boolean;
    reason?: SpeechMintRefusal;
    session_id?: string;
    granted_seconds?: number;
    issued?: boolean;
    used_seconds?: number;
    budget?: number;
  };

  if (!verdict.ok) {
    return {
      ok: false,
      reason: verdict.reason === "live_tokens" ? "live_tokens" : "budget",
      usedSeconds: verdict.used_seconds,
      budget: verdict.budget
    };
  }

  return {
    ok: true,
    sessionId: verdict.session_id ?? null,
    grantedSeconds: verdict.granted_seconds ?? grantedSeconds,
    issued: verdict.issued ?? issue,
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
