// Everything the meter says out loud.
//
// Kept pure and in one file for the same reason lib/about.ts, lib/guide.ts and
// lib/chatLabels.ts are: this is the copy that appears at the moment a person
// is told they cannot have what they came for, and it is the copy most likely
// to be written carelessly in a hurry inside a JSX branch. Fenced by
// tests/tutor-metering.test.ts.
//
// ── Bilingual, the app's way ───────────────────────────────────────────────
// The chrome convention is "English · Español" on one line for short things —
// that is what the header chip and the buttons use. The paywall's sentences
// get the /about treatment instead: an `en` and an `es` block, stacked, so
// half the household reads the Spanish first without wading through the
// English. Two full sentences joined by a middot is unreadable on a phone.
//
// ── The tone ───────────────────────────────────────────────────────────────
// Warm. Nobody has done anything wrong by using the thing they paid for. The
// sentence that has to be true is "here is where you stand", and the offer
// comes after it, once — never twice, and never with a countdown.

export interface Bilingual {
  en: string;
  es: string;
}

/** "12 min · 12 min" — the chrome convention, one line. */
export function joinBilingual(copy: Bilingual): string {
  return copy.en === copy.es ? copy.en : `${copy.en} · ${copy.es}`;
}

/**
 * Minutes, the way a person counts them.
 *
 * Rounded DOWN, because a chip that says "3 min" and delivers two and a half
 * is a small lie told every session. Anything above zero but under a minute is
 * its own phrase rather than "0 min" — the difference between "nearly out" and
 * "out" is the difference between a warning and a wall.
 */
export function minutesLabel(seconds: number): Bilingual {
  if (!Number.isFinite(seconds)) return { en: "Unlimited", es: "Sin límite" };
  const s = Math.max(0, Math.floor(seconds));
  if (s === 0) return { en: "None left", es: "Sin minutos" };
  if (s < 60) return { en: "Under a minute", es: "Menos de un minuto" };
  const m = Math.floor(s / 60);
  return { en: `${m} min`, es: `${m} min` };
}

/** The header chip: what is left, at a glance, in both languages. */
export function chipLabel(seconds: number, unlimited: boolean): string {
  if (unlimited) return "Founder · sin límite";
  const m = minutesLabel(seconds);
  // "12 min" reads the same in both languages, so it takes the suffix pair
  // instead of being printed twice. "Under a minute" does not, so it gets the
  // full middot treatment.
  return m.en === m.es ? `${m.en} left · restantes` : joinBilingual(m);
}

/** Said once, two minutes before a session's minutes run out. */
export const WARN_NOTICE: Bilingual = {
  en: "About two minutes left in this session. Finish your thought — it will end on the tutor's next pause, not mid-sentence.",
  es: "Quedan unos dos minutos en esta sesión. Termina tu idea — se cerrará en la siguiente pausa del tutor, no a media frase."
};

/** Said when a session ends because the minutes ran out. */
export const ENDED_NOTICE: Bilingual = {
  en: "That was the last of your tutor minutes for now.",
  es: "Esos fueron tus últimos minutos de tutor por ahora."
};

/** The heading on the out-of-minutes card. */
export const EXHAUSTED_TITLE: Bilingual = {
  en: "You're out of tutor minutes",
  es: "Te quedaste sin minutos de tutor"
};

/**
 * Why they are out, per tier.
 *
 * Free hears about the plans; a subscriber hears about packs, because they
 * already bought the plan and being sold it again is the thing that makes
 * people cancel.
 */
export function exhaustedBody(tier: string, packSeconds: number): Bilingual {
  if (packSeconds > 0) {
    return {
      en: "Your plan minutes are spent for this month, and there isn't quite enough left in your pack to start a session. Pack minutes roll over, so nothing is lost.",
      es: "Los minutos de tu plan se agotaron este mes, y no queda suficiente en tu paquete para empezar una sesión. Los minutos de paquete se acumulan, así que no se pierde nada."
    };
  }
  if (tier === "free") {
    return {
      en: "Free accounts get 15 tutor minutes a month. They reset on the 1st — or a plan starts you again today.",
      es: "Las cuentas gratuitas tienen 15 minutos de tutor al mes. Se renuevan el día 1 — o un plan te reinicia hoy mismo."
    };
  }
  return {
    en: "This month's plan minutes are spent. They reset on the 1st. A minute pack adds more today and rolls over — it never expires.",
    es: "Los minutos de tu plan de este mes se agotaron. Se renuevan el día 1. Un paquete de minutos añade más hoy y se acumula — nunca caduca."
  };
}

/** The buttons. Short, so the chrome convention applies. */
export const SEE_PLANS: Bilingual = { en: "See plans", es: "Ver planes" };
export const ADD_MINUTES: Bilingual = { en: "Add minutes", es: "Añadir minutos" };

/**
 * How the two kinds of minute behave, stated where the money is.
 *
 * This is the sentence the pricing page owes anyone buying a pack, and it is
 * the one thing about the metering model that is genuinely surprising: the
 * subscription's minutes are rented monthly and the pack's are bought
 * outright. Saying so before the charge is cheaper than saying so after it.
 */
export const ROLLOVER_NOTE: Bilingual = {
  en: "Plan minutes reset every month. Pack minutes are yours to keep and roll over.",
  es: "Los minutos del plan se renuevan cada mes. Los minutos de paquete son tuyos y se acumulan."
};
