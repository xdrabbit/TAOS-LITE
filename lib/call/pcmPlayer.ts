"use client";

// The playback scheduler the Gemini arm needs and the rest of the repo never
// did. The OpenAI path plays either a live WebRTC track (the browser's jitter
// buffer does this job) or whole mp3 blobs; Gemini hands back a continuous
// stream of raw 24 kHz PCM over a WebSocket, 250 ms at a time, and nothing
// plays that for free.
//
// ── The policy ─────────────────────────────────────────────────────────────
// Chunks are scheduled back to back on the call's shared AudioContext.
// `ahead` is how much audio is already scheduled and not yet heard.
//
//   start / underrun   a chunk that would start in the past (the network was
//                      late) is placed PREROLL_S from now. The gap is heard
//                      as a short silence. Audio is never sped up or
//                      squeezed to catch up.
//   silence catch-up   when `ahead` is past TARGET_AHEAD_S, SILENT chunks are
//                      dropped. Gemini streams silence between utterances, so
//                      every pause is a free chance to get back to real time
//                      without cutting a word.
//   overrun            when `ahead` is past MAX_AHEAD_S, EVERY chunk is
//                      dropped, speech included, until it drains. This is the
//                      ceiling: the listener is never more than MAX_AHEAD_S
//                      behind what Gemini sent, however long the call. Drop,
//                      never queue — a backlog that is allowed to grow is the
//                      E6 ratchet (latency that only a rejoin resets) built
//                      from the other end.
//   muted              nothing is scheduled at all, and whatever was already
//                      scheduled is stopped.
//
// Every decision is counted, and the counts go on the interpreter's trail.

export const PREROLL_S = 0.12;
export const TARGET_AHEAD_S = 0.4;
export const MAX_AHEAD_S = 1.5;
/** A chunk that would start closer than this to now counts as late. */
const MIN_LEAD_S = 0.01;

export type ScheduleDecision =
  | { action: "play"; at: number; underrun: boolean }
  | { action: "drop"; reason: "muted" | "silence" | "overrun" };

/**
 * The whole policy, as a pure function of the clock, so it can be tested
 * without WebAudio. `nextTime` is where the previous chunk ends, or null
 * before the first one.
 */
export function decideSchedule(input: {
  now: number;
  nextTime: number | null;
  voiced: boolean;
  muted: boolean;
}): ScheduleDecision {
  const { now, nextTime, voiced, muted } = input;
  if (muted) return { action: "drop", reason: "muted" };
  const ahead = nextTime === null ? 0 : nextTime - now;
  if (ahead > MAX_AHEAD_S) return { action: "drop", reason: "overrun" };
  if (!voiced && ahead > TARGET_AHEAD_S) return { action: "drop", reason: "silence" };
  if (nextTime === null || nextTime < now + MIN_LEAD_S) {
    return { action: "play", at: now + PREROLL_S, underrun: nextTime !== null };
  }
  return { action: "play", at: nextTime, underrun: false };
}

export interface PcmPlayerStats {
  played: number;
  droppedSilence: number;
  droppedOverrun: number;
  underruns: number;
  /** Scheduled and not yet heard, in ms. */
  aheadMs: number;
}

export interface PcmPlayer {
  /** One chunk of mono float samples at `sampleRate`, and whether it is speech. */
  push: (samples: Float32Array, voiced: boolean) => void;
  setMuted: (muted: boolean) => void;
  stats: () => PcmPlayerStats;
  release: () => void;
}

export function createPcmPlayer(
  ctx: AudioContext,
  sampleRate: number,
  onSpeaking: (speaking: boolean) => void
): PcmPlayer {
  const out = ctx.createGain();
  out.connect(ctx.destination);
  const live = new Set<AudioBufferSourceNode>();
  let nextTime: number | null = null;
  let muted = false;
  let speaking = false;
  // ctx time at which the last scheduled SPEECH finishes playing.
  let speechEndsAt = 0;
  let speakingTimer: number | null = null;
  const counts = { played: 0, droppedSilence: 0, droppedOverrun: 0, underruns: 0 };

  const setSpeaking = (next: boolean) => {
    if (speaking === next) return;
    speaking = next;
    onSpeaking(next);
  };

  const armSpeakingEnd = () => {
    if (speakingTimer !== null) window.clearTimeout(speakingTimer);
    const ms = Math.max(0, (speechEndsAt - ctx.currentTime) * 1000);
    speakingTimer = window.setTimeout(() => {
      speakingTimer = null;
      if (ctx.currentTime >= speechEndsAt - 0.005) setSpeaking(false);
      else armSpeakingEnd();
    }, ms + 20);
  };

  const stopAll = () => {
    for (const node of live) {
      try {
        node.stop();
      } catch {
        /* already stopped */
      }
    }
    live.clear();
    nextTime = null;
    speechEndsAt = 0;
    if (speakingTimer !== null) window.clearTimeout(speakingTimer);
    speakingTimer = null;
    setSpeaking(false);
  };

  return {
    push: (samples, voiced) => {
      const decision = decideSchedule({ now: ctx.currentTime, nextTime, voiced, muted });
      if (decision.action === "drop") {
        if (decision.reason === "silence") counts.droppedSilence += 1;
        else if (decision.reason === "overrun") counts.droppedOverrun += 1;
        return;
      }
      if (decision.underrun) counts.underruns += 1;
      const buffer = ctx.createBuffer(1, samples.length, sampleRate);
      buffer.getChannelData(0).set(samples);
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(out);
      node.onended = () => {
        live.delete(node);
        try {
          node.disconnect();
        } catch {
          /* ignore */
        }
      };
      live.add(node);
      node.start(decision.at);
      nextTime = decision.at + buffer.duration;
      counts.played += 1;
      if (voiced) {
        speechEndsAt = Math.max(speechEndsAt, nextTime);
        setSpeaking(true);
        armSpeakingEnd();
      }
    },
    setMuted: (next) => {
      if (muted === next) return;
      muted = next;
      if (next) stopAll();
    },
    stats: () => ({
      ...counts,
      aheadMs: nextTime === null ? 0 : Math.max(0, (nextTime - ctx.currentTime) * 1000)
    }),
    release: () => {
      stopAll();
      try {
        out.disconnect();
      } catch {
        /* ignore */
      }
    }
  };
}
