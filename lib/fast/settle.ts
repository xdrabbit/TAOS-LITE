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
 * How long a question stays already-asked.
 *
 * Before the meter moved server-side, FastShell held a set of everything it
 * had billed for the life of the visit, so deleting a word and putting it back
 * — or clearing the box and retyping the same phrase — cost nothing more.
 * That is a real promise about a screen people use standing up, a word at a
 * time, and #49's Clear button was built on it.
 *
 * The burst rule alone loses it: two bursts of the same words are two bills.
 * So `public.fast_begin` looks for a settled row this text is a meaningful
 * prefix of, between these two languages, inside this window, and ADOPTS it
 * instead of buying another.
 *
 * Thirty minutes, down from six hours. Six hours was never the promise being
 * restored: what FastShell held was a set for the life of a VISIT, and a
 * visit is somebody standing at a counter, not an afternoon. The window is
 * how long a stale row stays reachable by a prefix somebody happens to type,
 * so the shorter it is the smaller that surface — and thirty minutes still
 * covers every retype anybody actually makes.
 */
export const FAST_REPEAT_MS = 30 * 60 * 1000;

/**
 * The floor under an adoptable prefix — the shortest text that may open an
 * older row.
 *
 * Adoption HAS to match on a prefix: billing happens at the start of a burst,
 * which is somebody's first few letters, so an exact-match rule would never
 * fire while a phrase was being retyped. Unbounded, though, that makes every
 * short opener a key to a stranger's row — "I" matched "I need a doctor",
 * "the" matched anything at all. Four characters is the cheapest cut that
 * removes the openers without touching a real quickie.
 */
export const FAST_REPEAT_MIN_CHARS = 4;

/**
 * How far through the stored phrase a prefix must reach to count as the same
 * question, when it is not long enough to stand on its own.
 *
 * Sixty percent is what keeps the promise for SHORT quickies: retyping "how
 * much" adopts at "how m" rather than being billed a second time. It is the
 * proportional half of the rule; FAST_REPEAT_STRONG_CHARS is the absolute
 * half, and either one is enough.
 */
export const FAST_REPEAT_MIN_RATIO = 0.6;

/**
 * The length at which a prefix means something on its own, whatever it is a
 * prefix of.
 *
 * Twelve characters is two or three words. Below it the ratio above decides;
 * at or above it, this much typing is not an accidental collision with
 * somebody's older lookup.
 *
 * There is a third clause that lives only in SQL because it is about the
 * shape of the text rather than a number: the prefix must span a word
 * boundary or BE the whole stored phrase. That is what stops "where" from
 * opening "where is the bank" while still letting the one-word quickie
 * "where" be retyped for free. See public.fast_repeat_match in
 * supabase/migrations/20260831_fast_history_guard.sql.
 */
export const FAST_REPEAT_STRONG_CHARS = 12;

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
