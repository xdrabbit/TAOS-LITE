// The speaker of a SOCKET leg: PCM frames in, sound out. Used by the three
// engines whose audio arrives as events rather than on a WebRTC track — Gemini
// Live, Grok Voice, ElevenLabs Realtime (lib/interpreter/client.ts).
//
// Lifted out of client.ts on 2026-11-09 so it can be run by a test and by a
// browser check with a known signal. Until then it could only be listened to,
// and the only ears were at a dinner table.
//
// ── Why (Tom and Liz's table, 2026-11-09 afternoon) ────────────────────────
// On Grok and on ElevenLabs "the audio degrades into a folding waveform that
// repeats at a rapid rate". Those are the only two engines that table played
// through this file. What the afternoon's own log lines and a wire probe say
// (docs: the PR that added this file):
//
//   · the PROTOCOL was healthy on the broken ElevenLabs sessions — every
//     reply completed, nothing cut, nothing held and dropped, no phantom
//     speech. So the fault is in how the sound is RENDERED, not in which
//     frames were queued.
//   · ElevenLabs sends a reply as ~10 big sample-aligned frames in one burst
//     (3–5 s of audio in 40–250 ms). Nothing in ten buffers scheduled back to
//     back can "repeat at a rapid rate" — unless the CONTEXT rendering them
//     is itself broken. See lib/tabletop/audio.ts, renewTabletopAudioContext.
//   · Grok's frame sizes are irregular (its reply totals in the long broken
//     session are not multiples of any frame length; no xAI key exists on the
//     build machine, so its wire could not be probed). This player used to
//     DROP the last byte of an odd-length frame — after which every later
//     sample of the reply is read one byte out of step: full-scale noise
//     shaped like the speech. The defect is certain and reproduced with a
//     scripted provider; that Grok SENDS odd frames is not — `pcm_odd_frames`
//     on the diagnostics line of the next Grok session says so either way.
//
// So this file does three things the old one did not:
//   1. frames the byte stream — an odd frame never shifts the samples;
//   2. counts what it did (frames, odd frames, starvation gaps, audio that
//      arrived after a cut) — numbers only, for the diagnostics line;
//   3. can play straight to the context's destination instead of through an
//      <audio> element, so a phone test can tell those two paths apart.
//
// No audio is kept, logged or measured beyond its LENGTH.

// ── 1. The framer: bytes → whole samples ───────────────────────────────────

export interface PcmFramer {
  /**
   * The next frame of one reply's audio. Returns whole 16-bit samples (an
   * even number of bytes) or null when there is not one whole sample yet.
   * `key` names the reply: a new key starts a new stream, and half a sample
   * left over from the old one is thrown away rather than glued to it.
   */
  push: (bytes: Uint8Array, key?: string) => Uint8Array | null;
  /** Frames that arrived with an odd number of bytes. */
  oddFrames: () => number;
}

export function createPcmFramer(): PcmFramer {
  let carry: number | null = null;
  let stream: string | undefined;
  let odd = 0;
  return {
    push: (bytes, key) => {
      if (key !== stream) {
        stream = key;
        carry = null;
      }
      if (bytes.length % 2) odd += 1;
      if (carry === null && bytes.length % 2 === 0) return bytes.length ? bytes : null;
      let all = bytes;
      if (carry !== null) {
        all = new Uint8Array(bytes.length + 1);
        all[0] = carry;
        all.set(bytes, 1);
      }
      const whole = all.length - (all.length % 2);
      // What is left is at most one byte: the first half of the next sample.
      carry = all.length % 2 ? all[all.length - 1] : null;
      return whole ? all.subarray(0, whole) : null;
    },
    oddFrames: () => odd
  };
}

// ── 2. The schedule: where on the context's clock each buffer goes ─────────

/**
 * Seconds ahead of "now" a buffer is placed when nothing is queued. It was
 * 20 ms until 2026-11-09; a context renders ahead of the clock it reports (a
 * phone's hardware buffer can be that long by itself), and a buffer placed
 * behind the render position starts LATE, plays whole, and so runs into the
 * one placed after it.
 */
export const PCM_LEAD_S = 0.05;
/**
 * The least margin a buffer may be appended with. Under it the queue counts
 * as run dry: the buffer would start late and overlap its successor.
 */
export const PCM_SAFE_S = 0.015;
/**
 * A dry queue for less than this, between two frames of audio, is a
 * STARVATION (the provider or the phone fell behind mid-reply). Longer is
 * just the pause between two replies.
 */
export const PCM_STARVED_MAX_S = 1;
/**
 * The cushion after a starvation. A provider that sends 40 ms of audio every
 * 40 ms keeps the queue exactly as deep as it started, so every frame that
 * arrives later than any before it found the queue short. The old rule then
 * placed it at now + 20 ms — a few ms of SILENCE cut into the sound — and
 * the next record-late frame did it again: holes at the frame rate for as
 * long as the lateness was growing. Measured in a desktop browser on the real
 * screen (tests/live-fire/interpreter-pcm-playback-browser-check.mjs, the
 * "trickle" turn: 12 holes in half a second); a phone's main thread is
 * busier.
 *
 * Now a frame that still has PCM_SAFE_S of queue in front of it is appended
 * with no gap at all, and one that does not is a starvation: counted, and the
 * restart is DOUBLE the lead — 100 ms, 200, 400 at most — which the player
 * keeps. One hole buys the rest of the session its slack. An engine that
 * sends in bursts (ElevenLabs) never starves and never pays it.
 */
export const PCM_LEAD_MAX_S = 0.4;

export interface PcmSchedule {
  /** Where a buffer of `duration` seconds goes, given the context's clock. */
  place: (now: number, duration: number) => number;
  /** Everything queued was cut: the next buffer starts fresh. */
  reset: () => void;
  /** The clock time the last queued buffer ends at (0 = nothing queued). */
  endsAt: () => number;
  underruns: () => number;
  /** Total silence inserted by starvation, in ms. */
  gapMs: () => number;
  /** The lead a dry queue restarts with now, in ms. */
  leadMs: () => number;
}

export function createPcmSchedule(baseLead: number = PCM_LEAD_S): PcmSchedule {
  let lead = baseLead;
  let nextAt = 0;
  let underruns = 0;
  let gap = 0;
  return {
    place: (now, duration) => {
      const margin = nextAt - now;
      let at: number;
      if (nextAt > 0 && margin >= PCM_SAFE_S) {
        // Something is still queued in front of it: END TO END, no gap, and
        // never earlier — two buffers of one leg must not sound at once.
        at = nextAt;
      } else if (nextAt > 0 && -margin < PCM_STARVED_MAX_S) {
        // The queue ran out (or as good as) and audio is still coming: a hole
        // in the sound. Restart deeper, so the next late frame has a cushion.
        underruns += 1;
        lead = Math.min(PCM_LEAD_MAX_S, lead * 2);
        at = now + lead;
        gap += at - nextAt;
      } else {
        // A new reply.
        at = now + lead;
      }
      nextAt = at + duration;
      return at;
    },
    reset: () => {
      nextAt = 0;
    },
    endsAt: () => nextAt,
    underruns: () => underruns,
    gapMs: () => Math.round(gap * 1000),
    leadMs: () => Math.round(lead * 1000)
  };
}

// ── 3. The player ──────────────────────────────────────────────────────────

/** What a player did, as numbers. Nothing here is audio. */
export interface PcmPlayerStats {
  /** Buffers scheduled, and their PCM bytes. */
  buffers: number;
  bytes: number;
  underruns: number;
  gapMs: number;
  /** Times the queue was cut, and audio that arrived within 2 s AFTER a cut. */
  cuts: number;
  afterCutBytes: number;
  /** The most audio ever queued ahead of the clock, ms. */
  maxQueuedMs: number;
  /** The lead a dry queue restarts with (50 until a starvation raised it), ms. */
  leadMs: number;
  /** The context's rate when the player was made, and now. A change is a finding. */
  ctxRate: number;
  ctxRateNow: number;
}

export interface PcmPlayer {
  /** Whole samples only (createPcmFramer): s16le mono at the player's rate. */
  play: (bytes: Uint8Array) => void;
  flush: () => void;
  close: () => void;
  stats: () => PcmPlayerStats;
}

/** The slice of AudioContext this player uses — so a test can stand in for it. */
export interface PcmContext {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly outputLatency?: number;
  createBuffer: (channels: number, length: number, rate: number) => AudioBuffer;
  createBufferSource: () => AudioBufferSourceNode;
}

/** How long after a cut late frames still count as "after the cut". */
const AFTER_CUT_WINDOW_MS = 2000;

export function createPcmPlayerOn(
  ctx: PcmContext,
  /** Where the sound goes: a MediaStreamDestination, or the context's own. */
  sink: AudioNode,
  rate: number,
  opts: {
    /** Told when audio is scheduled (until when, wall clock) and when it is cut. */
    watch?: { playing: (untilMs: number) => void; cut: () => void };
    /** Drop whatever `sink` was plugged into. */
    onClose?: () => void;
    now?: () => number;
  } = {}
): PcmPlayer {
  const { watch } = opts;
  const now = opts.now ?? Date.now;
  const schedule = createPcmSchedule();
  const ctxRate = ctx.sampleRate;
  let sources: AudioBufferSourceNode[] = [];
  let buffers = 0;
  let bytesPlayed = 0;
  let cuts = 0;
  let cutAt = 0;
  let afterCutBytes = 0;
  let maxQueued = 0;
  return {
    play: (bytes) => {
      const samples = Math.floor(bytes.length / 2);
      if (!samples) return;
      const buffer = ctx.createBuffer(1, samples, rate);
      const channel = buffer.getChannelData(0);
      const view = new DataView(bytes.buffer, bytes.byteOffset, samples * 2);
      for (let i = 0; i < samples; i++) channel[i] = view.getInt16(i * 2, true) / 0x8000;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(sink);
      // The buffer's OWN length, not buffer.duration: the same number, without
      // trusting a context that may have re-rated the buffer under us.
      const at = schedule.place(ctx.currentTime, samples / rate);
      source.start(at);
      buffers += 1;
      bytesPlayed += samples * 2;
      if (cutAt && now() - cutAt < AFTER_CUT_WINDOW_MS) afterCutBytes += samples * 2;
      const queued = schedule.endsAt() - ctx.currentTime;
      if (queued > maxQueued) maxQueued = queued;
      if (watch) {
        // Until the last sample has left the DEVICE, where the context can say.
        const latency =
          typeof ctx.outputLatency === "number" && Number.isFinite(ctx.outputLatency) ? ctx.outputLatency : 0;
        watch.playing(now() + (queued + latency) * 1000);
      }
      sources.push(source);
      source.onended = () => {
        sources = sources.filter((s) => s !== source);
        try {
          source.disconnect();
        } catch {
          /* ignore */
        }
      };
    },
    flush: () => {
      const had = sources.length > 0;
      for (const s of sources) {
        // A stopped source must not report back into a list that has moved on.
        s.onended = null;
        try {
          s.stop();
        } catch {
          /* already ended */
        }
        try {
          s.disconnect();
        } catch {
          /* ignore */
        }
      }
      sources = [];
      schedule.reset();
      if (had) {
        cuts += 1;
        cutAt = now();
      }
      watch?.cut();
    },
    close: () => {
      for (const s of sources) {
        s.onended = null;
        try {
          s.stop();
        } catch {
          /* already ended */
        }
      }
      sources = [];
      opts.onClose?.();
    },
    stats: () => ({
      buffers,
      bytes: bytesPlayed,
      underruns: schedule.underruns(),
      gapMs: schedule.gapMs(),
      cuts,
      afterCutBytes,
      maxQueuedMs: Math.round(maxQueued * 1000),
      leadMs: schedule.leadMs(),
      ctxRate,
      ctxRateNow: ctx.sampleRate
    })
  };
}

// ── The phone test's two switches ──────────────────────────────────────────
// Founders only by construction (the mode is), read from the page's query
// string so a table test can be run both ways without a deploy:
//
//   /tabletop?pcmout=direct   play straight to the context's destination
//                             instead of through a hidden <audio> element
//   /tabletop?pcmctx=keep     do NOT make a fresh AudioContext for the
//                             session — the behaviour before this fix, kept
//                             as the control arm
//
// Neither is remembered: a reload without the parameter is the default.

export type PcmRoute = "element" | "direct";

export function pcmRouteFrom(search: string): PcmRoute {
  try {
    return new URLSearchParams(search).get("pcmout") === "direct" ? "direct" : "element";
  } catch {
    return "element";
  }
}

export function pcmContextRenewalFrom(search: string): boolean {
  try {
    return new URLSearchParams(search).get("pcmctx") !== "keep";
  } catch {
    return true;
  }
}
