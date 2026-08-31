// The Clear button on /fast — one thumb-tap back to an empty box.
//
// A field ask from Tom, and the shape of it carries the reasoning: ABOVE the
// mic, and smaller than it. /fast is the screen somebody uses standing up, a
// word at a time, and the real loop is "look this up, now look the next thing
// up". Between those two the box still holds the last quickie, and emptying it
// by hand on a phone is select-all-then-delete — a long-press menu and two
// more taps to reach the state the screen opens in. One button collapses that
// to one tap, and it is deliberately the quiet one in the column: the mic is
// the control that makes this screen usable while walking, and nothing added
// beside it should compete for the same thumb.
//
// ── What a clear resets ────────────────────────────────────────────────────
// Everything describing the answer currently on screen — the input, the
// translation, the detected/target pair the direction caption reads, the
// engine line under it, and any error. It also orphans whatever request is in
// flight, because a reply that lands after a clear must not paint a
// translation into a box somebody just emptied; and it cancels the mic,
// because a tail still arriving is text on its way into that same box.
//
// It does NOT touch the pinned direction. Pinning is a decision about the
// conversation, not about the phrase — somebody who pinned ES→EN to look up a
// menu is going to look up the next line of the same menu, and handing them
// back to Auto every time they cleared would be the screen forgetting the one
// thing they bothered to tell it.
//
// ── The one thing it must not reset ────────────────────────────────────────
// The billed set (lib/fast/settle.ts): the memory of which words have already
// counted against the monthly allowance this visit. Clear is a screen gesture,
// not a purchase. Forgetting that set would make clear-and-retype a way to
// bill the same phrase twice — and it would land on exactly the person who
// cleared because they wanted the answer they had just read back again, which
// is the free tier's twenty-five spent on one word.
//
// Which is the whole of "a cleared-then-new entry meters as a fresh settled
// translation": new words after a clear run the same two clocks and bill their
// one row, and old words are still remembered as paid for.

/**
 * Is there anything on the box to clear?
 *
 * Two arguments and not one, because while the streaming mic is open the box
 * holds two kinds of text (lib/fast/liveTranscript.ts): the committed words in
 * `input`, and the tentative tail, which is drawn on the box but held outside
 * `input` on purpose so that it cannot start a translation. To the thumb those
 * are both just "what is on the screen right now" — so a box showing only a
 * tail, which is the first second of any latched dictation, offers Clear like
 * any other.
 *
 * Untrimmed. A box holding three spaces is not empty: the caret is sitting
 * somewhere after them, and the button that empties it should be there.
 */
export function hasSomethingToClear(input: string, partial: string): boolean {
  return input.length > 0 || partial.length > 0;
}
