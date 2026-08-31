// The timings /fast is made of, and the rule that decides what a translation
// COSTS somebody.
//
// An as-you-type box has two clocks running over the same keystrokes, and
// conflating them is how a screen like this either feels slow or eats a
// month's allowance in one sentence:
//
//   DEBOUNCE (300ms)  — how long the typing has to pause before a request
//                       goes out. This is about FEEL. Short enough that the
//                       translation appears to keep up; long enough that a
//                       fluent typist does not fire one call per letter.
//
//   SETTLE (1500ms)   — how long the typing has to pause before the thing on
//                       screen counts as a translation somebody asked for.
//                       This is about MONEY, and it is the slower of the two
//                       on purpose: everything rendered between keystrokes is
//                       a preview of a sentence still being written, and
//                       charging for a preview would mean a twelve-word
//                       sentence spent twelve of the free tier's twenty-five.
//
// So one settled input bills once, however many previews it took to get
// there — which is the same unit the home screen bills: one finished thing a
// person meant to say.
//
// ── Where the settle is measured (changed 8/31) ────────────────────────────
// Both of these used to be browser timers, and the second one was the meter:
// FastShell waited 1500ms and wrote the billing row itself. That made the
// cash register something a caller could decline to run — a curl with a valid
// session, or a tab closed at 1400ms, translated for free.
//
// SETTLE is now the SERVER's window. POST /api/fast measures the gap between
// two requests from one account, which is the same pause this constant always
// described, on a clock the caller does not hold: a run of previews with no
// gap longer than this is one burst, and one burst is one billed quickie.
// lib/fast/meter.ts is where that lives. The number did not change and the
// unit did not change — only who is holding the stopwatch.
export const FAST_DEBOUNCE_MS = 300;
export const FAST_SETTLE_MS = 1500;

/**
 * The longest quickie /fast will translate.
 *
 * A cap on both engines, and it is not the same kind of cap on each: Azure
 * bills per CHARACTER of source text, so this bounds the bill directly, while
 * for the LLM it mostly bounds the latency. 500 characters is several times
 * any real quickie — this screen is for a phrase, and /translate is one tap
 * away for a paragraph.
 */
export const FAST_MAX_CHARS = 500;
