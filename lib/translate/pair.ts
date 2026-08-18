// The language-pill rule for /translate, kept pure so tests can fence it
// (tests/translate-pair.test.ts) — the same reason buildInstructions and
// elevenLabsVoiceId live outside their routes.
//
// A conversation is a PAIR written [yours, theirs]. "Theirs" is the output:
// the language the pill row shows as selected, and the one a translation comes
// out in. One tap has to cover both things people do at a table — change who
// they are talking to, and change which side of the pair they are on — without
// a second control:
//
//   tap a language already the output -> nothing (it is already selected)
//   tap YOUR OWN side                 -> the pair flips, so you become the one
//                                        being translated into. This is how one
//                                        row of pills gives Tom EN⇄IT and Liz
//                                        ES⇄IT from the same four languages.
//   tap anything else                 -> it becomes the output; your side stays
//
// The pair is what /api/translate scopes auto-detect to, which is why the rule
// never produces a pair of one repeated language: two identical sides would
// ask the model to pick between a language and itself.
export function nextPair<T extends string>(
  pair: readonly [T, T],
  tapped: T
): readonly [T, T] {
  const [mine, theirs] = pair;
  // Returning the SAME reference (not a copy) lets the caller skip the state
  // churn — clearing the on-screen turn for a tap that changed nothing would
  // wipe a translation someone is still reading.
  if (tapped === theirs) return pair;
  if (tapped === mine) return [theirs, mine];
  return [mine, tapped];
}
