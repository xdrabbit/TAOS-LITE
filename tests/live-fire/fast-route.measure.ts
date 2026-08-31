// /fast, end to end, against the real provider.
//
//   npx vitest run --config vitest.measure.config.ts tests/live-fire/fast-route.measure.ts
//
// Live fire: real OpenAI (and real Azure, when the resource exists). It calls
// the SHIPPED route handler — app/api/fast/route.ts — with only auth mocked,
// the same technique tests/call-gating.test.ts uses, so what is measured here
// is what a phone gets: the gate, the rate limit, the body parsing, the engine
// choice and the provider call, in that order.
//
// Three things it answers that a mocked test cannot:
//   1. what a quickie actually costs in wall-clock milliseconds, per engine;
//   2. whether the literal register survives the round trip in EN→ES and
//      EN→PL, including auto-detect;
//   3. whether a keystroke storm is served and then refused, on a real clock.
import { beforeEach, describe, it, vi } from "vitest";
import { NextRequest } from "next/server";

let caller: { id: string; email: string } | null = { id: "f1", email: "xdrabbit@gmail.com" };

vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async (req: Request) =>
    req.headers.get("authorization")?.startsWith("Bearer ") && caller ? caller : null
}));

function request(body: Record<string, unknown>, token = "t"): NextRequest {
  return new NextRequest("https://taoslite.com/api/fast", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });
}

interface Timed {
  status: number;
  ms: number;
  body: Record<string, unknown>;
}

async function call(body: Record<string, unknown>, token = "t"): Promise<Timed> {
  const { POST } = await import("@/app/api/fast/route");
  const started = performance.now();
  const res = await POST(request(body, token));
  const ms = performance.now() - started;
  return { status: res.status, ms, body: (await res.json()) as Record<string, unknown> };
}

const QUICKIES = [
  "bathroom",
  "where is the train station",
  "how much does this cost",
  "two coffees please",
  "my son is allergic to peanuts",
  "it costs an arm and a leg"
];

beforeEach(async () => {
  caller = { id: "f1", email: "xdrabbit@gmail.com" };
  const { resetFastRateLimits } = await import("@/lib/fast/rateLimit");
  resetFastRateLimits();
});

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

describe("/fast against the real provider", () => {
  it(
    "translates EN→ES and EN→PL quickies, with the clock running",
    async () => {
      for (const [source, target] of [
        ["en", "es"],
        ["en", "pl"]
      ] as const) {
        const times: number[] = [];
        console.log(`\n── ${source} → ${target} ──────────────────────────`);
        for (const text of QUICKIES) {
          const r = await call({ text, sourceLanguage: source, targetLanguage: target });
          times.push(r.ms);
          console.log(
            `  ${String(Math.round(r.ms)).padStart(5)}ms  ${String(r.body.engine).padEnd(7)} ` +
              `"${text}" → ${r.status === 200 ? r.body.translation : JSON.stringify(r.body)}`
          );
        }
        console.log(
          `  p50 ${percentile(times, 50).toFixed(0)}ms   p95 ${percentile(times, 95).toFixed(0)}ms`
        );
      }
    },
    5 * 60 * 1000
  );

  it(
    "detects which side of the pair was typed, in both directions",
    async () => {
      console.log("\n── auto-detect, pair [en, es] ────────────────");
      for (const text of ["where is the bathroom", "dónde está el baño", "gracias"]) {
        const r = await call({
          text,
          sourceLanguage: "en",
          targetLanguage: "es",
          direction: "auto"
        });
        console.log(
          `  "${text}" → detected ${r.body.detectedSource} → ${r.body.targetLanguage}: ` +
            `${r.body.translation}`
        );
      }
    },
    5 * 60 * 1000
  );

  it(
    "serves a keystroke storm and then refuses it, on a real clock",
    async () => {
      // Every prefix of a phrase, as fast as the loop can send them — the
      // worst case the 300ms client debounce is supposed to prevent.
      const typed = "where is the nearest pharmacy that is open right now please thanks";
      let served = 0;
      let refused = 0;
      let spend = 0;
      for (let i = 1; i <= 70 && i <= typed.length; i += 1) {
        const r = await call({
          text: typed.slice(0, i),
          sourceLanguage: "en",
          targetLanguage: "es"
        });
        if (r.status === 200) {
          served += 1;
          spend += 1;
        } else if (r.status === 429) refused += 1;
      }
      console.log(
        `\n── keystroke storm ──────────────────────────\n` +
          `  ${served} served, ${refused} refused (429), ${spend} provider calls paid for\n` +
          `  the cap is 60/minute per account (lib/fast/rateLimit.ts)`
      );
    },
    10 * 60 * 1000
  );

  it("404s a stranger, without reaching the provider", async () => {
    caller = { id: "s1", email: "stranger@example.com" };
    const r = await call({ text: "bathroom", sourceLanguage: "en", targetLanguage: "es" });
    console.log(`\n── stranger ─────────────────────────────────\n  status ${r.status}`);
    if (r.status !== 404) throw new Error(`expected 404, got ${r.status}`);
  });
});
