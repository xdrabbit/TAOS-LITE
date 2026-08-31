// Which engine should /fast run on? Measured, not assumed.
//
//   npx vitest run --config vitest.measure.config.ts
//
// Live fire: this talks to the real providers and spends real money (about a
// tenth of a cent per full run). vitest.measure.config.ts is why `npm test`
// and CI never see it.
//
// It measures the two candidate engines on the same fixtures, through the
// SHIPPED builders (lib/fast/prompt.ts, lib/fast/azure.ts) rather than through
// a prompt written for the rig — the lesson from the tutor measurement rig
// that invented a quality cliff by skipping what the client actually sends.
//
// Azure needs AZURE_TRANSLATOR_KEY + AZURE_TRANSLATOR_REGION. Without them
// this file measures the LLM candidates alone and says so; the Azure numbers
// in docs/fast-engine.md are stamped with the date they were taken.
import { describe, it } from "vitest";
import { buildLiteralInstructions } from "@/lib/fast/prompt";
import { azureCredentials, azureTranslatePair } from "@/lib/fast/azure";
import { languageLabel, type LanguageCode } from "@/lib/languages/catalog";

const OPENAI_KEY = process.env.OPENAI_API_KEY?.trim() ?? "";

/** $/1M tokens, in/out. Update alongside the provider's pricing page. */
const PRICES: Record<string, { in: number; out: number }> = {
  "gpt-4.1-nano": { in: 0.1, out: 0.4 },
  "gpt-4.1-mini": { in: 0.4, out: 1.6 },
  "gpt-5.4-nano": { in: 0.05, out: 0.4 }
};

const MODELS = Object.keys(PRICES);

/** $/1M CHARACTERS of source text — Azure bills the input, not the output. */
const AZURE_PER_MILLION_CHARS = 10;

/**
 * Quickie fixtures: what somebody actually types into a one-line box.
 *
 * Three groups, and the last two are the ones that decide this.
 *   plain    — the everyday lookups the screen exists for
 *   idiom    — where "literal" and "natural" give DIFFERENT answers, so an
 *              engine that silently smooths is visible
 *   partial  — mid-typing input, which is most of what an as-you-type surface
 *              ever sends. An engine that completes the thought fails here.
 */
const FIXTURES: Array<{ group: string; text: string }> = [
  { group: "plain", text: "bathroom" },
  { group: "plain", text: "where is the train station" },
  { group: "plain", text: "how much does this cost" },
  { group: "plain", text: "two coffees please" },
  { group: "plain", text: "my son is allergic to peanuts" },
  { group: "idiom", text: "I am looking forward to it" },
  { group: "idiom", text: "it costs an arm and a leg" },
  { group: "idiom", text: "no worries" },
  { group: "partial", text: "how do I get to the" },
  { group: "partial", text: "can you tell me where" }
];

const PAIRS: Array<[LanguageCode, LanguageCode]> = [
  ["en", "es"],
  ["en", "pl"]
];

interface Sample {
  engine: string;
  pair: string;
  group: string;
  input: string;
  output: string;
  ms: number;
  usd: number;
}

async function openaiLiteral(
  model: string,
  text: string,
  source: LanguageCode,
  target: LanguageCode
): Promise<{ output: string; ms: number; usd: number }> {
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: buildLiteralInstructions(languageLabel(source), languageLabel(target)) },
      { role: "user", content: text }
    ]
  };
  // The 5-series are reasoning models; a quickie must not pay for thought.
  // "none" rather than "minimal" — 5.4-nano rejects the latter outright.
  if (model.startsWith("gpt-5")) body.reasoning_effort = "none";
  else body.temperature = 0;

  const started = performance.now();
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store"
  });
  const payload = (await res.json()) as Record<string, any>;
  const ms = performance.now() - started;
  if (!res.ok) throw new Error(`${model}: ${JSON.stringify(payload).slice(0, 300)}`);
  const output = String(payload.choices?.[0]?.message?.content ?? "").trim();
  const price = PRICES[model];
  const usd =
    ((payload.usage?.prompt_tokens ?? 0) * price.in +
      (payload.usage?.completion_tokens ?? 0) * price.out) /
    1_000_000;
  return { output, ms, usd };
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function report(samples: Sample[]): void {
  const engines = [...new Set(samples.map((s) => s.engine))];
  console.log("\n=== latency & cost ===");
  console.log("engine".padEnd(16), "n".padStart(4), "p50 ms".padStart(8), "p95 ms".padStart(8), "  $/request");
  for (const engine of engines) {
    const mine = samples.filter((s) => s.engine === engine);
    const ms = mine.map((s) => s.ms);
    const usd = mine.reduce((a, s) => a + s.usd, 0) / mine.length;
    console.log(
      engine.padEnd(16),
      String(mine.length).padStart(4),
      percentile(ms, 50).toFixed(0).padStart(8),
      percentile(ms, 95).toFixed(0).padStart(8),
      "  $" + usd.toFixed(7)
    );
  }

  for (const pair of PAIRS) {
    const key = pair.join("→");
    console.log(`\n=== ${key} outputs ===`);
    for (const f of FIXTURES) {
      console.log(`\n  [${f.group}] "${f.text}"`);
      for (const engine of engines) {
        const s = samples.find((x) => x.engine === engine && x.pair === key && x.input === f.text);
        console.log(`    ${engine.padEnd(16)} ${s ? s.output : "—"}`);
      }
    }
  }
}

describe("/fast engine bake-off", () => {
  it(
    "measures every candidate on the same fixtures",
    async () => {
      const samples: Sample[] = [];
      const azure = azureCredentials();
      if (!azure) {
        console.log(
          "\n[azure] AZURE_TRANSLATOR_KEY / AZURE_TRANSLATOR_REGION not set — " +
            "skipping the Azure column. See docs/fast-engine.md for the setup steps."
        );
      }

      for (const [source, target] of PAIRS) {
        const key = `${source}→${target}`;
        for (const f of FIXTURES) {
          for (const model of MODELS) {
            const r = await openaiLiteral(model, f.text, source, target);
            samples.push({ engine: model, pair: key, group: f.group, input: f.text, ...r });
          }
          if (azure) {
            const started = performance.now();
            const { translation: output } = await azureTranslatePair(azure, f.text, [source, target], source);
            samples.push({
              engine: "azure",
              pair: key,
              group: f.group,
              input: f.text,
              output,
              ms: performance.now() - started,
              usd: (f.text.length * AZURE_PER_MILLION_CHARS) / 1_000_000
            });
          }
        }
      }

      report(samples);
    },
    10 * 60 * 1000
  );
});
