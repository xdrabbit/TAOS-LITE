// Which `response.create` /live sends next — the one decision that differs
// between the two styles once the session is open.
//
// The session is minted with `create_response: false`, so the CLIENT asks for
// every response (lib/live/ambient.ts explains why: auto-created ones talked
// over each other). What it asks for is the whole difference:
//
//   summary   — a bare `response.create`. The model reads the conversation and
//               says ONE thing about everything that piled up while the last
//               summary was playing. Unchanged since /live shipped.
//
//   verbatim  — one response PER heard segment, oldest first, each one pointed
//               at exactly that segment with an `item_reference`.
//
// The second form is not a refinement, it is the fix for a measured failure.
// The first word-for-word probe (2026-11-15, tests/live-fire/
// live-style.measure.ts) used the bare form with a prompt that said "render
// EVERYTHING that was said since your previous response", and whenever two
// segments were waiting the model rendered only the newest. "Ah, y por cierto,
// ayer vi a tu prima en el mercado… / Bueno, a lo que iba: salimos a las ocho"
// came back as the second sentence alone; a question followed by "creo que
// eran doce dólares" lost the question. Three for three on the multi-segment
// turns, every single-segment turn complete. A realtime model answers the last
// thing it heard; no sentence in a prompt outvotes that. So the completeness
// promise is kept by the plumbing instead: every segment gets a response of
// its own, and nothing is asked to cover two.
//
// ── And the one thing it may leave out, said out loud ──────────────────────
// A rendering takes about as long to speak as the original took to say, so on
// speech with no gaps in it (a television, two people talking over each other)
// this style falls behind, and keeps falling. That is not only a comfort
// problem. The session's context cap prunes the OLDEST audio first, and a
// segment that has waited long enough is pruned out from under its own
// reference: the second probe queued four remarks under a 50-token cap, three
// of the four responses were handed no audio at all (`in_audio: 0`), and the
// model filled the silence — "Really? And did you notice how that guy was
// looking at her?" — which nobody at that table said.
//
// So a segment that has waited longer than LIVE_VERBATIM_MAX_LAG_MS is not
// rendered. It is counted, and the screen says that it skipped ahead. An
// admitted gap is the house rule ("an empty response is always better than an
// invented one"); the cap in lib/live/session.ts is sized so that anything
// younger than this is still there to be read.
//
// Pure, so the test suite and the live-fire rig both drive the exact function
// the browser does.

import type { LiveStyle } from "@/lib/live/style";

/**
 * How far behind word-for-word may run before it skips ahead.
 *
 * Ninety seconds, from the arithmetic in lib/live/session.ts: everything that
 * enters the conversation AFTER a waiting segment is at most 10 tokens a
 * second of room audio plus 20 of the model's own voice, so a segment 90
 * seconds old has at most ~3,000 tokens stacked on top of it — under half of
 * what the verbatim cap keeps.
 */
export const LIVE_VERBATIM_MAX_LAG_MS = 90_000;

/** A heard segment that has real words in it and no response yet. */
export interface PendingTurn {
  /** The conversation item VAD committed. "" if the event did not carry one. */
  itemId: string;
  /** Commit order. Transcriptions can finish out of order; speech does not. */
  seq: number;
  /** When it was committed, ms since epoch — what the lag is measured from. */
  at: number;
}

export interface NextResponse {
  /** The client event to send down the data channel, as is. null = nothing to ask. */
  event: Record<string, unknown> | null;
  /** What is still waiting after this response. */
  remaining: PendingTurn[];
  /** Segments dropped for being too far behind (word-for-word only). */
  skipped: number;
}

export function nextResponse(
  style: LiveStyle,
  pending: readonly PendingTurn[],
  now: number
): NextResponse {
  if (pending.length === 0) return { event: null, remaining: [], skipped: 0 };

  if (style === "summary") {
    // Everything committed so far is covered by this one response. The prompt
    // does its own forgetting ("old content is worthless").
    return { event: { type: "response.create" }, remaining: [], skipped: 0 };
  }

  const ordered = [...pending].sort((a, b) => a.seq - b.seq);
  // No id means nothing to point at, and a bare `response.create` here would
  // re-read the whole verbatim context — the bill the reference avoids. The
  // GA API always sends the id; if it ever does not, that is a skip, not a
  // guess and not a surprise invoice.
  const fresh = ordered.filter((t) => t.itemId && now - t.at <= LIVE_VERBATIM_MAX_LAG_MS);
  const skipped = ordered.length - fresh.length;
  const [oldest, ...remaining] = fresh;
  if (!oldest) return { event: null, remaining: [], skipped };
  return {
    event: {
      type: "response.create",
      response: { input: [{ type: "item_reference", id: oldest.itemId }] }
    },
    remaining,
    skipped
  };
}
