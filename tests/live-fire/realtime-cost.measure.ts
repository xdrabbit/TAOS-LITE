// Live-fire cost measurement for /live and /tabletop. REAL MONEY, REAL API.
//
//   npx vitest run --config vitest.measure.config.ts
//
// with OPENAI_API_KEY in the environment (node --env-file works, or export it).
// `npm test` does NOT run this — the default vitest config only picks up
// tests/**/*.test.ts, and this file is a .measure.ts on purpose.
//
// Narrow it while iterating, so a re-run costs cents rather than dollars:
//   MEASURE_SURFACE=live   MEASURE_ARMS=off,150   npx vitest run --config ...
//
// What it produces is the table in docs/realtime-cost-model.md. The method is
// the one the /call model established: the SAME audio through every arm,
// changing only the truncation setting, and reading the PER-TURN trend rather
// than the five-turn total. A total hides the finding; the finding is that
// uncapped, the per-turn re-read climbs for as long as the session is open.

import { describe, expect, it } from "vitest";
import { buildLiveSession } from "@/lib/live/session";
import { buildTabletopSession } from "@/lib/tabletop/session";
import { buildTurnInstructions } from "@/lib/tabletop/instructions";
import { AUDIO_TOKENS_PER_SECOND, REALTIME_RATES_USD_PER_MTOK } from "@/lib/call/cost";
import { billedRatio, driveSession, synthesize, type RunResult, type Utterance } from "./realtime-driver";

const MODEL = process.env.OPENAI_LIVE_REALTIME_MODEL?.trim() || "gpt-realtime";
const TRANSCRIBE = "gpt-4o-mini-transcribe";

/**
 * Six turns of a Spanish dinner table — the scene /live exists for. Six rather
 * than /call's five because the whole question is whether the per-turn re-read
 * climbs, and a sixth turn is another point on that line for the price of one
 * short utterance.
 *
 * The content matters: they refer back to each other ("ese", "lo mismo"), so a
 * cap that is too tight will show up as a summary that has lost the thread,
 * not merely as a cheaper number.
 */
const DINNER_ES = [
  "Oye, ¿al final vamos a la playa el sábado o lo dejamos para el domingo?",
  "El sábado hay muchísima gente, y además dijeron que va a llover por la tarde.",
  "Entonces el domingo. Pero salimos temprano, porque el tráfico en ese puente es horrible.",
  "Vale, a las ocho. Yo llevo la comida y tú te encargas de la sombrilla y las toallas.",
  "Mi hermana quiere venir con los niños, ¿te parece bien? Son tres, pero se portan bien.",
  "Claro que sí, cuantos más mejor. Le digo lo mismo a Carlos, que también preguntó."
];

/**
 * Six push-to-talk turns at a table, alternating sides. Short, because that is
 * what a table turn is — one thought, handed over.
 */
const TABLE_TURNS: Array<{ text: string; source: string; target: string }> = [
  { text: "Hola, mucho gusto. ¿De dónde eres?", source: "es", target: "en" },
  { text: "I'm from Colorado, but I've been living here for about three years now.", source: "en", target: "es" },
  { text: "Qué bien. ¿Y te gusta la comida de aquí?", source: "es", target: "en" },
  { text: "I love it. The seafood especially — we don't get anything like that at home.", source: "en", target: "es" },
  { text: "Tienes que probar el pulpo a la gallega antes de irte.", source: "es", target: "en" },
  { text: "Write that down for me, I'll never remember how to say it.", source: "en", target: "es" }
];

/** Which context caps to measure. "off" is the uncapped "before" column. */
const ARMS: Array<number | null> = (process.env.MEASURE_ARMS ?? "off,200,150,100")
  .split(",")
  .map((a) => a.trim())
  .filter(Boolean)
  .map((a) => (a === "off" ? null : Number(a)));

const SURFACES = (process.env.MEASURE_SURFACE ?? "live,tabletop").split(",").map((s) => s.trim());

/** Shorten a run while validating the rig — the full six turns are the point. */
const TURN_LIMIT = Number(process.env.MEASURE_TURNS ?? "0") || Number.MAX_SAFE_INTEGER;

function armLabel(cap: number | null): string {
  return cap === null ? "uncapped (auto)" : `post_instructions: ${cap}`;
}

/** Model-side dollars for one run, priced exactly as the on-screen meter does. */
function modelUsd(run: RunResult): number {
  const R = REALTIME_RATES_USD_PER_MTOK;
  return (
    run.turns.reduce((sum, t) => {
      const uncachedText = Math.max(0, t.textInTokens - t.cachedTextInTokens);
      const uncachedAudio = Math.max(0, t.audioInTokens - t.cachedAudioInTokens);
      return (
        sum +
        uncachedText * R.textIn +
        t.cachedTextInTokens * R.textInCached +
        uncachedAudio * R.audioIn +
        t.cachedAudioInTokens * R.audioInCached +
        t.textOutTokens * R.textOut +
        t.audioOutTokens * R.audioOut
      );
    }, 0) / 1e6
  );
}

/** One line item's dollars, cached tokens priced at the cached rate. */
function lineUsd(run: RunResult, item: "audioIn" | "textIn" | "textOut" | "audioOut"): number {
  const R = REALTIME_RATES_USD_PER_MTOK;
  return (
    run.turns.reduce((sum, t) => {
      if (item === "audioIn") {
        return (
          sum +
          Math.max(0, t.audioInTokens - t.cachedAudioInTokens) * R.audioIn +
          t.cachedAudioInTokens * R.audioInCached
        );
      }
      if (item === "textIn") {
        return (
          sum +
          Math.max(0, t.textInTokens - t.cachedTextInTokens) * R.textIn +
          t.cachedTextInTokens * R.textInCached
        );
      }
      if (item === "textOut") return sum + t.textOutTokens * R.textOut;
      return sum + t.audioOutTokens * R.audioOut;
    }, 0) / 1e6
  );
}

function report(run: RunResult): void {
  const perTurn = run.turns.map((t) => t.audioInTokens).join(" → ");
  const ratio = billedRatio(run);
  const spokenTokens = Math.round(run.spokenSeconds * AUDIO_TOKENS_PER_SECOND);
  // eslint-disable-next-line no-console
  console.log(
    [
      ``,
      `── ${run.label} ─────────────────────────────`,
      `spoken            ${run.spokenSeconds.toFixed(1)}s (${spokenTokens} audio tokens)`,
      `VAD committed     ${run.committedSeconds.toFixed(1)}s`,
      `billed audio in   ${run.turns.reduce((s, t) => s + t.audioInTokens, 0)} tok = ${(ratio * 100).toFixed(0)}% of spoken`,
      `per-turn in_audio ${perTurn}`,
      `text in / out     ${run.turns.reduce((s, t) => s + t.textInTokens, 0)} / ${run.turns.reduce((s, t) => s + t.textOutTokens, 0)}`,
      `audio out         ${run.turns.reduce((s, t) => s + t.audioOutTokens, 0)}`,
      // Split, not summed: cached audio and cached text are billed at the same
      // discounted rate but come off DIFFERENT line items, and the per-minute
      // breakdown in docs/realtime-cost-model.md cannot be derived from a
      // total. Publishing a split that was reasoned rather than measured is
      // exactly the habit this rig exists to break.
      `cached txt/audio  ${run.turns.reduce((s, t) => s + t.cachedTextInTokens, 0)} / ${run.turns.reduce((s, t) => s + t.cachedAudioInTokens, 0)}`,
      `  → audio in      $${lineUsd(run, "audioIn").toFixed(4)}`,
      `  → text in       $${lineUsd(run, "textIn").toFixed(4)}`,
      `  → text out      $${lineUsd(run, "textOut").toFixed(4)}`,
      `  → audio out     $${lineUsd(run, "audioOut").toFixed(4)}`,
      `model cost        $${modelUsd(run).toFixed(4)}`,
      `heard             ${run.heard.map((h) => `“${h}”`).join(" | ")}`,
      `output            ${run.turns.map((t) => `${t.index}. ${t.output}`).join("\n                  ")}`,
      ``
    ].join("\n")
  );
}

describe("what a realtime minute actually costs, per surface", () => {
  it(
    "measures /live ambient across context caps",
    async () => {
      if (!SURFACES.includes("live")) return;
      const utterances: Utterance[] = [];
      for (const line of DINNER_ES.slice(0, TURN_LIMIT)) utterances.push(await synthesize(line));

      for (const cap of ARMS) {
        const run = await driveSession({
          label: `/live · ${armLabel(cap)}`,
          model: MODEL,
          session: buildLiveSession({
            target: "en",
            source: "es",
            model: MODEL,
            voice: "marin",
            transcribeModel: TRANSCRIBE,
            contextTokenLimit: cap
          }),
          utterances,
          // /live mints create_response:false — the client asks. See ambient.ts.
          serverCreatesResponses: false
        });
        report(run);
        expect(run.turns.length).toBe(utterances.length);
      }
    },
    20 * 60 * 1000
  );

  it(
    "measures /tabletop turns across context caps",
    async () => {
      if (!SURFACES.includes("tabletop")) return;
      const utterances: Utterance[] = [];
      for (const turn of TABLE_TURNS.slice(0, TURN_LIMIT)) utterances.push(await synthesize(turn.text));

      for (const cap of ARMS) {
        const run = await driveSession({
          label: `/tabletop · ${armLabel(cap)}`,
          model: MODEL,
          session: buildTabletopSession({
            direction: { source: "es", target: "en" },
            model: MODEL,
            transcribeModel: TRANSCRIBE,
            contextTokenLimit: cap
          }),
          utterances,
          // The phone goes round the table: every turn re-points the
          // interpreter first, exactly as beginTurn does in lib/tabletop/live.ts.
          beforeUtterance: (i) => {
            const turn = TABLE_TURNS[i];
            if (!turn) return null;
            return {
              type: "realtime",
              instructions: buildTurnInstructions({ source: turn.source, target: turn.target })
            };
          },
          // /tabletop mints create_response:true — the server responds per segment.
          serverCreatesResponses: true
        });
        report(run);
        expect(run.turns.length).toBeGreaterThanOrEqual(utterances.length);
      }
    },
    20 * 60 * 1000
  );
});
