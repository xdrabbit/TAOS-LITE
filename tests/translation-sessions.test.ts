// Fences for the conversation session stamped on every saved translation.
//
// What is pinned is the one decision that cannot be undone later: the rule
// that decides whether a turn belongs to the conversation before it or starts
// a new one. Rows carry whatever id the client chose at the moment of speaking,
// and nothing downstream can re-decide it — so the boundary is tested on both
// sides, the gap is tested as a number, and the id shape is tested against
// what the `uuid` column will accept.
import { describe, expect, it } from "vitest";
import {
  continueSession,
  formatUuidV4,
  newSessionId,
  SESSION_GAP_MS
} from "@/lib/translate/session";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A mint that hands out predictable ids and counts how often it was asked. */
function counter() {
  let n = 0;
  const mint = () => `id-${++n}`;
  return { mint, calls: () => n };
}

describe("the gap that ends a conversation", () => {
  it("is ten minutes", () => {
    // Reconstructing the existing archive by timestamps at this gap gave
    // 1,089 sessions averaging 6.7 turns across Tom and Liz's history. Change
    // the number and the sessions /study builds lessons from change shape.
    expect(SESSION_GAP_MS).toBe(10 * 60 * 1000);
  });
});

describe("continueSession", () => {
  const T0 = 1_790_000_000_000;

  it("mints on the first turn", () => {
    const { mint, calls } = counter();
    const s = continueSession(null, T0, mint);
    expect(s).toEqual({ id: "id-1", lastTurnAt: T0 });
    expect(calls()).toBe(1);
  });

  it("keeps the id while the turns keep coming, and advances the clock", () => {
    const { mint, calls } = counter();
    const first = continueSession(null, T0, mint);
    const second = continueSession(first, T0 + 30_000, mint);
    const third = continueSession(second, T0 + 90_000, mint);
    expect(second.id).toBe("id-1");
    expect(third.id).toBe("id-1");
    expect(third.lastTurnAt).toBe(T0 + 90_000);
    expect(calls()).toBe(1);
  });

  it("measures the gap from the LAST turn, not the first", () => {
    // A slow dinner: turns every eight minutes for half an hour are one
    // conversation, even though the first and last are far more than ten
    // minutes apart.
    const { mint, calls } = counter();
    let s = continueSession(null, T0, mint);
    for (let i = 1; i <= 4; i += 1) s = continueSession(s, T0 + i * 8 * 60_000, mint);
    expect(s.id).toBe("id-1");
    expect(calls()).toBe(1);
  });

  it("exactly at the gap is still the same conversation", () => {
    const { mint } = counter();
    const first = continueSession(null, T0, mint);
    const edge = continueSession(first, T0 + SESSION_GAP_MS, mint);
    expect(edge.id).toBe("id-1");
  });

  it("one millisecond past the gap starts a new one", () => {
    const { mint, calls } = counter();
    const first = continueSession(null, T0, mint);
    const next = continueSession(first, T0 + SESSION_GAP_MS + 1, mint);
    expect(next.id).toBe("id-2");
    expect(next.lastTurnAt).toBe(T0 + SESSION_GAP_MS + 1);
    expect(calls()).toBe(2);
  });

  it("does not mutate the session it was handed", () => {
    const { mint } = counter();
    const first = continueSession(null, T0, mint);
    const snapshot = { ...first };
    continueSession(first, T0 + 1, mint);
    expect(first).toEqual(snapshot);
  });

  it("uses a real uuid when no mint is supplied", () => {
    const s = continueSession(null, T0);
    expect(s.id).toMatch(UUID_V4);
  });
});

describe("the id the uuid column will accept", () => {
  it("newSessionId is an RFC 4122 v4 uuid", () => {
    expect(newSessionId()).toMatch(UUID_V4);
    expect(newSessionId()).not.toBe(newSessionId());
  });

  it("the no-secure-context fallback produces the same shape", () => {
    // Zeroed bytes make the version and variant nibbles the only thing set,
    // which is exactly what the fallback must get right for Postgres to take
    // the value as a uuid rather than reject the insert.
    const out = formatUuidV4(new Uint8Array(16));
    expect(out).toBe("00000000-0000-4000-8000-000000000000");
    expect(out).toMatch(UUID_V4);
  });

  it("the fallback sets version and variant without touching the rest", () => {
    const bytes = new Uint8Array(16).fill(0xff);
    const out = formatUuidV4(bytes);
    expect(out).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(out).toMatch(UUID_V4);
  });

  it("the fallback refuses fewer than 16 bytes rather than emitting a short id", () => {
    expect(() => formatUuidV4(new Uint8Array(15))).toThrow();
  });
});
