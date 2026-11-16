// Live-fire probe for /live's two styles. REAL MONEY, REAL API (cents).
//
//   node --env-file=.env.local node_modules/vitest/vitest.mjs run \
//     --config vitest.measure.config.ts tests/live-fire/live-style.measure.ts
//
// `npm test` does NOT run this (see vitest.measure.config.ts).
//
// Three questions, each of which a unit test cannot answer:
//
//   1. Does the word-for-word prompt actually produce every sentence — the
//      aside, the repetition — or does a model told to be an "interpreter in
//      an earpiece" tidy them away anyway? (Prompt fences backfire; the 7/27
//      audit is why this is probed rather than assumed.)
//   2. Does a `session.update` carrying the OTHER style's patch take effect on
//      the next response of a session that is already open — including the
//      two cost guards, `truncation` and `max_output_tokens`? That is what
//      lets the toggle apply without a restart, and it is read off the
//      server's own `session.updated` echo, not off the fact that we sent it.
//   3. What does a minute of each style cost, on the same audio?
//
// The rig does what the client does: the sessions come from buildLiveSession,
// the mid-session switch sends exactly buildLiveStylePatch — the object the
// mint route hands the browser — and the client asks for each response
// itself, as lib/live/ambient.ts does.

import { describe, expect, it } from "vitest";
import { buildLiveSession, buildLiveStylePatch } from "@/lib/live/session";
import { nextResponse } from "@/lib/live/respond";
import type { LiveStyle } from "@/lib/live/style";
import { AUDIO_TOKENS_PER_SECOND, REALTIME_RATES_USD_PER_MTOK } from "@/lib/call/cost";
import { driveSession, SAMPLE_RATE, synthesize, type RunResult, type Utterance } from "./realtime-driver";

const MODEL = process.env.OPENAI_LIVE_REALTIME_MODEL?.trim() || "gpt-realtime";
const TRANSCRIBE = "gpt-4o-mini-transcribe";

/**
 * A Spanish dinner table, built to catch a summarizer pretending to be
 * literal: line 3 has an aside that has nothing to do with anything, line 4
 * repeats itself, line 5 is a question (which must be rendered, not answered).
 */
const TABLE_ES = [
  "Oye, ¿al final vamos a la playa el sábado o lo dejamos para el domingo?",
  "El sábado hay muchísima gente, y además dijeron que va a llover por la tarde.",
  "Ah, y por cierto, esto no tiene nada que ver, pero ayer vi a tu prima en el mercado, la del pelo rojo. Bueno, a lo que iba: salimos a las ocho.",
  "No se te olvide el protector solar. No se te olvide, que la última vez te quemaste toda la espalda.",
  "¿Tú sabes cuánto cuesta el estacionamiento allá? Creo que eran doce dólares, pero no estoy segura."
];

/** Two separate remarks with a real pause between them: VAD commits two
 *  segments and ONE response has to cover both — /live's coalescing case. */
const COALESCED_ES = [
  "Mi hermana quiere venir con los niños. Son tres, pero se portan bien.",
  "Y Carlos también preguntó si puede traer a su perro, que es pequeño."
];

function silence(ms: number): Buffer {
  return Buffer.alloc(Math.round((SAMPLE_RATE * 2 * ms) / 1000));
}

async function utterances(): Promise<Utterance[]> {
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

function session(style: LiveStyle): Record<string, unknown> {
  return buildLiveSession({
    target: "en",
    source: "es",
    model: MODEL,
    voice: "marin",
    transcribeModel: TRANSCRIBE,
    style
  });
}

function usd(run: RunResult): number {
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

function report(run: RunResult): void {
  const cost = usd(run);
  // eslint-disable-next-line no-console
  console.log(
    [
      ``,
      `── ${run.label} ─────────────────────────────`,
      `spoken            ${run.spokenSeconds.toFixed(1)}s (${Math.round(run.spokenSeconds * AUDIO_TOKENS_PER_SECOND)} audio tokens)`,
      `per-turn in_audio ${run.turns.map((t) => t.audioInTokens).join(" → ")}`,
      `per-turn out_audio ${run.turns.map((t) => t.audioOutTokens).join(" → ")}`,
      `model cost        $${cost.toFixed(4)}  = $${((cost / run.spokenSeconds) * 60).toFixed(3)} per minute of room speech`,
      `heard             ${run.heard.map((h) => `“${h}”`).join("\n                  ")}`,
      `output            ${run.turns.map((t) => `${t.index}. ${t.output}`).join("\n                  ")}`,
      ``
    ].join("\n")
  );
}

/** MEASURE_ONLY=styles | backlog narrows a re-run to one question. */
const ONLY = process.env.MEASURE_ONLY?.trim() || "";

describe("/live styles against the real API", () => {
  it(
    "summary vs word-for-word on the same audio, and a mid-session switch",
    async () => {
      if (ONLY && ONLY !== "styles") return;
      const table = await utterances();

      for (const style of ["summary", "verbatim"] as const) {
        const run = await driveSession({
          label: `/live · ${style}`,
          model: MODEL,
          session: session(style),
          utterances: table,
          serverCreatesResponses: false,
          nextResponse: (pending, now) => nextResponse(style, pending, now)
        });
        report(run);
        expect(run.turns.length).toBeGreaterThanOrEqual(table.length);
      }

      // Minted as summary; flipped to word-for-word before the 3rd utterance
      // and back before the 5th — the toggle, tapped twice during dinner.
      const echoes: Array<Record<string, unknown>> = [];
      const plan: Record<number, LiveStyle> = { 2: "verbatim", 4: "summary" };
      let current: LiveStyle = "summary";
      const switched = await driveSession({
        label: "/live · summary → verbatim (before 3) → summary (before 5), ONE session",
        model: MODEL,
        session: session("summary"),
        utterances: table,
        serverCreatesResponses: false,
        nextResponse: (pending, now) => nextResponse(current, pending, now),
        beforeUtterance: (i) => {
          if (!plan[i]) return null;
          current = plan[i];
          return buildLiveStylePatch({ style: current, target: "en", source: "es" });
        },
        onEvent: (type, ev) => {
          if (type === "session.updated") echoes.push((ev.session ?? {}) as Record<string, unknown>);
        }
      });
      report(switched);
      // eslint-disable-next-line no-console
      console.log(
        "session.updated echoes (max_output_tokens, truncation):\n" +
          echoes
            .map((s, i) => `  ${i}. ${JSON.stringify(s.max_output_tokens)} ${JSON.stringify(s.truncation)}`)
            .join("\n")
      );
      expect(switched.turns.length).toBeGreaterThanOrEqual(table.length);
    },
    20 * 60 * 1000
  );

  // The question the per-segment design raises: word-for-word runs BEHIND, so
  // the segment being rendered is often not the newest thing in the
  // conversation. Can the server's truncation prune a segment out from under
  // its own `item_reference` before it is rendered?
  //
  // Yes. Asked the hard way first (MEASURE_BACKLOG_CAP=50: five seconds of
  // context, four remarks queued), three of the responses came back with
  // `in_audio: 0` and invented speech — "Really? And did you notice how that
  // guy was looking at her?". That run is why LIVE_VERBATIM_CONTEXT_TOKEN_LIMIT
  // is sized the way it is and why lib/live/respond.ts refuses to render a
  // segment older than LIVE_VERBATIM_MAX_LAG_MS.
  //
  // The default here is the session that SHIPS, and the assertion is on the
  // number that failed: every response must have been handed audio.
  it(
    "word-for-word renders a whole queued backlog, oldest first, and every response is handed its audio",
    async () => {
      if (ONLY && ONLY !== "backlog") return;
      const capOverride = Number(process.env.MEASURE_BACKLOG_CAP ?? "0") || undefined;
      const parts: Utterance[] = [];
      for (const line of TABLE_ES.slice(0, 4)) parts.push(await synthesize(line));
      const backlog: Utterance = {
        text: TABLE_ES.slice(0, 4).join(" "),
        pcm: Buffer.concat(parts.flatMap((p, i) => (i === 0 ? [p.pcm] : [silence(1500), p.pcm]))),
        seconds: parts.reduce((sum, p) => sum + p.seconds, 0)
      };
      const run = await driveSession({
        label: `/live · verbatim · four remarks queued · cap ${capOverride ?? "as shipped"}`,
        model: MODEL,
        session: buildLiveSession({
          target: "en",
          source: "es",
          model: MODEL,
          voice: "marin",
          transcribeModel: TRANSCRIBE,
          style: "verbatim",
          contextTokenLimit: capOverride
        }),
        utterances: [backlog],
        serverCreatesResponses: false,
        nextResponse: (pending, now) => nextResponse("verbatim", pending, now)
      });
      report(run);
      expect(run.turns.length).toBeGreaterThanOrEqual(4);
      expect(run.turns.map((t) => t.audioInTokens).every((n) => n > 0)).toBe(true);
    },
    20 * 60 * 1000
  );
});
