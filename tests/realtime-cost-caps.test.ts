// The cost guard on every public realtime surface, proved against the real
// mint routes.
//
// The lesson this file is built on is the one from 2026-08-27 (see
// tests/tutor-crawl.test.ts and the memory that came out of it): **reaching a
// provider is not the same as a value arriving.** Tutor scoring round-tripped
// to Azure for a month, green the whole time, and delivered no score — because
// the test asserted that the call happened rather than that the number showed
// up. So nothing here checks that the route returned 200. Every assertion
// below reads the JSON BODY that was about to be sent to OpenAI and looks for
// the cap inside it.
//
// What the cap is worth, measured against live sessions on 2026-08-28
// (docs/realtime-cost-model.md, and the harness that produced it is in
// tests/live-fire/):
//
//   /live      uncapped 460% of spoken audio, climbing 51→180→267→326→398→447
//              at 150     110%, flat  51→63→76→65→66→78
//   /tabletop  uncapped 440% of spoken audio, climbing 39→85→…→270
//
// "Climbing" is the finding. A capped session's cost is linear in what people
// say; an uncapped one is quadratic in how long they stay, and /live is the
// screen a customer leaves running through an entire dinner.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildLiveSession, LIVE_CONTEXT_TOKEN_LIMIT } from "@/lib/live/session";
import {
  buildTabletopSession,
  TABLETOP_CONTEXT_TOKEN_LIMIT
} from "@/lib/tabletop/session";
import { contextTokenLimitFromEnv, truncationCap } from "@/lib/realtime/truncation";

let caller: { id: string; email: string } | null = null;

vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async (req: Request) => {
    const header = req.headers.get("authorization") ?? "";
    return header.startsWith("Bearer ") && caller ? caller : null;
  }
}));

/** Stands in for OpenAI, and keeps the body it was handed. */
const fetchSpy = vi.fn(
  async (_input: unknown, _init?: unknown) =>
    new Response(JSON.stringify({ value: "ek_test_secret" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })
);

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_KEY = process.env.OPENAI_API_KEY;

beforeEach(() => {
  caller = { id: "u1", email: "someone@example.com" };
  fetchSpy.mockClear();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  process.env.OPENAI_API_KEY = "sk-test";
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_KEY;
});

function signedInRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { authorization: "Bearer token", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

/** The JSON actually posted to OpenAI — the only thing worth asserting on. */
function mintedPayload(): {
  session: {
    truncation?: { type: string; retention_ratio: number; token_limits: { post_instructions: number } };
    output_modalities?: string[];
    audio?: { input?: Record<string, unknown> };
    instructions?: string;
  };
  expires_after?: { anchor: string; seconds: number };
} {
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const init = fetchSpy.mock.calls[0][1] as { body?: string };
  return JSON.parse(String(init.body));
}

function repoFile(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");
}

describe("the cap reaches OpenAI, not just the builder", () => {
  it("/live mints a session carrying its context cap", async () => {
    const { POST } = await import("@/app/api/live/realtime/route");
    await POST(signedInRequest("http://localhost/api/live/realtime", { target: "en", source: "es" }));

    const { session } = mintedPayload();
    expect(session.truncation).toEqual({
      type: "retention_ratio",
      retention_ratio: 0.8,
      token_limits: { post_instructions: 150 }
    });
  });

  it("/tabletop mints a session carrying its context cap", async () => {
    const { POST } = await import("@/app/api/tabletop/realtime/route");
    await POST(
      signedInRequest("http://localhost/api/tabletop/realtime", { source: "en", target: "es" })
    );

    const { session } = mintedPayload();
    expect(session.truncation).toEqual({
      type: "retention_ratio",
      retention_ratio: 0.8,
      token_limits: { post_instructions: 100 }
    });
  });

  it("expires a minted secret on both surfaces, the way /call does", async () => {
    // A client secret is a spendable, billing session. /call has capped its
    // life since it shipped; /live and /tabletop minted immortal ones until
    // 2026-08-28, so one lifted from a log or a proxy stayed usable.
    const live = await import("@/app/api/live/realtime/route");
    await live.POST(signedInRequest("http://localhost/api/live/realtime", {}));
    expect(mintedPayload().expires_after).toEqual({ anchor: "created_at", seconds: 120 });

    fetchSpy.mockClear();
    const table = await import("@/app/api/tabletop/realtime/route");
    await table.POST(signedInRequest("http://localhost/api/tabletop/realtime", {}));
    expect(mintedPayload().expires_after).toEqual({ anchor: "created_at", seconds: 120 });
  });
});

describe("the caps themselves, and why they differ", () => {
  it("gives /live more room than /call, and /tabletop the least", () => {
    // Not arbitrary, and not copied. /live COALESCES — everything said while
    // the last summary was playing folds into the next one — so a busy table
    // can have several committed segments waiting when a response fires.
    // Measured: at 100 the third summary came back a verbatim repeat of the
    // second, having lost the audio it was supposed to be summarising. At 150
    // all six were right. /tabletop answers one phrase per response and keeps
    // no thread at all, so it needs the least.
    expect(LIVE_CONTEXT_TOKEN_LIMIT).toBe(150);
    expect(TABLETOP_CONTEXT_TOKEN_LIMIT).toBe(100);
    expect(LIVE_CONTEXT_TOKEN_LIMIT!).toBeGreaterThan(TABLETOP_CONTEXT_TOKEN_LIMIT!);
  });

  it("refuses a cap below one VAD segment", () => {
    // Audio bills at 1 token per 100ms, so 50 tokens is five seconds — about
    // one phrase. Below that the model starts answering a fragment of the
    // sentence it is meant to be translating: a quality cliff, not a saving.
    expect(contextTokenLimitFromEnv("10", 150)).toBe(150);
    expect(contextTokenLimitFromEnv("49", 150)).toBe(150);
    expect(contextTokenLimitFromEnv("50", 150)).toBe(50);
    expect(contextTokenLimitFromEnv("garbage", 150)).toBe(150);
    expect(contextTokenLimitFromEnv(undefined, 150)).toBe(150);
  });

  it("makes 'no cap at all' something you have to ask for by name", () => {
    // Uncapped is the expensive setting — 460% of spoken audio and climbing.
    // It must never be reachable by fat-fingering a number into an env var.
    expect(contextTokenLimitFromEnv("off", 150)).toBeNull();
    expect(contextTokenLimitFromEnv("0", 150)).toBe(150);
  });

  it("keeps the instructions out of the truncated region", () => {
    // post_instructions counts AFTER the prompt. The prompt is what stops the
    // interpreter drifting into the source language (the 7/8 field test) and
    // must never be what gets dropped to save money.
    expect(truncationCap(150).token_limits.post_instructions).toBe(150);
    expect(truncationCap(150).type).toBe("retention_ratio");
  });
});

describe("what the cap must NOT have changed", () => {
  it("leaves /live speaking and /tabletop writing", () => {
    const live = buildLiveSession({
      target: "en",
      source: "es",
      model: "gpt-realtime",
      voice: "marin",
      transcribeModel: "gpt-4o-mini-transcribe"
    });
    const table = buildTabletopSession({
      direction: { source: "en", target: "es" },
      model: "gpt-realtime",
      transcribeModel: "gpt-4o-mini-transcribe"
    });
    // /live is a voice in an earpiece; it has no cheap text mode to fall back
    // to the way /call does, and taking its voice away to save money would be
    // deleting the feature rather than capping it.
    expect(live.output_modalities).toEqual(["audio"]);
    expect(table.output_modalities).toEqual(["text"]);
  });

  it("keeps ambient mode's ears open to the far side of the room", () => {
    const live = buildLiveSession({
      target: "en",
      source: "es",
      model: "gpt-realtime",
      voice: "marin",
      transcribeModel: "gpt-4o-mini-transcribe"
    }) as { audio: { input: Record<string, unknown> } };
    // near_field would be a saving — fewer committed segments — and it would
    // gut the feature. /live's whole job is the dinner table two seats away,
    // which is exactly what near-field filtering removes. /call and /tabletop
    // are the opposite case (one voice, close to the phone) and do use it.
    expect(live.audio.input.noise_reduction).toBeUndefined();

    const table = buildTabletopSession({
      direction: { source: "en", target: "es" },
      model: "gpt-realtime",
      transcribeModel: "gpt-4o-mini-transcribe"
    }) as { audio: { input: Record<string, unknown> } };
    expect(table.audio.input.noise_reduction).toEqual({ type: "near_field" });
  });

  it("leaves the client owning /live's responses and the server owning the table's", () => {
    const live = buildLiveSession({
      target: "en",
      source: "es",
      model: "gpt-realtime",
      voice: "marin",
      transcribeModel: "gpt-4o-mini-transcribe"
    }) as { audio: { input: { turn_detection: Record<string, unknown> } } };
    const table = buildTabletopSession({
      direction: { source: "en", target: "es" },
      model: "gpt-realtime",
      transcribeModel: "gpt-4o-mini-transcribe"
    }) as { audio: { input: { turn_detection: Record<string, unknown> } } };
    // Audio responses overlap if the server fires them per VAD pause (the
    // reason lib/live/ambient.ts gates them); text responses cannot.
    expect(live.audio.input.turn_detection.create_response).toBe(false);
    expect(table.audio.input.turn_detection.create_response).toBe(true);
  });
});

describe("session guards, on the surfaces customers can reach", () => {
  it("gives every realtime surface an idle timeout AND a hard ceiling", () => {
    const ambient = repoFile("lib/live/ambient.ts");
    const table = repoFile("lib/tabletop/live.ts");
    const call = repoFile("lib/call/interpreter.ts");

    // /live: five quiet minutes, two hours hard.
    expect(ambient).toContain("const DEFAULT_IDLE_MS = 5 * 60 * 1000");
    expect(ambient).toContain("const DEFAULT_MAX_MS = 2 * 60 * 60 * 1000");
    // /tabletop had NO hard ceiling until 2026-08-28. The idle disconnect
    // bounds a forgotten table; nothing bounded one that keeps being tapped.
    expect(table).toContain("const IDLE_DISCONNECT_MS = 5 * 60 * 1000");
    expect(table).toContain("const MAX_SESSION_MS = 2 * 60 * 60 * 1000");
    // /call, unchanged, as the surface the other two were made consistent with.
    expect(call).toContain("const DEFAULT_IDLE_MS = 2 * 60 * 1000");
    expect(call).toContain("const DEFAULT_MAX_MS = 60 * 60 * 1000");
  });

  it("warns before it stops, rather than explaining afterwards", () => {
    // /live used to go quiet mid-dinner and put up a message about it after
    // the fact. It is the surface that runs for two hours; it is the one that
    // most needs telling.
    const ambient = repoFile("lib/live/ambient.ts");
    expect(ambient).toContain("onEndingSoon");
    expect(ambient).toContain("const IDLE_WARNING_MS = 30 * 1000");
    expect(ambient).toContain("const CAP_WARNING_MS = 2 * 60 * 1000");
    // And the screen has to actually render it.
    expect(repoFile("components/LiveShell.tsx")).toContain("onEndingSoon");
  });

  it("never cuts somebody off in the middle of their own sentence", () => {
    // Both auto-stops are turn-aware: a cap or an idle timeout that landed
    // mid-turn waits. A table is a person talking to a person.
    const table = repoFile("lib/tabletop/live.ts");
    expect(table).toContain("if (!turnOpen) stop();");
    expect(table).toContain("if (capReached)");
  });
});

describe("the mint routes use the builders", () => {
  it("does not hand-roll a session object beside the one that is measured", () => {
    // The whole point of lib/live/session.ts and lib/tabletop/session.ts is
    // that the measurement harness drives the SAME object the route mints. A
    // route that starts assembling its own again silently un-measures itself.
    const liveRoute = repoFile("app/api/live/realtime/route.ts");
    const tableRoute = repoFile("app/api/tabletop/realtime/route.ts");
    expect(liveRoute).toContain("buildLiveSession(");
    expect(tableRoute).toContain("buildTabletopSession(");
    expect(liveRoute).not.toContain("turn_detection");
    expect(tableRoute).not.toContain("turn_detection");
  });

  it("logs the cap it minted with, so a regression is greppable in production", () => {
    // A mint line reading context_tokens=off is a session that will cost what
    // /live used to. That is worth being able to see without a redeploy.
    expect(repoFile("app/api/live/realtime/route.ts")).toContain("[taos-live-mint]");
    expect(repoFile("app/api/tabletop/realtime/route.ts")).toContain("[taos-tabletop-mint]");
  });
});
