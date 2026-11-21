// @vitest-environment jsdom
//
// The speaker of Interpreter mode's SOCKET legs (Grok Voice, ElevenLabs
// Realtime, Gemini Live) — lib/interpreter/pcmPlayer.ts — and the
// AudioContext it plays on (lib/tabletop/audio.ts).
//
// Tom and Liz, 2026-11-09 afternoon, after A/B-ing six engines at a table:
// on Grok and on ElevenLabs "the audio degrades into a folding waveform that
// repeats at a rapid rate" — the only two engines they ran on this path.
// These tests pin what that hunt established and what it changed:
//
//   · a frame with an ODD number of bytes never shifts the samples after it
//     (the old player dropped the byte, and the rest of the reply was noise);
//   · whatever arrives — a burst, a trickle, a barge-in storm, held audio
//     released into live audio — every sample is scheduled ONCE, in order,
//     and no two buffers of a leg ever sound at the same time;
//   · a cut leaves nothing scheduled;
//   · a socket session plays on an AudioContext made AFTER its microphone is
//     live, and the diagnostics line says what rate it had and what rate the
//     one it replaced had.
//
// The shapes are the wire's own, measured on 2026-11-09 against ElevenLabs
// (tests/live-fire/interpreter-engines.measure.ts): a reply is ~10 frames of
// 1,518 × n bytes landing in 40–250 ms.

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAudioGate } from "@/lib/interpreter/audioGate";
import { speakerActionFor } from "@/lib/interpreter/halfDuplex";
import {
  createPcmFramer,
  createPcmPlayerOn,
  createPcmSchedule,
  pcmContextRenewalFrom,
  pcmRouteFrom,
  PCM_LEAD_MAX_S,
  PCM_LEAD_S,
  PCM_SAFE_S,
  type PcmContext
} from "@/lib/interpreter/pcmPlayer";
import {
  createSessionTimeline,
  parseTimelineDigest,
  summarizeLegDigest,
  timelineLogLine
} from "@/lib/interpreter/timeline";

const RATE = 24_000;

/** A deterministic PRNG — the storms below must fail the same way twice. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

/** s16le bytes whose samples COUNT UP from `first` — so order and identity are checkable. */
function ramp(first: number, samples: number): Uint8Array {
  const out = new Uint8Array(samples * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples; i++) view.setInt16(i * 2, ((first + i) % 60_000) - 30_000, true);
  return out;
}

function samplesOf(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length - (bytes.length % 2));
  const out: number[] = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) out.push(view.getInt16(i, true));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ── A stand-in AudioContext that records the schedule ──────────────────────

interface Scheduled {
  at: number;
  duration: number;
  samples: number[];
  rate: number;
  stoppedAt: number | null;
  connectedTo: unknown;
}

function fakeContext(sampleRate = 48_000) {
  const scheduled: Scheduled[] = [];
  const state = { currentTime: 0, sampleRate, outputLatency: 0 };
  const ctx: PcmContext = {
    get currentTime() {
      return state.currentTime;
    },
    get sampleRate() {
      return state.sampleRate;
    },
    get outputLatency() {
      return state.outputLatency;
    },
    createBuffer: (_channels, length, rate) => {
      const data = new Float32Array(length);
      return { duration: length / rate, length, sampleRate: rate, getChannelData: () => data } as unknown as AudioBuffer;
    },
    createBufferSource: () => {
      const entry: Scheduled = { at: -1, duration: 0, samples: [], rate: 0, stoppedAt: null, connectedTo: null };
      const node = {
        buffer: null as AudioBuffer | null,
        onended: null as (() => void) | null,
        connect: (to: unknown) => {
          entry.connectedTo = to;
        },
        disconnect: () => {},
        start: (at: number) => {
          const buffer = node.buffer!;
          entry.at = at;
          entry.duration = buffer.duration;
          entry.rate = buffer.sampleRate;
          entry.samples = Array.from(buffer.getChannelData(0), (v) => Math.round(v * 0x8000));
          scheduled.push(entry);
        },
        stop: () => {
          if (entry.stoppedAt === null) entry.stoppedAt = state.currentTime;
        }
      };
      return node as unknown as AudioBufferSourceNode;
    }
  };
  return { ctx, scheduled, state };
}

/** What is audible: every buffer that was not stopped before it started. */
function audible(scheduled: Scheduled[]): Scheduled[] {
  return scheduled.filter((s) => s.stoppedAt === null || s.stoppedAt > s.at);
}

/** No two buffers sound at once. (A stopped buffer ends where it was stopped.) */
function expectNoOverlap(scheduled: Scheduled[]): void {
  const spans = audible(scheduled)
    .map((s) => ({ from: s.at, to: s.stoppedAt === null ? s.at + s.duration : Math.min(s.stoppedAt, s.at + s.duration) }))
    .sort((a, b) => a.from - b.from);
  for (let i = 1; i < spans.length; i++) {
    expect(spans[i].from).toBeGreaterThanOrEqual(spans[i - 1].to - 1e-9);
  }
}

// ── The framer ─────────────────────────────────────────────────────────────

describe("the framer: bytes into whole samples", () => {
  it("passes a whole-sample frame through untouched", () => {
    const framer = createPcmFramer();
    const frame = ramp(0, 759);
    expect(framer.push(frame, "r1")).toBe(frame);
    expect(framer.oddFrames()).toBe(0);
  });

  it("an ODD frame never shifts the samples after it", () => {
    const framer = createPcmFramer();
    const stream = ramp(100, 4000);
    // 1,001 + 2,999 + 4,000: two odd frames, a whole reply.
    const out = [stream.subarray(0, 1001), stream.subarray(1001, 4000), stream.subarray(4000)].map((f) =>
      framer.push(f, "r1")
    );
    expect(framer.oddFrames()).toBe(2);
    for (const o of out) expect((o?.length ?? 0) % 2).toBe(0);
    expect(samplesOf(concat(out.filter((o): o is Uint8Array => !!o)))).toEqual(samplesOf(stream));
  });

  it("holds for ANY way a reply is cut into frames", () => {
    const next = rng(20261109);
    for (let round = 0; round < 60; round++) {
      const framer = createPcmFramer();
      const stream = ramp(round * 7, 3000 + Math.floor(next() * 3000));
      const out: Uint8Array[] = [];
      for (let at = 0; at < stream.length; ) {
        const size = 1 + Math.floor(next() * 1700);
        const whole = framer.push(stream.subarray(at, at + size), "r");
        if (whole) {
          expect(whole.length % 2).toBe(0);
          out.push(whole.slice());
        }
        at += size;
      }
      expect(samplesOf(concat(out))).toEqual(samplesOf(stream));
    }
  });

  it("WHAT IT REPLACES: dropping the odd byte turns the rest of the reply into noise", () => {
    // The old player: Math.floor(bytes.length / 2) samples per frame, the
    // last byte of an odd frame thrown away.
    const stream = ramp(100, 4000);
    const frames = [stream.subarray(0, 1001), stream.subarray(1001)];
    const old = frames.flatMap((f) => samplesOf(f));
    const truth = samplesOf(stream);
    // The first 500 samples are right; after the odd frame, none are.
    expect(old.slice(0, 500)).toEqual(truth.slice(0, 500));
    const after = old.slice(500, 1500);
    const wrong = after.filter((v, i) => v !== truth[500 + i]).length;
    expect(wrong).toBeGreaterThan(990);
    // And it is LOUD: byte-swapped small numbers are big numbers.
    const peak = Math.max(...after.map(Math.abs));
    expect(peak).toBeGreaterThan(20_000);
  });

  it("half a sample left over from one reply is not glued to the next", () => {
    const framer = createPcmFramer();
    expect(framer.push(ramp(0, 10).subarray(0, 19), "r1")?.length).toBe(18);
    const second = ramp(500, 10);
    expect(samplesOf(framer.push(second, "r2")!)).toEqual(samplesOf(second));
  });

  it("a single byte is held, not played and not lost", () => {
    const framer = createPcmFramer();
    const stream = ramp(9, 2);
    expect(framer.push(stream.subarray(0, 1), "r")).toBeNull();
    expect(framer.push(new Uint8Array(0), "r")).toBeNull();
    expect(samplesOf(framer.push(stream.subarray(1), "r")!)).toEqual(samplesOf(stream));
  });
});

// ── The schedule ───────────────────────────────────────────────────────────

describe("the schedule: where each buffer goes on the context's clock", () => {
  it("a burst is laid end to end — no gap, no overlap, however fast it lands", () => {
    const schedule = createPcmSchedule();
    const at: number[] = [];
    for (let i = 0; i < 10; i++) at.push(schedule.place(1 + i * 0.001, 0.5));
    expect(at[0]).toBeCloseTo(1 + PCM_LEAD_S, 9);
    for (let i = 1; i < at.length; i++) expect(at[i]).toBeCloseTo(at[i - 1] + 0.5, 9);
    expect(schedule.underruns()).toBe(0);
  });

  it("a frame that still has queue in front of it is appended with NO gap", () => {
    const schedule = createPcmSchedule();
    schedule.place(1, 0.04); // 1.05 → 1.09
    // 40 ms later, and 20 ms late on top: 30 ms of queue left. The old rule
    // (now + lead, or the queue's end, whichever is later) is the same here…
    expect(schedule.place(1.06, 0.04)).toBeCloseTo(1.09, 9);
    // …and here it is not: 16 ms of queue left. Old rule: now + 20 ms = a
    // 4 ms hole. Now: end to end.
    expect(schedule.place(1.114, 0.04)).toBeCloseTo(1.13, 9);
    expect(schedule.underruns()).toBe(0);
    expect(schedule.gapMs()).toBe(0);
  });

  it("a queue that runs dry MID-REPLY is counted, with the silence it cost", () => {
    const schedule = createPcmSchedule();
    schedule.place(1, 0.1); // ends 1.15
    schedule.place(1.2, 0.1); // 50 ms after the queue ran out: restarts 100 ms deep, at 1.3
    expect(schedule.underruns()).toBe(1);
    expect(schedule.gapMs()).toBe(150);
    expect(schedule.leadMs()).toBe(100);
  });

  it("a queue with less than the safe margin left counts as dry — the buffer would start late", () => {
    const schedule = createPcmSchedule();
    schedule.place(1, 0.1); // ends 1.15
    const at = schedule.place(1.15 - PCM_SAFE_S / 2, 0.1);
    expect(schedule.underruns()).toBe(1);
    expect(at).toBeGreaterThan(1.15);
  });

  it("a real-time trickle whose lateness keeps growing: ONE hole, not one per late frame", () => {
    // 40 ms of audio every 40 ms; every tenth frame later than any before it
    // (5 ms, 10, 15 … 60) — a phone falling behind. The old rule cut a hole
    // for every one of them.
    const arrivals: number[] = [];
    for (let i = 0; i < 130; i++) arrivals.push(1 + i * 0.04 + (i % 10 === 9 ? (Math.floor(i / 10) + 1) * 0.005 : 0));
    const oldHoles = (() => {
      let nextAt = 0;
      let holes = 0;
      for (const t of arrivals) {
        const at = Math.max(t + 0.02, nextAt);
        if (nextAt > 0 && at > nextAt + 1e-9) holes++;
        nextAt = at + 0.04;
      }
      return holes;
    })();
    expect(oldHoles).toBeGreaterThanOrEqual(12);

    const schedule = createPcmSchedule();
    const placed = arrivals.map((t) => ({ at: schedule.place(t, 0.04), t }));
    expect(schedule.underruns()).toBe(1);
    // Every buffer but the one after the hole starts exactly where the last ended…
    let seams = 0;
    for (let i = 1; i < placed.length; i++) if (Math.abs(placed[i].at - (placed[i - 1].at + 0.04)) > 1e-9) seams++;
    expect(seams).toBe(1);
    // …and none is ever placed with less than the safe margin ahead of the clock.
    for (const p of placed) expect(p.at - p.t).toBeGreaterThanOrEqual(PCM_SAFE_S - 1e-9);
  });

  it("the cushion doubles per starvation and stops at 400 ms", () => {
    const schedule = createPcmSchedule();
    let now = 1;
    for (let i = 0; i < 8; i++) {
      schedule.place(now, 0.05);
      now = schedule.endsAt() + 0.01; // always just too late
    }
    expect(schedule.leadMs()).toBe(PCM_LEAD_MAX_S * 1000);
  });

  it("a burst never pays for a cushion", () => {
    const schedule = createPcmSchedule();
    for (let i = 0; i < 50; i++) schedule.place(1 + i * 0.002, 0.3);
    expect(schedule.leadMs()).toBe(PCM_LEAD_S * 1000);
    expect(schedule.underruns()).toBe(0);
  });

  it("the pause between two replies is not a starvation", () => {
    const schedule = createPcmSchedule();
    schedule.place(1, 0.5);
    schedule.place(9, 0.5);
    expect(schedule.underruns()).toBe(0);
  });

  it("after a cut the next buffer starts fresh", () => {
    const schedule = createPcmSchedule();
    schedule.place(1, 8);
    schedule.reset();
    expect(schedule.endsAt()).toBe(0);
    expect(schedule.place(2, 1)).toBeCloseTo(2 + PCM_LEAD_S, 9);
    expect(schedule.underruns()).toBe(0);
  });
});

// ── The player ─────────────────────────────────────────────────────────────

/** One ElevenLabs reply as it was measured: frames of 1,518 × n bytes. */
const ELEVEN_FRAMES = [1, 3, 5, 2, 8, 20, 20, 15, 5, 12].map((n) => n * 1518);

describe("the player: what reaches the speaker", () => {
  it("decodes s16le at the stated rate and schedules it on the sink", () => {
    const { ctx, scheduled } = fakeContext();
    const sink = { name: "sink" } as unknown as AudioNode;
    const player = createPcmPlayerOn(ctx, sink, RATE);
    player.play(new Uint8Array([0x00, 0x40, 0x00, 0xc0, 0xff, 0x7f]));
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].samples).toEqual([0x4000, -0x4000, 0x7fff]);
    expect(scheduled[0].rate).toBe(RATE);
    expect(scheduled[0].connectedTo).toBe(sink);
  });

  it("an ElevenLabs burst: every sample once, in order, end to end", () => {
    const { ctx, scheduled, state } = fakeContext();
    const player = createPcmPlayerOn(ctx, {} as AudioNode, RATE);
    const total = ELEVEN_FRAMES.reduce((a, b) => a + b, 0);
    const stream = ramp(0, total / 2);
    let at = 0;
    for (const size of ELEVEN_FRAMES) {
      player.play(stream.subarray(at, at + size));
      at += size;
      state.currentTime += 0.02; // the whole reply lands in 200 ms
    }
    expect(scheduled.flatMap((s) => s.samples)).toEqual(samplesOf(stream));
    for (let i = 1; i < scheduled.length; i++) {
      expect(scheduled[i].at).toBeCloseTo(scheduled[i - 1].at + scheduled[i - 1].duration, 9);
    }
    expectNoOverlap(scheduled);
    const st = player.stats();
    expect(st.buffers).toBe(ELEVEN_FRAMES.length);
    expect(st.bytes).toBe(total);
    expect(st.underruns).toBe(0);
    expect(st.maxQueuedMs).toBeGreaterThan(1500);
  });

  it("a cut stops every scheduled buffer and leaves nothing behind", () => {
    const { ctx, scheduled, state } = fakeContext();
    const player = createPcmPlayerOn(ctx, {} as AudioNode, RATE);
    for (let i = 0; i < 6; i++) player.play(ramp(i * 1000, 12_000)); // 3 s queued
    state.currentTime = 0.7;
    player.flush();
    expect(scheduled.every((s) => s.stoppedAt === 0.7)).toBe(true);
    // The next reply starts now, not after the 3 s that were cut.
    player.play(ramp(0, 2400));
    expect(scheduled[6].at).toBeCloseTo(0.7 + PCM_LEAD_S, 9);
    expectNoOverlap(scheduled);
    expect(player.stats().cuts).toBe(1);
  });

  it("counts audio that keeps arriving right after a cut (a reply the provider did not cancel)", () => {
    const { ctx } = fakeContext();
    let wall = 1_000;
    const player = createPcmPlayerOn(ctx, {} as AudioNode, RATE, { now: () => wall });
    player.play(ramp(0, 2400));
    player.flush();
    wall += 150;
    player.play(ramp(0, 1200));
    wall += 5_000;
    player.play(ramp(0, 1200));
    expect(player.stats().afterCutBytes).toBe(2400);
  });

  it("a flush with nothing playing is not a cut", () => {
    const { ctx } = fakeContext();
    const player = createPcmPlayerOn(ctx, {} as AudioNode, RATE);
    player.flush();
    expect(player.stats().cuts).toBe(0);
  });

  it("tells the half-duplex clock when the last sample leaves the device, and when it is cut", () => {
    const { ctx, state } = fakeContext();
    state.outputLatency = 0.05;
    const playing: number[] = [];
    const cut = vi.fn();
    const player = createPcmPlayerOn(ctx, {} as AudioNode, RATE, {
      watch: { playing: (until) => playing.push(until), cut },
      now: () => 10_000
    });
    player.play(ramp(0, RATE)); // 1 s
    player.play(ramp(0, RATE)); // 2 s queued
    expect(playing[0]).toBeCloseTo(10_000 + (PCM_LEAD_S + 1 + 0.05) * 1000, 6);
    expect(playing[1]).toBeCloseTo(10_000 + (PCM_LEAD_S + 2 + 0.05) * 1000, 6);
    player.flush();
    expect(cut).toHaveBeenCalledTimes(1);
  });

  it("reports the context's rate at birth and now — a change under a session is a finding", () => {
    const { ctx, state } = fakeContext(48_000);
    const player = createPcmPlayerOn(ctx, {} as AudioNode, RATE);
    state.sampleRate = 24_000;
    expect(player.stats()).toMatchObject({ ctxRate: 48_000, ctxRateNow: 24_000 });
  });

  it("closing stops what is queued and unplugs the sink", () => {
    const { ctx, scheduled } = fakeContext();
    const onClose = vi.fn();
    const player = createPcmPlayerOn(ctx, {} as AudioNode, RATE, { onClose });
    player.play(ramp(0, 24_000));
    player.close();
    expect(scheduled[0].stoppedAt).not.toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ── The gate in front of it: held audio and live audio ─────────────────────

describe("the gate and the player together", () => {
  it("held audio released into live audio is queued ONCE, in arrival order", () => {
    const { ctx, scheduled, state } = fakeContext();
    const player = createPcmPlayerOn(ctx, {} as AudioNode, RATE);
    const gate = createAudioGate<Uint8Array>(player, true);
    const frames = [ramp(0, 759), ramp(759, 2277), ramp(3036, 3795), ramp(6831, 1518)];
    gate.play(frames[0]);
    gate.play(frames[1]);
    expect(scheduled).toHaveLength(0);
    gate.setAudible(true); // the reply has words
    gate.setAudible(true); // …and says so again with every transcript delta
    state.currentTime += 0.01;
    gate.play(frames[2]);
    gate.setAudible(true);
    gate.play(frames[3]);
    expect(scheduled.flatMap((s) => s.samples)).toEqual(samplesOf(concat(frames)));
    expectNoOverlap(scheduled);
  });

  it("a barge-in storm: nothing is ever scheduled twice, and nothing overlaps", () => {
    // Every provider event the socket legs act on, in random order and at
    // random times, through the shipped rule (speakerActionFor), the shipped
    // gate and the shipped player — full duplex and half.
    for (const halfDuplex of [false, true]) {
      const next = rng(halfDuplex ? 11 : 9);
      const { ctx, scheduled, state } = fakeContext();
      const player = createPcmPlayerOn(ctx, {} as AudioNode, RATE);
      const gate = createAudioGate<Uint8Array>(player, true);
      const framer = createPcmFramer();
      let sample = 0;
      let reply = 0;
      for (let step = 0; step < 4000; step++) {
        state.currentTime += next() * 0.03;
        const roll = next();
        let msg: Record<string, unknown>;
        if (roll < 0.03) msg = { type: "response.created", response: { id: `r${++reply}` } };
        else if (roll < 0.07) msg = { type: "input_audio_buffer.speech_started" };
        else if (roll < 0.09) {
          msg = { type: "response.done", response: { status: "cancelled", status_details: { reason: "turn_detected" } } };
        } else if (roll < 0.2) msg = { type: "response.output_audio_transcript.delta" };
        else msg = { type: "response.output_audio.delta" };
        const action = speakerActionFor(msg, halfDuplex);
        if (action === "rearm") gate.rearm();
        else if (action === "cut") gate.flush();
        if (msg.type === "response.output_audio_transcript.delta") gate.setAudible(true);
        if (msg.type === "response.output_audio.delta") {
          // Irregular sizes, odd ones included — Grok's shape.
          const bytes = 1 + Math.floor(next() * 3000);
          const frame = ramp(sample, Math.ceil(bytes / 2)).subarray(0, bytes);
          const whole = framer.push(frame, `r${reply}`);
          if (whole) {
            sample += whole.length / 2;
            gate.play(whole);
          }
        }
      }
      expect(scheduled.length).toBeGreaterThan(200);
      expectNoOverlap(scheduled);
      for (const s of scheduled) expect(s.at).toBeGreaterThanOrEqual(0);
      // A buffer is one source: started once, never re-queued.
      expect(new Set(scheduled).size).toBe(scheduled.length);
    }
  });

  it("the socket legs frame the wire BEFORE the gate, and never play a raw frame", () => {
    const client = readFileSync("lib/interpreter/client.ts", "utf8");
    expect(client).not.toMatch(/player\.play\(base64ToBytes/);
    expect(client.match(/player\.playFrame\(base64ToBytes\(data\)/g)).toHaveLength(2);
    const gated = client.slice(client.indexOf("function createGatedPlayer"));
    expect(gated.indexOf("framer.push(bytes, key)")).toBeLessThan(gated.indexOf("gate.play(whole)"));
    // A reply's frames are keyed by the reply, so a new reply starts clean.
    expect(client).toContain('typeof msg.response_id === "string" ? msg.response_id : undefined');
  });
});

// ── The context under it ───────────────────────────────────────────────────

describe("a socket session plays on a context made after its microphone is live", () => {
  type FakeCtx = { sampleRate: number; state: string; resume: () => Promise<void>; close: () => Promise<void> };
  let made: FakeCtx[] = [];
  /** What the NEXT context will be: its rate, and whether it will start. */
  let nextRate = 48_000;
  let nextRuns = true;

  beforeEach(() => {
    made = [];
    nextRate = 48_000;
    nextRuns = true;
    vi.resetModules();
    class FakeAudioContext {
      sampleRate = nextRate;
      state = "suspended";
      private runs = nextRuns;
      constructor() {
        made.push(this as unknown as FakeCtx);
      }
      resume = async () => {
        if (this.runs) this.state = "running";
      };
      close = async () => {
        this.state = "closed";
      };
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("the page's old context is replaced and closed, and both rates are reported", async () => {
    const audio = await import("@/lib/tabletop/audio");
    // Born in the first tap of the page, at the hardware's rate then.
    nextRate = 48_000;
    const old = audio.ensureTabletopAudioContext() as unknown as FakeCtx;
    await Promise.resolve();
    // An afternoon later the microphone is live and the hardware is at 24 kHz.
    nextRate = 24_000;
    const renewal = await audio.renewTabletopAudioContext(20);
    expect(renewal).toMatchObject({ renewed: true, rate: 24_000, rateWas: 48_000 });
    expect(made).toHaveLength(2);
    expect(old.state).toBe("closed");
    // Everything that asks for the shared context now gets the fresh one.
    expect(audio.ensureTabletopAudioContext()).toBe(made[1]);
    expect(made).toHaveLength(2);
  });

  it("no old context: it simply makes one", async () => {
    const audio = await import("@/lib/tabletop/audio");
    const renewal = await audio.renewTabletopAudioContext(20);
    expect(renewal).toMatchObject({ renewed: true, rate: 48_000, rateWas: 0, ageS: 0 });
    expect(made).toHaveLength(1);
  });

  it("a browser that will not start one outside a tap keeps the context born in one", async () => {
    const audio = await import("@/lib/tabletop/audio");
    const old = audio.ensureTabletopAudioContext() as unknown as FakeCtx;
    await Promise.resolve();
    nextRuns = false;
    nextRate = 24_000;
    const renewal = await audio.renewTabletopAudioContext(20);
    expect(renewal).toMatchObject({ renewed: false, rate: 48_000, rateWas: 48_000 });
    expect(made[1].state).toBe("closed");
    expect(old.state).toBe("running");
    expect(audio.ensureTabletopAudioContext()).toBe(old);
  });

  it("the client renews AFTER the microphone and the mint, BEFORE any leg connects — socket engines only", () => {
    const client = readFileSync("lib/interpreter/client.ts", "utf8");
    const mic = client.indexOf("getUserMedia");
    const renew = client.indexOf("await renewTabletopAudioContext()");
    const connect = client.indexOf("Promise.allSettled(tickets.map(connect))");
    expect(mic).toBeGreaterThan(0);
    expect(renew).toBeGreaterThan(mic);
    expect(connect).toBeGreaterThan(renew);
    expect(client).toContain(
      'const socketAudio = tickets.some((t) => t.transport === "realtime-ws" || t.transport === "gemini-ws");'
    );
    // The WebRTC engines Tom and Liz kept never touch it.
    const before = client.slice(0, renew);
    expect(before.lastIndexOf("if (socketAudio) {")).toBeGreaterThan(before.lastIndexOf("const socketAudio"));
  });
});

// ── The phone test's two switches ──────────────────────────────────────────

describe("the phone test's switches", () => {
  it("?pcmout=direct plays straight to the destination; anything else is the <audio> element", () => {
    expect(pcmRouteFrom("?pcmout=direct")).toBe("direct");
    expect(pcmRouteFrom("?diag=1&pcmout=direct")).toBe("direct");
    expect(pcmRouteFrom("")).toBe("element");
    expect(pcmRouteFrom("?pcmout=1")).toBe("element");
  });

  it("?pcmctx=keep is the control arm: the context the page already had", () => {
    expect(pcmContextRenewalFrom("?pcmctx=keep")).toBe(false);
    expect(pcmContextRenewalFrom("")).toBe(true);
    expect(pcmContextRenewalFrom("?pcmctx=fresh")).toBe(true);
  });

  it("neither is remembered, and neither is a public flag", () => {
    for (const file of ["lib/interpreter/pcmPlayer.ts", "lib/interpreter/client.ts", "lib/tabletop/audio.ts"]) {
      const src = readFileSync(file, "utf8");
      expect(src).not.toContain("NEXT_PUBLIC_");
      if (file !== "lib/interpreter/client.ts") expect(src).not.toContain("localStorage");
    }
  });
});

// ── What the next table test will say ──────────────────────────────────────

describe("the diagnostics line carries the speaker's numbers", () => {
  function digestOf(notes: (leg: ReturnType<ReturnType<typeof createSessionTimeline>["leg"]>) => void) {
    const timeline = createSessionTimeline({ engine: "grok-voice", model: "grok-voice-3.0" });
    const leg = timeline.leg(0, { source: "en", target: "es", transport: "realtime-ws" });
    notes(leg);
    return timeline.export().digest[0];
  }

  it("a stale context shows as ctx_rate ≠ ctx_rate_was, and its age", () => {
    const digest = digestOf((leg) => {
      leg.note("audio-ctx", { cfg: { renewed: 1, kept: 0, rate: 24_000, rate_was: 48_000, age_s: 5400, direct: 0 } });
      leg.note("pcm-stats", {
        cfg: { buffers: 412, odd: 37, underruns: 9, gap_ms: 640, cuts: 3, after_cut: 96_000, queued_ms: 4100, rate: 24_000, rate_now: 24_000 }
      });
    });
    const summary = summarizeLegDigest(digest);
    expect(summary).toMatchObject({
      ctx_renewed: 1,
      ctx_rate: 24_000,
      ctx_rate_was: 48_000,
      ctx_rate_end: 24_000,
      ctx_age_s: 5400,
      pcm_direct: 0,
      pcm_buffers: 412,
      pcm_odd_frames: 37,
      pcm_underruns: 9,
      pcm_gap_ms: 640,
      pcm_after_cut_bytes: 96_000
    });
    const line = timelineLogLine("grok-voice", summary);
    for (const part of ["ctx_rate=24000", "ctx_rate_was=48000", "ctx_age_s=5400", "pcm_odd_frames=37", "pcm_underruns=9"]) {
      expect(line).toContain(part);
    }
  });

  it("a leg that reconnected adds its players up", () => {
    const digest = digestOf((leg) => {
      leg.note("pcm-stats", { cfg: { buffers: 10, odd: 1, underruns: 2, gap_ms: 50, after_cut: 0, rate: 48_000, rate_now: 48_000 } });
      leg.note("pcm-stats", { cfg: { buffers: 5, odd: 0, underruns: 1, gap_ms: 25, after_cut: 480, rate: 48_000, rate_now: 48_000 } });
    });
    expect(summarizeLegDigest(digest)).toMatchObject({ pcm_buffers: 15, pcm_odd_frames: 1, pcm_underruns: 3, pcm_gap_ms: 75 });
  });

  it("the server takes NUMBERS only for them, and an older phone's digest still parses", () => {
    const summary = summarizeLegDigest(
      digestOf((leg) => leg.note("audio-ctx", { cfg: { renewed: 1, rate: 48_000, rate_was: 44_100, age_s: 3 } }))
    );
    expect(parseTimelineDigest([summary])?.[0]).toMatchObject({ ctx_rate: 48_000, ctx_rate_was: 44_100 });
    const older = { ...summary } as Record<string, unknown>;
    for (const key of Object.keys(older)) if (key.startsWith("ctx_") || key.startsWith("pcm_")) delete older[key];
    expect(parseTimelineDigest([older])?.[0]).toMatchObject({ ctx_rate: 0, pcm_odd_frames: 0 });
    expect(parseTimelineDigest([{ ...summary, pcm_odd_frames: "hola, ¿cómo estás?" }])).toBeNull();
    expect(parseTimelineDigest([{ ...summary, ctx_rate: -1 }])).toBeNull();
  });

  it("the exported rows carry tokens only", () => {
    const timeline = createSessionTimeline({ engine: "grok-voice", model: "grok-voice-3.0" });
    const leg = timeline.leg(0, { source: "en", target: "es", transport: "realtime-ws" });
    leg.note("audio-ctx", { cfg: { renewed: 1, rate: 48_000, rate_was: 44_100, age_s: 3, direct: 0 } });
    const row = timeline.export().rows.find((r) => r.type === "audio-ctx");
    expect(row?.cfg).toMatchObject({ rate: "48000", rate_was: "44100" });
  });
});
