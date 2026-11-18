// The words of the daily reminder — the email itself, the toggle on /study
// and /tutor, and the unsubscribe page. English and Spanish.
//
// This is lib/chrome/copy.ts's job done next door, because these strings are
// rendered on the SERVER into an email, by a cron, for a person who is not
// looking at a screen: there is no React, no `mine` from a hook, only the
// language saved on their row at opt-in.
//
// Voice: plain and warm. One phrase, one button. No marketing words, no
// exclamation marks, nothing that sounds like it wants something.
//
// EVERY SPANISH STRING BELOW: pendiente de revisión por Liz. An agent wrote
// them on 2026-11-18 and nobody who reads Spanish has checked them.

export type EmailLang = "en" | "es";

/** Spanish for a Spanish speaker; English for everyone else, for now. */
export function emailLang(code: string | null | undefined): EmailLang {
  return (code ?? "").trim().toLowerCase().startsWith("es") ? "es" : "en";
}

const EN = {
  // ── the daily email ────────────────────────────────────────────────────
  subject: "Today's phrase: {phrase}",
  preheader: "One phrase, one minute.",
  kicker: "Phrase of the day",
  means: "It means",
  invite: "Say it out loud once. Then come practice for a minute.",
  buttonStudy: "Open Study",
  buttonTutor: "Open Tutor",
  daysOne: "You practiced 1 day this week.",
  daysMany: "You practiced {days} days this week.",
  // ── the one "we've paused these" email ─────────────────────────────────
  pausedSubject: "We've paused your daily phrase",
  pausedPreheader: "Tap to start them again.",
  pausedTitle: "We've paused these",
  pausedBody:
    "You haven't opened Study or Tutor in a few weeks, so we've stopped sending the daily phrase. This is the last one.",
  pausedInvite: "If you'd like them back, open TAOS and they start again tomorrow.",
  pausedButton: "Resume",
  // ── footer ─────────────────────────────────────────────────────────────
  why: "You get this because you turned on the daily reminder in TAOS.",
  unsubscribe: "Unsubscribe",
  // ── the toggle (components/DailyReminder.tsx) ──────────────────────────
  toggle: "Remind me every day",
  toggleHint: "One short email with a phrase of the day. Turn it off any time.",
  toggleAt: "at",
  togglePaused: "Paused while you were away. It starts again tomorrow.",
  toggleBounced: "We couldn't deliver to your email address, so this is off.",
  toggleFailed: "Could not save that. Try again.",
  // ── the unsubscribe page ───────────────────────────────────────────────
  unsubDone: "You're unsubscribed. No more daily emails.",
  unsubWorking: "Unsubscribing…",
  unsubButton: "Unsubscribe",
  unsubInvalid: "This link is no longer valid. You can turn the reminder off inside TAOS, under Study or Tutor."
} as const;

export type EmailCopyKey = keyof typeof EN;
export type EmailCopy = Record<EmailCopyKey, string>;

// pendiente de revisión por Liz — every line.
const ES: EmailCopy = {
  subject: "La frase de hoy: {phrase}", // pendiente de revisión por Liz
  preheader: "Una frase, un minuto.", // pendiente de revisión por Liz
  kicker: "Frase del día", // pendiente de revisión por Liz
  means: "Significa", // pendiente de revisión por Liz
  invite: "Dila una vez en voz alta. Luego ven a practicar un minuto.", // pendiente de revisión por Liz
  buttonStudy: "Abrir Estudio", // pendiente de revisión por Liz
  buttonTutor: "Abrir Tutor", // pendiente de revisión por Liz
  daysOne: "Practicaste 1 día esta semana.", // pendiente de revisión por Liz
  daysMany: "Practicaste {days} días esta semana.", // pendiente de revisión por Liz
  pausedSubject: "Pausamos tu frase del día", // pendiente de revisión por Liz
  pausedPreheader: "Toca para recibirlas otra vez.", // pendiente de revisión por Liz
  pausedTitle: "Las pausamos", // pendiente de revisión por Liz
  pausedBody:
    "Hace unas semanas que no abres Estudio ni Tutor, así que dejamos de enviarte la frase del día. Este es el último correo.", // pendiente de revisión por Liz
  pausedInvite: "Si las quieres de vuelta, abre TAOS y empiezan otra vez mañana.", // pendiente de revisión por Liz
  pausedButton: "Reanudar", // pendiente de revisión por Liz
  why: "Recibes esto porque activaste el recordatorio diario en TAOS.", // pendiente de revisión por Liz
  unsubscribe: "Cancelar suscripción", // pendiente de revisión por Liz
  toggle: "Recuérdame cada día", // pendiente de revisión por Liz
  toggleHint: "Un correo corto con la frase del día. Apágalo cuando quieras.", // pendiente de revisión por Liz
  toggleAt: "a las", // pendiente de revisión por Liz
  togglePaused: "En pausa mientras no estabas. Empieza otra vez mañana.", // pendiente de revisión por Liz
  toggleBounced: "No pudimos entregar correo a tu dirección, así que está apagado.", // pendiente de revisión por Liz
  toggleFailed: "No se pudo guardar. Inténtalo de nuevo.", // pendiente de revisión por Liz
  unsubDone: "Suscripción cancelada. No habrá más correos diarios.", // pendiente de revisión por Liz
  unsubWorking: "Cancelando…", // pendiente de revisión por Liz
  unsubButton: "Cancelar suscripción", // pendiente de revisión por Liz
  unsubInvalid:
    "Este enlace ya no es válido. Puedes apagar el recordatorio dentro de TAOS, en Estudio o Tutor." // pendiente de revisión por Liz
};

export const EMAIL_COPY: Record<EmailLang, EmailCopy> = { en: EN, es: ES };

export function emailCopy(lang: string | null | undefined): EmailCopy {
  return EMAIL_COPY[emailLang(lang)];
}
