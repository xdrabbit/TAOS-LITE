// The dinner table /live is measured on, and the arithmetic that prices a run.
//
// Its own file since 2026-11-17 so that live-style.measure.ts (summary vs word
// for word, #133) and live-auto.measure.ts (two-way Auto) put THE SAME audio
// through the session: "against the #133 numbers" only means something if the
// 48.3 seconds are the same 48.3 seconds. Not a test and not a measurement:
// vitest.measure.config.ts only collects *.measure.ts.

import { REALTIME_RATES_USD_PER_MTOK } from "@/lib/call/cost";
import { SAMPLE_RATE, synthesize, type RunResult, type Utterance } from "./realtime-driver";

/**
 * A Spanish dinner table, built to catch a summarizer pretending to be
 * literal: line 3 has an aside that has nothing to do with anything, line 4
 * repeats itself, line 5 is a question (which must be rendered, not answered).
 */
export const TABLE_ES = [
  "Oye, ¿al final vamos a la playa el sábado o lo dejamos para el domingo?",
  "El sábado hay muchísima gente, y además dijeron que va a llover por la tarde.",
  "Ah, y por cierto, esto no tiene nada que ver, pero ayer vi a tu prima en el mercado, la del pelo rojo. Bueno, a lo que iba: salimos a las ocho.",
  "No se te olvide el protector solar. No se te olvide, que la última vez te quemaste toda la espalda.",
  "¿Tú sabes cuánto cuesta el estacionamiento allá? Creo que eran doce dólares, pero no estoy segura."
];

/** Two separate remarks with a real pause between them: VAD commits two
 *  segments and ONE response has to cover both — /live's coalescing case. */
export const COALESCED_ES = [
  "Mi hermana quiere venir con los niños. Son tres, pero se portan bien.",
  "Y Carlos también preguntó si puede traer a su perro, que es pequeño."
];

export function silence(ms: number): Buffer {
  return Buffer.alloc(Math.round((SAMPLE_RATE * 2 * ms) / 1000));
}

export async function utterances(): Promise<Utterance[]> {
  const out: Utterance[] = [];
  for (const line of TABLE_ES) out.push(await synthesize(line));
  const [a, b] = [await synthesize(COALESCED_ES[0]), await synthesize(COALESCED_ES[1])];
  out.push({
    text: COALESCED_ES.join(" "),
    pcm: Buffer.concat([a.pcm, silence(1500), b.pcm]),
    seconds: a.seconds + b.seconds
  });
  return out;
}

export function usd(run: RunResult): number {
  const R = REALTIME_RATES_USD_PER_MTOK;
  return (
    run.turns.reduce((sum, t) => {
      const text = Math.max(0, t.textInTokens - t.cachedTextInTokens);
      const audio = Math.max(0, t.audioInTokens - t.cachedAudioInTokens);
      return (
        sum +
        text * R.textIn +
        t.cachedTextInTokens * R.textInCached +
        audio * R.audioIn +
        t.cachedAudioInTokens * R.audioInCached +
        t.textOutTokens * R.textOut +
        t.audioOutTokens * R.audioOut
      );
    }, 0) / 1e6
  );
}

