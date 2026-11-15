// /tabletop live: a turn "holds its breath" and then the translation never
// arrives (Tom + Liz, 2026-11-15). lib/tabletop/turnFlush.ts is the fix; this
// file drives it with a SCRIPTED PROVIDER — a fake realtime session that does
// what the real one was measured doing (tests/live-fire/tabletop-flush.measure.ts):
//
//   - commits a segment only when VAD hears a pause;
//   - with a context cap, hands a response NO AUDIO once its segment has
//     outgrown the cap, and writes something anyway;
//   - accepts a manual commit while server_vad is on, and does not answer it;
//   - refuses a manual commit of an empty buffer.
//
// The "before" columns run the same script through the logic main shipped
// until this PR (mute, 900 ms, flat 8 s for whatever was in flight), kept here
// as a small reference so the lost-turn count is a number rather than a claim.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTurnFlush,
  DRAIN_HARD_CAP_MS,
  DRAIN_NO_PROGRESS_MS,
  ENDTURN_VAD_GRACE_MS,
  type TurnDrain
} from "@/lib/tabletop/turnFlush";
import {
  buildTabletopSession,
  tabletopMaxSegmentMs,
  tabletopVadProfile,
  TABLETOP_VAD_PROFILES
} from "@/lib/tabletop/session";
import { buildTurnInstructions, withContinuation } from "@/lib/tabletop/instructions";
import {
  emptyTally,
  noteDrain,
  parseSummary,
  summarize,
  tabletopLogLine,
  type TabletopSessionTally
} from "@/lib/tabletop/metrics";
import { copyFor } from "@/lib/chrome/copy";

type Ev = Record<string, unknown>;

/**
 * The scripted provider. Time is vitest's fake clock. `speak(ms)` is a voice
 * with no pause in it; `pause()` is one long enough for VAD; `capMs` is the
 * longest segment the session can still read (the measured cliff).
 */
function fakeProvider(opts: {
  /** VAD never hears the end of the voice (no silence reaches it). */
  vadNeverStops?: boolean;
  /** VAD never hears a voice at all. */
  vadDeaf?: boolean;
  /** Segments longer than this reach the model with no audio. */
  capMs?: number;
  /** How long a response takes to write, ms. */
  respondMs?: number;
  /** A response that starts and then goes quiet forever. */
  stall?: boolean;
}) {
  const capMs = opts.capMs ?? 6500;
  const respondMs = opts.respondMs ?? 400;
  let deliver: (ev: Ev) => void = () => {};
  let bufferStart: number | null = null; // when the uncommitted voice began
  let voiceEnd: number | null = null;
  let nextId = 1;
  const sent: Ev[] = [];
  const log: string[] = [];

  const respond = (segmentMs: number, words: string) => {
    const id = `resp_${nextId++}`;
    const fed = segmentMs <= capMs;
    deliver({ type: "response.created", response: { id } });
    if (opts.stall) {
      deliver({ type: "response.output_text.delta", response_id: id, delta: "half a" });
      return;
    }
    setTimeout(() => {
      // Handed no audio, the real model wrote something anyway.
      deliver({ type: "response.output_text.delta", response_id: id, delta: fed ? words : "INVENTED" });
      deliver({
        type: "response.done",
        response: {
          id,
          status: "completed",
          usage: { input_token_details: { audio_tokens: fed ? Math.round(segmentMs / 100) : 0 } }
        }
      });
    }, respondMs);
  };

  const commit = (byVad: boolean, words: string) => {
    const startedAt = bufferStart;
    if (startedAt === null) {
      if (!byVad) {
        deliver({
          type: "error",
          error: { code: "input_audio_buffer_commit_empty", message: "buffer too small" }
        });
      }
      return;
    }
    const end = voiceEnd ?? Date.now();
    const segmentMs = Math.max(0, end - startedAt);
    // A manual commit leaves VAD mid-"speech": whatever follows — more voice,
    // or only the pause — is a segment of its own that VAD will close and
    // answer. Measured: a pause-only remainder got "Understood. I'll keep the
    // translation going."
    const wasWordless = wordless;
    wordless = !byVad && voiceEnd !== null;
    bufferStart = byVad ? null : Date.now();
    if (wasWordless) words = "CHATTER";
    log.push(`${byVad ? "vad" : "manual"}:${segmentMs}`);
    // `create_response: true` answers VAD's commits. A manual one is the
    // client's to ask for — and it may ask the instant it hears `committed`.
    if (!byVad) pendingManual = { segmentMs, words };
    deliver({ type: "input_audio_buffer.committed", item_id: `item_${nextId}` });
    if (byVad) respond(segmentMs, words);
  };
  let pendingManual: { segmentMs: number; words: string } | null = null;
  let wordless = false;
  let part = 0;

  return {
    sent,
    log,
    attach(fn: (ev: Ev) => void) {
      deliver = fn;
    },
    send(ev: Ev) {
      sent.push(ev);
      if (ev.type === "input_audio_buffer.commit") commit(false, `part${++part}`);
      if (ev.type === "response.create" && pendingManual) {
        const p = pendingManual;
        pendingManual = null;
        respond(p.segmentMs, p.words);
      }
    },
    /** A voice starts; VAD says so unless it is deaf. */
    startVoice() {
      if (opts.vadDeaf) return;
      bufferStart = Date.now();
      voiceEnd = null;
      deliver({ type: "input_audio_buffer.speech_started" });
    },
    /** The voice stops; 550 ms later VAD closes the segment — if it can hear the silence. */
    stopVoice() {
      if (opts.vadDeaf || bufferStart === null) return;
      voiceEnd = Date.now();
      if (opts.vadNeverStops) return;
      setTimeout(() => {
        deliver({ type: "input_audio_buffer.speech_stopped" });
        commit(true, `part${++part}`);
      }, 550);
    }
  };
}

/** live.ts's half: assemble the turn's text from what the controller lets through. */
function harness(provider: ReturnType<typeof fakeProvider>, maxSegmentMs: number | null) {
  let segments: { id: string | null; text: string }[] = [];
  const errors: string[] = [];
  const flush = createTurnFlush({ send: (ev) => provider.send(ev), maxSegmentMs });
  provider.attach((ev) => {
    const v = flush.handle(ev);
    if (ev.type === "response.created" && v.forTurn) segments.push({ id: v.responseId, text: "" });
    if (ev.type === "response.output_text.delta" && v.forTurn) {
      const seg = segments.find((s) => s.id === v.responseId);
      if (seg) seg.text += String(ev.delta);
    }
    if (ev.type === "response.done" && v.forTurn && v.dropped) {
      segments = segments.filter((s) => s.id !== v.responseId);
    }
    if (ev.type === "error" && !v.swallow) errors.push(String((ev.error as { code?: string }).code));
  });
  return {
    flush,
    errors,
    text: () => segments.map((s) => s.text).filter(Boolean).join(" "),
    begin() {
      segments = [];
      flush.beginTurn();
    }
  };
}

/**
 * What main did until this PR, on the same provider: no cuts, no flush, wait
 * 900 ms, then at most a flat 8 s for whatever was already in flight, and
 * keep every word of every response — fed audio or not.
 */
function legacy(provider: ReturnType<typeof fakeProvider>) {
  let active = 0;
  let text: string[] = [];
  let invented = false;
  provider.attach((ev) => {
    if (ev.type === "response.created") active += 1;
    if (ev.type === "response.output_text.delta") {
      text.push(String(ev.delta));
      if (ev.delta === "INVENTED") invented = true;
    }
    if (ev.type === "response.done") active -= 1;
  });
  return {
    begin() {
      text = [];
      invented = false;
    },
    async endTurn() {
      await vi.advanceTimersByTimeAsync(900);
      if (active > 0) {
        for (let waited = 0; waited < 8000 && active > 0; waited += 50) await vi.advanceTimersByTimeAsync(50);
      }
      return { text: text.join(" "), invented };
    }
  };
}

async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  void p.then(() => (done = true));
  for (let i = 0; i < 2000 && !done; i++) await vi.advanceTimersByTimeAsync(50);
  return p;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// The four ways a turn was being lost, as scripts. Each returns whether the
// listener got the real words.
type Script = (p: ReturnType<typeof fakeProvider>) => Promise<void>;
const SCRIPTS: { name: string; provider: Parameters<typeof fakeProvider>[0]; say: Script }[] = [
  {
    name: "20 s said straight through, no pause (the held breath)",
    provider: {},
    say: async (p) => {
      p.startVoice();
      await vi.advanceTimersByTimeAsync(20_000);
      p.stopVoice();
    }
  },
  {
    name: "9 s said straight through",
    provider: {},
    say: async (p) => {
      p.startVoice();
      await vi.advanceTimersByTimeAsync(9000);
      p.stopVoice();
    }
  },
  {
    name: "VAD never hears the voice stop (never commits)",
    provider: { vadNeverStops: true },
    say: async (p) => {
      p.startVoice();
      await vi.advanceTimersByTimeAsync(4000);
      p.stopVoice();
    }
  },
  {
    name: "the last phrase's response starts after the 900 ms grace",
    provider: { respondMs: 3000 },
    say: async (p) => {
      p.startVoice();
      await vi.advanceTimersByTimeAsync(3000);
      // The button lands while the voice is still going: VAD's close, and
      // the response it creates, are still in the air when the grace ends.
      p.stopVoice();
    }
  }
];

describe("before / after: turns lost on the scripted provider", () => {
  it("BEFORE (main's end-of-turn): three of the four lose the turn, one of them to an invention", async () => {
    let lost = 0;
    let inventions = 0;
    for (const sc of SCRIPTS) {
      const p = fakeProvider(sc.provider);
      const old = legacy(p);
      old.begin();
      await sc.say(p);
      const r = await old.endTurn();
      const got = r.text.includes("part") && !r.invented;
      if (!got) lost += 1;
      if (r.invented) inventions += 1;
    }
    // 20 s and 9 s: the segment outgrew the cap, the model was handed nothing
    // and made a sentence up. Never-commits: nothing was ever in flight.
    // (The late response is caught by the old 8 s wait once it has started.)
    expect(lost).toBe(3);
    expect(inventions).toBe(2);
  });

  it("AFTER (turnFlush): none are lost, and nothing invented reaches the pane", async () => {
    let lost = 0;
    const outcomes: string[] = [];
    for (const sc of SCRIPTS) {
      const p = fakeProvider(sc.provider);
      const h = harness(p, tabletopMaxSegmentMs(100, undefined));
      h.begin();
      await sc.say(p);
      const drain = await settle(h.flush.endTurn());
      outcomes.push(drain.outcome);
      if (!h.text().includes("part") || h.text().includes("INVENTED")) lost += 1;
      expect(h.errors).toEqual([]);
      expect(drain.droppedSegments).toBe(0);
    }
    expect(lost).toBe(0);
    expect(outcomes).toEqual(["ok", "ok", "flushed", "ok"]);
  });
});

describe("the segment budget: nothing grows too big to be read", () => {
  it("cuts a long unbroken voice every maxSegmentMs and asks for each response itself", async () => {
    const p = fakeProvider({});
    const h = harness(p, 5500);
    h.begin();
    p.startVoice();
    await vi.advanceTimersByTimeAsync(20_000);
    p.stopVoice();
    const drain = await settle(h.flush.endTurn());
    // 5.5 + 5.5 + 5.5 by hand, the last 3.5 s closed by VAD's own pause.
    expect(p.log).toEqual(["manual:5500", "manual:5500", "manual:5500", "vad:3500"]);
    expect(p.sent.filter((e) => e.type === "input_audio_buffer.commit")).toHaveLength(3);
    expect(p.sent.filter((e) => e.type === "response.create")).toHaveLength(3);
    expect(drain).toMatchObject({ outcome: "ok", committedSegments: 4, forcedCommits: 3, droppedSegments: 0 });
    expect(h.text()).toBe("part1 part2 part3 part4");
  });

  it("leaves a voice that pauses by itself alone", async () => {
    const p = fakeProvider({});
    const h = harness(p, 5500);
    h.begin();
    for (let i = 0; i < 3; i++) {
      p.startVoice();
      await vi.advanceTimersByTimeAsync(3000);
      p.stopVoice();
      await vi.advanceTimersByTimeAsync(1200);
    }
    const drain = await settle(h.flush.endTurn());
    expect(p.sent).toEqual([]);
    expect(drain).toMatchObject({ outcome: "ok", committedSegments: 3, forcedCommits: 0 });
  });

  it("no context cap → no budget → never cuts", async () => {
    expect(tabletopMaxSegmentMs(null, undefined)).toBeNull();
    const p = fakeProvider({ capMs: Infinity });
    const h = harness(p, null);
    h.begin();
    p.startVoice();
    await vi.advanceTimersByTimeAsync(30_000);
    p.stopVoice();
    await settle(h.flush.endTurn());
    expect(p.sent).toEqual([]);
    expect(p.log).toEqual(["vad:30000"]);
  });

  it("the budget follows the cap, sits under the measured cliff, and can be overridden", () => {
    // Measured at cap 100: 68 audio tokens read, 76 not. 5.5 s ≈ 56–58.
    expect(tabletopMaxSegmentMs(100, undefined)).toBe(5500);
    expect(tabletopMaxSegmentMs(400, undefined)).toBe(22_000);
    expect(tabletopMaxSegmentMs(100, "off")).toBeNull();
    expect(tabletopMaxSegmentMs(100, "4000")).toBe(4000);
    // Junk and dangerous smallness fall back to the cap's own.
    expect(tabletopMaxSegmentMs(100, "soon")).toBe(5500);
    expect(tabletopMaxSegmentMs(100, "200")).toBe(5500);
  });

  it("a cut that lands just as the speaker stops: the wordless remainder is cancelled, never shown", async () => {
    const p = fakeProvider({});
    const h = harness(p, 5500);
    h.begin();
    p.startVoice();
    // The voice really ends at 5.3 s; VAD would say so at 5.85 s. The budget
    // cuts at 5.5 s, in between — and takes every word with it.
    await vi.advanceTimersByTimeAsync(5300);
    p.stopVoice();
    await vi.advanceTimersByTimeAsync(400);
    const drain = await settle(h.flush.endTurn());
    expect(p.sent.filter((e) => e.type === "response.cancel")).toHaveLength(1);
    expect(h.text()).toBe("part1");
    expect(h.text()).not.toContain("CHATTER");
    expect(drain.committedSegments).toBe(1);
  });
});

describe("the end-of-turn flush", () => {
  it("a voice VAD never closed is committed and asked for by hand — after the grace, not before", async () => {
    const p = fakeProvider({ vadNeverStops: true });
    const h = harness(p, 5500);
    h.begin();
    p.startVoice();
    await vi.advanceTimersByTimeAsync(3000);
    p.stopVoice();
    const ending = h.flush.endTurn();
    await vi.advanceTimersByTimeAsync(ENDTURN_VAD_GRACE_MS - 50);
    expect(p.sent).toEqual([]);
    const drain = await settle(ending);
    expect(p.sent.map((e) => e.type)).toEqual(["input_audio_buffer.commit", "response.create"]);
    expect(drain.outcome).toBe("flushed");
    expect(h.text()).toBe("part1");
  });

  it("a committed segment the server never answered gets its response asked for", async () => {
    // `interrupt_response: false` "may fail to create a response if the model
    // is already responding" — the commit arrives, the response never does.
    const sent: Ev[] = [];
    const flush = createTurnFlush({ send: (ev) => sent.push(ev), maxSegmentMs: null });
    flush.beginTurn();
    flush.handle({ type: "input_audio_buffer.speech_started" });
    flush.handle({ type: "input_audio_buffer.speech_stopped" });
    flush.handle({ type: "input_audio_buffer.committed" });
    const ending = flush.endTurn();
    await vi.advanceTimersByTimeAsync(ENDTURN_VAD_GRACE_MS + 100);
    expect(sent.map((e) => e.type)).toEqual(["response.create"]);
    flush.handle({ type: "response.created", response: { id: "r1" } });
    flush.handle({ type: "response.done", response: { id: "r1", status: "completed" } });
    expect((await settle(ending)).outcome).toBe("flushed");
  });

  it("a turn VAD heard nothing in cannot be flushed — it is counted, and says so", async () => {
    // Server VAD does not keep audio it has not called speech: a manual
    // commit finds "0.00ms of audio". There is nothing to bring back.
    const p = fakeProvider({ vadDeaf: true });
    const h = harness(p, 5500);
    h.begin();
    p.startVoice();
    await vi.advanceTimersByTimeAsync(4000);
    p.stopVoice();
    const drain = await settle(h.flush.endTurn());
    expect(p.sent).toEqual([]);
    expect(drain).toMatchObject({ outcome: "ok", committedSegments: 0, silent: true });
    expect(drain.ms).toBeLessThan(ENDTURN_VAD_GRACE_MS + 100);
  });

  it("a tap and an immediate second tap is not a 'silent' turn", async () => {
    const p = fakeProvider({ vadDeaf: true });
    const h = harness(p, 5500);
    h.begin();
    await vi.advanceTimersByTimeAsync(400);
    expect((await settle(h.flush.endTurn())).silent).toBe(false);
  });

  it("its own commit hitting an empty buffer is swallowed; a real error is not", () => {
    const sent: Ev[] = [];
    const flush = createTurnFlush({ send: (ev) => sent.push(ev), maxSegmentMs: 1000 });
    flush.beginTurn();
    flush.handle({ type: "input_audio_buffer.speech_started" });
    vi.advanceTimersByTime(1000);
    expect(sent.map((e) => e.type)).toEqual(["input_audio_buffer.commit"]);
    expect(
      flush.handle({ type: "error", error: { code: "input_audio_buffer_commit_empty" } }).swallow
    ).toBe(true);
    // Not ours: the same code with no commit of ours outstanding, and others.
    expect(
      flush.handle({ type: "error", error: { code: "input_audio_buffer_commit_empty" } }).swallow
    ).toBe(false);
    expect(flush.handle({ type: "error", error: { code: "rate_limit_exceeded" } }).swallow).toBe(false);
  });
});

describe("the progress-aware drain", () => {
  /** A response that keeps writing a word every `everyMs` for `totalMs`. */
  async function slowTurn(everyMs: number, totalMs: number): Promise<{ drain: TurnDrain; sent: Ev[] }> {
    const sent: Ev[] = [];
    const flush = createTurnFlush({ send: (ev) => sent.push(ev), maxSegmentMs: null });
    flush.beginTurn();
    flush.handle({ type: "input_audio_buffer.speech_started" });
    flush.handle({ type: "input_audio_buffer.speech_stopped" });
    flush.handle({ type: "input_audio_buffer.committed" });
    flush.handle({ type: "response.created", response: { id: "r1" } });
    const ending = flush.endTurn();
    let done = false;
    void ending.then(() => (done = true));
    for (let t = 0; t < totalMs && !done; t += everyMs) {
      await vi.advanceTimersByTimeAsync(everyMs);
      flush.handle({ type: "response.output_text.delta", response_id: "r1", delta: "word " });
    }
    if (!done && totalMs < DRAIN_HARD_CAP_MS) {
      flush.handle({ type: "response.done", response: { id: "r1", status: "completed" } });
    }
    return { drain: await settle(ending), sent };
  }

  it("a response still writing after 8 s is waited for (main gave up at 8 s flat)", async () => {
    const { drain } = await slowTurn(1000, 20_000);
    expect(drain.outcome).toBe("ok");
    expect(drain.ms).toBeGreaterThan(19_000);
  });

  it("6 s with NOTHING arriving is a timeout — and the stuck response is cancelled", async () => {
    const sent: Ev[] = [];
    const flush = createTurnFlush({ send: (ev) => sent.push(ev), maxSegmentMs: null });
    flush.beginTurn();
    flush.handle({ type: "input_audio_buffer.speech_started" });
    flush.handle({ type: "input_audio_buffer.speech_stopped" });
    flush.handle({ type: "input_audio_buffer.committed" });
    flush.handle({ type: "response.created", response: { id: "r1" } });
    const drain = await settle(flush.endTurn());
    expect(drain.outcome).toBe("timeout");
    expect(drain.ms).toBeGreaterThanOrEqual(DRAIN_NO_PROGRESS_MS);
    expect(drain.ms).toBeLessThan(DRAIN_NO_PROGRESS_MS + 200);
    expect(sent).toEqual([{ type: "response.cancel", response_id: "r1" }]);
  });

  it("however alive it looks, 45 s is the end", async () => {
    const { drain } = await slowTurn(1000, 60_000);
    expect(drain.outcome).toBe("timeout");
    expect(drain.ms).toBeGreaterThanOrEqual(DRAIN_HARD_CAP_MS);
    expect(drain.ms).toBeLessThan(DRAIN_HARD_CAP_MS + 1200);
  });

  it("the numbers Tom asked for: 6 s of no progress, 45 s hard cap, 900 ms grace", () => {
    expect(DRAIN_NO_PROGRESS_MS).toBe(6000);
    expect(DRAIN_HARD_CAP_MS).toBe(45_000);
    expect(ENDTURN_VAD_GRACE_MS).toBe(900);
  });
});

describe("salvage: a timed-out turn keeps what arrived, and never bleeds into the next", () => {
  it("the stalled half-sentence is returned; what it writes afterwards belongs to nobody", async () => {
    const p = fakeProvider({ stall: true });
    const h = harness(p, 5500);
    h.begin();
    p.startVoice();
    await vi.advanceTimersByTimeAsync(2000);
    p.stopVoice();
    const drain = await settle(h.flush.endTurn());
    expect(drain.outcome).toBe("timeout");
    expect(h.text()).toBe("half a");
    // The abandoned response wakes up after the turn is over.
    const late = h.flush.handle({ type: "response.output_text.delta", response_id: "resp_1", delta: " ghost" });
    expect(late.forTurn).toBe(false);
    // …and in the NEXT turn it is still nobody's.
    h.begin();
    expect(
      h.flush.handle({ type: "response.output_text.delta", response_id: "resp_1", delta: " ghost" }).forTurn
    ).toBe(false);
    expect(h.flush.handle({ type: "response.done", response: { id: "resp_1", status: "cancelled" } }).forTurn).toBe(
      false
    );
  });

  it("a response that read no audio is reported dropped; one that was cut short, incomplete", () => {
    const flush = createTurnFlush({ send: () => {}, maxSegmentMs: null });
    flush.beginTurn();
    flush.handle({ type: "response.created", response: { id: "a" } });
    const unread = flush.handle({
      type: "response.done",
      response: { id: "a", status: "completed", usage: { input_token_details: { audio_tokens: 0 } } }
    });
    expect(unread).toMatchObject({ forTurn: true, dropped: true });
    flush.handle({ type: "response.created", response: { id: "b" } });
    const cut = flush.handle({
      type: "response.done",
      response: { id: "b", status: "incomplete", usage: { input_token_details: { audio_tokens: 40 } } }
    });
    expect(cut).toMatchObject({ dropped: false, incomplete: true });
    // No usage at all is not evidence of anything.
    flush.handle({ type: "response.created", response: { id: "c" } });
    expect(flush.handle({ type: "response.done", response: { id: "c", status: "completed" } }).dropped).toBe(false);
  });

  it("live.ts returns the salvage marked, takes the invention out, and keeps the last phrase's transcript", () => {
    const src = readFileSync("lib/tabletop/live.ts", "utf8");
    expect(src).toContain('truncated: lostPart || drain?.outcome === "timeout"');
    expect(src).toContain("if (verdict.dropped) {");
    expect(src).toContain("events.onTranslationReplace?.(assembled());");
    // Anything not for this turn never reaches the pane.
    expect(src.match(/if \(!verdict\?\.forTurn\) return;/g)?.length).toBe(3);
    // The last phrase is transcribed after the mic closes; it is still the turn's.
    expect(src).toMatch(/\.test\(t\) && turnLive\)/);
    // The flat wait is gone.
    expect(src).not.toContain("ENDTURN_DRAIN_TIMEOUT_MS");
  });

  it("the table is told, in both panes and in both languages (ES pendiente de revisión por Liz)", () => {
    const en = copyFor("en");
    const es = copyFor("es");
    for (const key of ["tableFinishing", "tablePartial", "tableNotHeard"] as const) {
      expect(en[key]).toBeTruthy();
      expect(es[key]).toBeTruthy();
      expect(es[key]).not.toBe(en[key]);
    }
    const shell = readFileSync("components/TabletopShell.tsx", "utf8");
    expect(shell.match(/data-tabletop-partial=""/g)?.length).toBe(2);
    expect(shell).toContain("data-tabletop-notice={turnNotice.kind}");
    expect(shell).toContain("t.tableFinishing");
    // The marker is a flag on the exchange, not words appended to the
    // translation — /api/tts reads the translation aloud.
    expect(shell).toContain("...(partial ? { partial: true } : {})");
  });
});

describe("the continuation hint for a segment cut mid-sentence", () => {
  const base = buildTurnInstructions({ source: "es", target: "en" });

  it("adds to the turn's instructions and never replaces them", () => {
    const hinted = withContinuation(base, "We left early for the mountain because we wanted to");
    expect(hinted.startsWith(base)).toBe(true);
    expect(hinted).toContain('ends with: "We left early for the mountain because we wanted to"');
    expect(hinted).toContain("Do not finish a sentence the audio leaves unfinished.");
  });

  it("nothing translated yet → the turn's own instructions, untouched", () => {
    expect(withContinuation(base, "   ")).toBe(base);
  });

  it("only the tail travels", () => {
    const long = "x".repeat(500) + " the very end";
    const hinted = withContinuation(base, long);
    expect(hinted).toContain("the very end");
    expect(hinted.length).toBeLessThan(base.length + 600);
  });

  it("only the FIRST cut of a run is not a continuation", () => {
    const asked: boolean[] = [];
    const sent: Ev[] = [];
    const flush = createTurnFlush({
      send: (ev) => sent.push(ev),
      maxSegmentMs: 1000,
      responseInstructions: (continuing) => {
        asked.push(continuing);
        return continuing ? "HINTED" : undefined;
      }
    });
    flush.beginTurn();
    flush.handle({ type: "input_audio_buffer.speech_started" });
    for (let i = 1; i <= 3; i++) {
      vi.advanceTimersByTime(1000);
      flush.handle({ type: "input_audio_buffer.committed" });
      flush.handle({ type: "response.created", response: { id: `r${i}` } });
      flush.handle({ type: "response.done", response: { id: `r${i}`, status: "completed" } });
    }
    expect(asked).toEqual([false, true, true]);
    expect(sent.filter((e) => e.type === "response.create")).toEqual([
      { type: "response.create" },
      { type: "response.create", response: { instructions: "HINTED" } },
      { type: "response.create", response: { instructions: "HINTED" } }
    ]);
  });
});

describe("TAOS_TABLETOP_VAD", () => {
  const opts = {
    direction: { source: "en", target: "es" },
    model: "gpt-realtime",
    transcribeModel: "gpt-4o-mini-transcribe"
  };
  const vadOf = (s: Record<string, unknown>) =>
    (s as { audio: { input: { turn_detection: Record<string, unknown> } } }).audio.input.turn_detection;

  it("unset, or anything but 'quiet', is party — today's session, byte for byte", () => {
    expect(tabletopVadProfile(undefined)).toBe("party");
    expect(tabletopVadProfile("")).toBe("party");
    expect(tabletopVadProfile("loud")).toBe("party");
    expect(TABLETOP_VAD_PROFILES.party).toEqual({ threshold: 0.6, silence_duration_ms: 550 });
    expect(JSON.stringify(buildTabletopSession({ ...opts, vad: "party" }))).toBe(
      JSON.stringify(buildTabletopSession(opts))
    );
    expect(vadOf(buildTabletopSession(opts))).toMatchObject({ threshold: 0.6, silence_duration_ms: 550 });
  });

  it("quiet lowers the threshold and changes nothing else", () => {
    expect(tabletopVadProfile(" Quiet ")).toBe("quiet");
    const party = buildTabletopSession(opts);
    const quiet = buildTabletopSession({ ...opts, vad: "quiet" });
    expect(vadOf(quiet).threshold).toBe(0.4);
    vadOf(quiet).threshold = 0.6;
    expect(JSON.stringify(quiet)).toBe(JSON.stringify(party));
  });

  it("the mint route reads it server-side, tells the client, and logs it", () => {
    const route = readFileSync("app/api/tabletop/realtime/route.ts", "utf8");
    expect(route).toContain("const vad = tabletopVadProfile();");
    expect(route).toContain("const maxSegmentMs = tabletopMaxSegmentMs();");
    expect(route).toContain("vadProfile: vad,");
    expect(route).toContain("vad_profile=${vad} max_segment_ms=${maxSegmentMs ?? \"off\"}");
    const env = readFileSync(".env.example", "utf8");
    expect(env).toContain("TAOS_TABLETOP_VAD");
    expect(env).toContain("TAOS_TABLETOP_MAX_SEGMENT_MS");
  });
});

describe("[taos-tabletop] gains the flush fields, keeps every field before them", () => {
  const drain = (over: Partial<TurnDrain>): TurnDrain => ({
    ms: 1000,
    outcome: "ok",
    committedSegments: 2,
    forcedCommits: 0,
    droppedSegments: 0,
    silent: false,
    ...over
  });

  it("drain_ms is the session's longest, drain_outcome its worst", () => {
    let t: TabletopSessionTally = { ...emptyTally("openai", 0), vadProfile: "party" };
    t = noteDrain(t, drain({}));
    t = noteDrain(t, drain({ ms: 7200, outcome: "flushed", forcedCommits: 3, committedSegments: 4 }));
    t = noteDrain(t, drain({ ms: 950, committedSegments: 0, silent: true }));
    const line = tabletopLogLine(summarize(t, 60_000));
    expect(line).toMatch(
      / forced_turns=0 committed_segments=6 drain_ms=7200 drain_outcome=flushed vad_profile=party turns=3 flushed_turns=1 timeout_turns=0 forced_commits=3 dropped_segments=0 silent_turns=1$/
    );
    t = noteDrain(t, drain({ ms: 6050, outcome: "timeout", droppedSegments: 1 }));
    expect(tabletopLogLine(summarize(t, 60_000))).toContain("drain_outcome=timeout");
    expect(tabletopLogLine(summarize(t, 60_000))).toContain("timeout_turns=1 forced_commits=3 dropped_segments=1");
  });

  it("the two word-valued fields are enums — text still cannot reach the log", () => {
    const good = summarize({ ...emptyTally("openai", 0), vadProfile: "quiet" }, 60_000);
    expect(parseSummary(good)).toEqual(good);
    expect(parseSummary({ ...good, vad_profile: "hola, ¿qué tal?" })).toBeNull();
    expect(parseSummary({ ...good, drain_outcome: "she said yes" })).toBeNull();
    expect(parseSummary({ ...good, drain_ms: "long" })).toBeNull();
  });

  it("a phone on the previous build (no flush fields) still logs, as zeros", () => {
    const s = summarize(emptyTally("gemini", 0), 60_000);
    const old: Record<string, unknown> = { ...s };
    for (const k of [
      "committed_segments",
      "drain_ms",
      "drain_outcome",
      "vad_profile",
      "turns",
      "flushed_turns",
      "timeout_turns",
      "forced_commits",
      "dropped_segments",
      "silent_turns"
    ]) {
      delete old[k];
    }
    expect(parseSummary(old)).toEqual(s);
  });
});
