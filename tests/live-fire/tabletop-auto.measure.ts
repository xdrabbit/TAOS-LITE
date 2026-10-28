// Live-fire probe for /tabletop auto-detect: does gpt-realtime actually open
// every response with the right `[xx] ` tag when the two people alternate?
//
// It is not a test — it costs real money (a few cents) and needs
// OPENAI_API_KEY. Run it with the measurement config:
//
//   OPENAI_API_KEY=… npx vitest run --config vitest.measure.config.ts tests/live-fire/tabletop-auto.measure.ts
//
// The session comes from the shipped builder with `auto` set, and before each
// utterance the probe sends exactly the session.update the client's beginTurn
// sends on an auto turn (buildAutoInstructions) — the lesson in
// realtime-driver.ts about a rig that skips the client's per-turn update.
import { describe, expect, it } from "vitest";
import { driveSession, synthesize } from "./realtime-driver";
import { buildTabletopSession } from "@/lib/tabletop/session";
import { buildAutoInstructions } from "@/lib/tabletop/instructions";
import { parseTag } from "@/lib/tabletop/autoDetect";

const PAIR = ["es", "en"] as const;

// Spoken language → the tag the response must carry (the OTHER one).
const SCRIPT: { lang: "es" | "en"; text: string; voice: string }[] = [
  { lang: "es", text: "Buenas tardes, vengo a recoger una receta para mi mamá.", voice: "nova" },
  { lang: "en", text: "Sure, what's the last name on the prescription?", voice: "onyx" },
  { lang: "es", text: "Se llama Rodríguez, Marta Rodríguez.", voice: "nova" },
  { lang: "en", text: "Got it. Is she allergic to any medications?", voice: "onyx" },
  { lang: "es", text: "Sí, a la penicilina.", voice: "nova" },
  { lang: "en", text: "Okay, take one tablet twice a day with food.", voice: "onyx" },
  { lang: "es", text: "¿Y cuánto cuesta?", voice: "nova" },
  { lang: "en", text: "With her insurance it's twelve dollars.", voice: "onyx" }
];

describe("tabletop auto-detect, live", () => {
  it("tags each alternating phrase with the other language", async () => {
    const model = process.env.OPENAI_TABLETOP_REALTIME_MODEL?.trim() || "gpt-realtime";
    const auto = { a: PAIR[0], b: PAIR[1] };
    const session = buildTabletopSession({
      direction: { source: "es", target: "en" },
      model,
      transcribeModel: "gpt-4o-mini-transcribe",
      auto
    });
    const utterances = [];
    for (const line of SCRIPT) utterances.push(await synthesize(line.text, line.voice));

    const run = await driveSession({
      label: "tabletop-auto",
      model,
      session,
      utterances,
      serverCreatesResponses: true,
      beforeUtterance: () => ({ type: "realtime", instructions: buildAutoInstructions(auto) })
    });

    let hits = 0;
    let right = 0;
    run.turns.forEach((t, i) => {
      const spoken = SCRIPT[i]?.lang;
      const want = spoken === "es" ? "en" : "es";
      const { verdict, text } = parseTag(t.output, PAIR);
      const got = verdict.kind === "hit" ? verdict.code : "MISS";
      if (verdict.kind === "hit") hits += 1;
      if (got === want) right += 1;
      console.log(`[auto-probe] #${i} spoke=${spoken} want=[${want}] got=${got} raw=${JSON.stringify(t.output)} text=${JSON.stringify(text)}`);
    });
    console.log(`[auto-probe] turns=${run.turns.length} tag_hits=${hits} right_direction=${right}`);
    expect(run.turns.length).toBeGreaterThan(0);
  });
});
