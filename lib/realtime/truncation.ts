// The one cost guard every realtime surface in this app needs, in one place.
//
// A GA Realtime session does not bill the audio you stream it. It bills the
// audio its VAD COMMITS, plus — and this is the part nobody sees coming —
// **the whole conversation so far, re-read as audio, on every single
// response**. Audio input is $32/Mtok, so the second half of that sentence is
// a bill that grows with how long the session has been open rather than with
// how much anyone said.
//
// Measured on /call (docs/realtime-cost-model.md, 2026-08-27): uncapped, five
// consecutive utterances billed 209% of the audio actually spoken and the
// per-turn figure was still climbing — 49 → 100 → 164 → 175 → 227. A
// forty-minute call pays for its first minute forty times over. With a
// `post_instructions` cap the same five turns billed 66% and held FLAT, which
// is the only property that matters: flat means a session's cost is linear in
// what people say instead of quadratic in how long they stay.
//
// `retention_ratio` truncation is declarative — the server decides what it can
// spare and drops it. The alternative, sending `conversation.item.delete`
// after each turn, measured cheaper still (51%) and is deliberately NOT used
// anywhere: it raced the response it was pruning for, and two turns came back
// having been handed no audio at all (`in_audio: 0`), producing degenerate
// output. Letting the server prune never does that.

/**
 * The `truncation` block, ready to drop into a session object.
 *
 * @param postInstructionTokens how much conversation the model may re-read per
 *   response, counted AFTER the instructions (which are never truncated — they
 *   are the prompt). Roughly 100 tokens ≈ one phrase-sized VAD segment of
 *   audio, since audio bills at 1 token per 100 ms.
 */
export function truncationCap(postInstructionTokens: number): {
  type: "retention_ratio";
  retention_ratio: number;
  token_limits: { post_instructions: number };
} {
  return {
    type: "retention_ratio",
    // 0.8: when the server does prune, it keeps 80% of what it is allowed to
    // keep rather than cutting to the bone, so a cap is a ceiling that gets
    // approached smoothly instead of a sawtooth.
    retention_ratio: 0.8,
    token_limits: { post_instructions: Math.max(1, Math.floor(postInstructionTokens)) }
  };
}

/**
 * Read a per-surface override out of the environment, falling back to the
 * measured default.
 *
 * The floor of 50 is not a style choice: below roughly one VAD segment the
 * model starts responding to a fragment of the utterance it is supposed to be
 * translating, which is a quality cliff rather than a saving. A deliberate
 * `0` — "no cap at all" — is spelled out rather than smuggled in as a small
 * number, because uncapped is the expensive setting and should have to be
 * asked for by name.
 */
export function contextTokenLimitFromEnv(raw: string | undefined, fallback: number): number | null {
  const trimmed = raw?.trim();
  if (trimmed === "off") return null;
  const parsed = Number(trimmed);
  if (Number.isFinite(parsed) && parsed >= 50) return Math.floor(parsed);
  return fallback;
}
