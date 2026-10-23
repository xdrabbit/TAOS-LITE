// The language Stripe's own pages are drawn in.
//
// Checkout and the billing portal are Stripe's screens, not ours: our copy
// table cannot reach them, and translating them by hand would be wrong the day
// Stripe rewords a button. What they take instead is a `locale`, so the
// paywall hands its phone owner's language (`mine`) to the route that opens
// the session, and this turns it into one Stripe accepts.
//
// Pure, and safe on untrusted input: the code arrives in a request body, and
// a locale Stripe does not know fails the whole session create — a typo here
// would be a checkout that will not open. Anything not on the list is "auto",
// which is exactly what every session got before this file existed (Stripe
// falls back to the browser's language).

/**
 * Catalog codes Stripe draws both Checkout and the portal in, as-is. The
 * intersection of the two `Locale` unions in stripe@16, base languages only.
 */
const SAME = [
  "bg", "cs", "da", "de", "el", "en", "es", "et", "fi", "fr", "hr", "hu", "id",
  "it", "ja", "ko", "lt", "lv", "ms", "mt", "nl", "pl", "pt", "ro", "ru", "sk",
  "sl", "sv", "th", "tr", "vi", "zh"
] as const;

/** Catalog codes Stripe spells differently. */
const ALIAS = {
  tl: "fil", // Tagalog → Filipino
  no: "nb", // Norwegian → Bokmål
  nn: "nb", // Nynorsk has no Stripe locale; Bokmål is the nearest it draws
  yue: "zh-HK" // Cantonese → Traditional Chinese (Hong Kong)
} as const;

/** Every value this can return — a subset of both of Stripe's Locale unions. */
export type StripeLocale = "auto" | (typeof SAME)[number] | (typeof ALIAS)[keyof typeof ALIAS];

export function stripeLocale(code: unknown): StripeLocale {
  if (typeof code !== "string") return "auto";
  const same = SAME.find((c) => c === code);
  if (same) return same;
  return Object.hasOwn(ALIAS, code) ? ALIAS[code as keyof typeof ALIAS] : "auto";
}
