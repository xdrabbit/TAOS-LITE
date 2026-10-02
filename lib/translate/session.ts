// A conversation is a run of turns with no long silence between them.
//
// The table stores turns; it never stored which turns went together, and that
// fact cannot be recovered later (supabase/migrations/20261001_translation_sessions.sql
// explains why). So the client decides at the moment of speaking: keep the
// current id while the turns keep coming, mint a new one once the conversation
// has gone quiet. Nothing here knows who the other person was — one phone, one
// session, both voices.
//
// The gap is the one knob. Ten minutes is what reconstructing the existing
// archive by timestamps landed on (1,089 sessions averaging 6.7 turns across
// Tom and Liz's history); a shorter gap splits a slow dinner conversation in
// two, a longer one merges the drive home into it.

export const SESSION_GAP_MS = 10 * 60 * 1000;

export interface ConversationSession {
  /** Shared by every turn of one conversation; a fresh uuid once it goes quiet. */
  id: string;
  /** When the most recent turn of this conversation was saved, in ms. */
  lastTurnAt: number;
}

/**
 * Lay 16 random bytes out as an RFC 4122 v4 uuid, so the fallback below hands
 * Postgres the same shape `crypto.randomUUID` would — the column is `uuid`.
 */
export function formatUuidV4(bytes: Uint8Array): string {
  if (bytes.length < 16) throw new Error("formatUuidV4 needs 16 bytes");
  const b = Uint8Array.from(bytes.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// crypto.randomUUID is secure-context-only; getRandomValues is not. The home
// screen is served over HTTPS in every real case, but a plain-HTTP LAN address
// during dev would otherwise throw on the very first turn (lib/call/session.ts
// hit the same thing).
export function newSessionId(): string {
  const c = crypto as Crypto & { randomUUID?: () => string };
  if (typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return formatUuidV4(bytes);
}

/**
 * The session this turn belongs to.
 *
 * Pure: given the previous session (or null) and the current time, returns the
 * session to stamp on this turn — the same id if the conversation is still
 * going, a new one if it has been quiet for longer than SESSION_GAP_MS. The
 * caller stores the result and hands it back next time.
 */
export function continueSession(
  prev: ConversationSession | null,
  now: number,
  mint: () => string = newSessionId
): ConversationSession {
  if (prev && now - prev.lastTurnAt <= SESSION_GAP_MS) {
    return { id: prev.id, lastTurnAt: now };
  }
  return { id: mint(), lastTurnAt: now };
}
