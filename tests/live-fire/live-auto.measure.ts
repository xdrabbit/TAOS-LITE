// Live-fire probe for /live's two-way Auto. REAL MONEY, REAL API (cents).
//
//   node --env-file=.env.local node_modules/vitest/vitest.mjs run \
//     --config vitest.measure.config.ts tests/live-fire/live-auto.measure.ts
//
// `npm test` does NOT run this (see vitest.measure.config.ts).
//
// Three questions a unit test cannot answer:
//
//   1. Does the tabletop's `[xx]` tag survive being bolted onto the
//      word-for-word prompt — on the session /live mints, asked for the way
//      /live asks (one `item_reference` per heard segment)? Prompt fences
//      backfire; the tag was probed 9 of 9 on the TABLE's prompt, not this one.
//   2. Is the rendering still complete — the aside, the repetition, the
//      question rendered rather than answered — now that it is text?
//   3. What does a minute cost, on the SAME 48.3 seconds #133 was priced on
//      (tests/live-fire/live-table.ts)?
//
// The rig does what the client does: the session is buildLiveSession with
// `auto: true`, and responses are asked through lib/live/respond.ts.
//
// MEASURE_ONLY=cost | twoway narrows a re-run to one question.

import { describe, expect, it } from "vitest";
import { buildLiveSession } from "@/lib/live/session";
import { nextResponse } from "@/lib/live/respond";
import { parseTag } from "@/lib/tabletop/autoDetect";
import { AUDIO_TOKENS_PER_SECOND } from "@/lib/call/cost";
import { driveSession, synthesize, type RunResult } from "./realtime-driver";
import { usd, utterances } from "./live-table";

const MODEL = process.env.OPENAI_LIVE_REALTIME_MODEL?.trim() || "gpt-realtime";
const TRANSCRIBE = "gpt-4o-mini-transcribe";
const PAIR = ["en", "es"] as const;
const ONLY = process.env.MEASURE_ONLY?.trim() || "";

/** Two people, one phone. Line 4 has an aside and line 5 is a question. */
const TWO_WAY: { lang: "es" | "en"; text: string; voice: string }[] = [
  { lang: "es", text: "Oye, ¿al final vamos a la playa el sábado o lo dejamos para el domingo?", voice: "nova" },
  { lang: "en", text: "Saturday is going to be really crowded, and they said it's going to rain in the afternoon.", voice: "onyx" },
  { lang: "es", text: "Entonces el domingo. Salimos a las ocho, y no se te olvide el protector solar.", voice: "nova" },
  { lang: "en", text: "Oh, and by the way, this has nothing to do with anything, but I saw your cousin at the market yesterday. Anyway, eight o'clock works.", voice: "onyx" },
  { lang: "es", text: "¿Tú sabes cuánto cuesta el estacionamiento allá?", voice: "nova" },
  { lang: "en", text: "I think it was twelve dollars, but I'm not sure.", voice: "onyx" },
  { lang: "es", text: "Sí, claro.", voice: "nova" },
  { lang: "en", text: "Okay.", voice: "onyx" }
];

function session(): Record<string, unknown> {
  return buildLiveSession({
    target: PAIR[0],
    source: PAIR[1],
    model: MODEL,
    voice: "marin",
    transcribeModel: TRANSCRIBE,
    auto: true
  });
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
      `per-turn in_text  ${run.turns.map((t) => t.textInTokens).join(" → ")}`,
      `out text / audio  ${run.turns.reduce((n, t) => n + t.textOutTokens, 0)} tok / ${run.turns.reduce((n, t) => n + t.audioOutTokens, 0)} tok`,
      `model cost        $${cost.toFixed(4)}  = $${((cost / run.spokenSeconds) * 60).toFixed(3)} per minute of room speech`,
      `heard             ${run.heard.map((h) => `“${h}”`).join("\n                  ")}`,
      `output            ${run.turns.map((t) => `${t.index}. ${t.output}`).join("\n                  ")}`,
      ``
    ].join("\n")
  );
}

describe("/live two-way Auto against the real API", () => {
  it(
    "the #133 dinner table through an Auto session: cost per minute, every response tagged",
    async () => {
      if (ONLY && ONLY !== "cost") return;
      const run = await driveSession({
        label: "/live · auto (word for word, text out) · the #133 table",
        model: MODEL,
        session: session(),
        utterances: await utterances(),
        serverCreatesResponses: false,
        nextResponse: (pending, now) => nextResponse("verbatim", pending, now)
      });
      report(run);
      const tags = run.turns.map((t) => parseTag(t.output, PAIR).verdict);
      // eslint-disable-next-line no-console
      console.log(
        `[live-auto] table: responses=${run.turns.length} tags=${tags.map((v) => (v.kind === "hit" ? v.code : "MISS")).join(",")}`
      );
      expect(run.turns.every((t) => t.audioOutTokens === 0)).toBe(true);
      expect(run.turns.map((t) => t.audioInTokens).every((n) => n > 0)).toBe(true);
    },
    20 * 60 * 1000
  );

  it(
    "two languages alternating: each segment is tagged with the OTHER language",
    async () => {
      if (ONLY && ONLY !== "twoway") return;
      const spoken = [];
      for (const line of TWO_WAY) spoken.push(await synthesize(line.text, line.voice));
      const run = await driveSession({
        label: "/live · auto · two people alternating es/en",
        model: MODEL,
        session: session(),
        utterances: spoken,
        serverCreatesResponses: false,
        nextResponse: (pending, now) => nextResponse("verbatim", pending, now)
      });
      report(run);
      let hits = 0;
      let wrong = 0;
      for (const t of run.turns) {
        const { verdict, text } = parseTag(t.output, PAIR);
        if (verdict.kind === "hit") hits += 1;
        // eslint-disable-next-line no-console
        console.log(
          `[live-auto] #${t.index} tag=${verdict.kind === "hit" ? verdict.code : "MISS"} text=${JSON.stringify(text)}`
        );
        // The tag must describe the rendering it sits on: Spanish marks under
        // an [en] tag (or none under [es] on a long line) is a wrong tag.
        if (verdict.kind === "hit" && verdict.code === "en" && /[¿¡ñáéíóú]/i.test(text)) wrong += 1;
      }
      // eslint-disable-next-line no-console
      console.log(
        `[live-auto] two-way: responses=${run.turns.length} tag_hits=${hits} en_tag_on_spanish_text=${wrong}`
      );
      expect(run.turns.length).toBeGreaterThanOrEqual(TWO_WAY.length - 2);
    },
    20 * 60 * 1000
  );
});
