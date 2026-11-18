// The phrase of the day.
//
// RULE (Tom, 2026-11-18): no user conversation text in email, ever. The email
// leaves through a third-party provider, and message text does not leave the
// database. So the daily hook comes from HERE — two lines from each of the
// fourteen days of the built-in course (content/tutor-course, the
// "Micro-Sentences" tables) — and from nowhere else. Nothing in lib/email
// reads the translations table's text; tests/daily-email.test.ts pins both
// halves: every phrase below is found in the course files, and the sender's
// source never names a text column.
//
// The Spanish carries its accents and opening marks here; the course files
// were typed without them. The test compares with both stripped.
//
// Everyone gets the same phrase on the same local day, and the list comes
// round every four weeks.

export interface DailyPhrase {
  en: string;
  es: string;
}

export const DAILY_PHRASES: readonly DailyPhrase[] = [
  { en: "Thank you.", es: "Gracias." },
  { en: "I need help.", es: "Necesito ayuda." },
  { en: "I am here.", es: "Estoy aquí." },
  { en: "Now I listen.", es: "Ahora escucho." },
  { en: "I do not understand.", es: "No entiendo." },
  { en: "I go home.", es: "Voy a casa." },
  { en: "Where is the bathroom?", es: "¿Dónde está el baño?" },
  { en: "How do I pay?", es: "¿Cómo pago?" },
  { en: "I have a question.", es: "Tengo una pregunta." },
  { en: "I want water.", es: "Quiero agua." },
  { en: "Go straight.", es: "Ve recto." },
  { en: "Go left.", es: "Ve a la izquierda." },
  { en: "Can I sit here?", es: "¿Puedo sentarme aquí?" },
  { en: "I do not have my card.", es: "No tengo mi tarjeta." },
  { en: "I am hungry.", es: "Tengo hambre." },
  { en: "Bread and water, please.", es: "Pan y agua, por favor." },
  { en: "Where is the door?", es: "¿Dónde está la puerta?" },
  { en: "I need my key.", es: "Necesito mi llave." },
  { en: "Three coffees, please.", es: "Tres cafés, por favor." },
  { en: "Ten minutes.", es: "Diez minutos." },
  { en: "What time is it?", es: "¿Qué hora es?" },
  { en: "Tomorrow I study.", es: "Mañana estudio." },
  { en: "How much is it?", es: "¿Cuánto cuesta?" },
  { en: "Can I pay here?", es: "¿Puedo pagar aquí?" },
  { en: "This is my family.", es: "Esta es mi familia." },
  { en: "They are my friends.", es: "Ellos son mis amigos." },
  { en: "Later I go home.", es: "Después voy a casa." },
  { en: "I am hungry and thirsty.", es: "Tengo hambre y sed." }
];

/** The phrase for a local day (YYYY-MM-DD). Deterministic. */
export function phraseForDay(day: string): DailyPhrase {
  const n = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
  const index = Number.isFinite(n) ? ((n % DAILY_PHRASES.length) + DAILY_PHRASES.length) % DAILY_PHRASES.length : 0;
  return DAILY_PHRASES[index];
}
