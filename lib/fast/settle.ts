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

/**
 * Has this text already been billed?
 *
 * The billing key is the text AND the direction, so re-typing the same phrase
 * in the same direction inside one visit is free (someone deleting a word and
 * putting it back has not asked for a second translation), while flipping the
 * pair and translating the same words the other way is a different question
 * and is billed as one.
 *
 * Trimmed, because trailing whitespace is a keystroke, not a new sentence.
 */
export function billingKey(text: string, source: string, target: string): string {
  return `${source}>${target}:${text.trim()}`;
}
