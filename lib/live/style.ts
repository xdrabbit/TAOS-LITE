// /live's two styles, as a value both sides of the wire agree on.
//
// "summary" is what /live has always been and stays the default: ONE
// micro-summary of 3 to 14 words per response, everything said in the meantime
// folded into it, anything older than ten or fifteen seconds dropped on
// purpose (lib/live/instructions.ts, buildInterpreterInstructions). Freshness
// over fidelity.
//
// "verbatim" is the other bargain (Tom, 11/15): every sentence, plainly, in
// order — and therefore as long as the room talks, and a little behind it.
//
// Pure and dependency-free on purpose: the shell, the WebRTC client, the mint
// route and the session builder all import this, and two of those run in the
// browser.

export type LiveStyle = "summary" | "verbatim";

export const LIVE_STYLES: readonly LiveStyle[] = ["summary", "verbatim"];

/** What /live does for anyone who never touches the toggle. */
export const DEFAULT_LIVE_STYLE: LiveStyle = "summary";

/** Per device, like the table's brain and the interpreter's engine. */
export const LIVE_STYLE_STORAGE_KEY = "taos.live.style";

/**
 * Anything that is not exactly "verbatim" is the default. A stored value from
 * a future build, a request body somebody typed by hand and an absent field
 * all land on the behavior /live has always had, never on the expensive one.
 */
export function resolveLiveStyle(value: unknown): LiveStyle {
  return value === "verbatim" ? "verbatim" : DEFAULT_LIVE_STYLE;
}

/**
 * The style this device last chose, or the default. Storage lives here and
 * not in components/LiveShell.tsx on purpose: tests/release.test.ts forbids
 * the shell from touching storage at all, so that nobody can make it remember
 * the ENGINE (a stored "device" would outlive the flag that turns that engine
 * off). That fence is right and stays as it is; the style is a different
 * value with no flag behind it, and it goes through these two functions.
 */
export function readStoredLiveStyle(): LiveStyle {
  try {
    return resolveLiveStyle(window.localStorage.getItem(LIVE_STYLE_STORAGE_KEY));
  } catch {
    // Private mode, or no window at all (the server render).
    return DEFAULT_LIVE_STYLE;
  }
}

export function storeLiveStyle(style: LiveStyle): void {
  try {
    window.localStorage.setItem(LIVE_STYLE_STORAGE_KEY, style);
  } catch {
    /* the choice still holds for this visit */
  }
}

/**
 * How long a response's audio may still be draining after `response.done`
 * before the client stops waiting for `output_audio_buffer.stopped` and lets
 * the next response go (the belt-and-braces timer in lib/live/ambient.ts).
 *
 * A micro-summary is over in a few seconds, so 12 has always been generous.
 * A word-for-word rendering is as long as what was said: releasing the gate
 * at 12 seconds would start the next rendering on top of the one still
 * playing — the overlap the gate exists to prevent. 75 covers the longest
 * response the verbatim session can produce (see LIVE_VERBATIM_MAX_OUTPUT_TOKENS
 * in lib/live/session.ts: sixty seconds of speech).
 */
export function audioDrainTimeoutMs(style: LiveStyle): number {
  return style === "verbatim" ? 75_000 : 12_000;
}
