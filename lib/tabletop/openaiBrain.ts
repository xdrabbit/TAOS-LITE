"use client";

import { startTabletopLive } from "./live";
import type { TabletopDirection } from "./instructions";
import type { ActiveTabletopBrain, TabletopBrainEvents } from "./brain";
import { SEGMENT_SILENCE_MS } from "./metrics";
import {
  addResponseUsage,
  addTranscribedSeconds,
  emptySpend,
  spendUsd,
  type CallSpend,
  type RealtimeUsage
} from "@/lib/call/cost";

// The CONTROL arm of the /tabletop brain A/B: today's gpt-realtime table,
// lib/tabletop/live.ts, wrapped and not changed. Same mint route, same
// session, same session.update per turn, same mute-between-turns — the only
// thing added is a read-only tap on the server events (onRealtimeEvent), from
// which this file measures. If the openai arm ever behaves differently from
// main, the comparison is void; tests/tabletop-brain.test.ts pins the session
// builder's output against main's to make that loud.

/** Server event → phone clock: when the voice stopped, per server VAD. */
export function openaiSegmentPairing(silenceMs: number = SEGMENT_SILENCE_MS) {
  const speechEnds: number[] = [];
  let current: { ref: number; firstAt: number | null; text: string } | null = null;
  let speechStartMs: number | null = null;

  return {
    /**
     * Feed one event with the time it arrived. Returns a finished segment
     * when a response with text completes, and the seconds of speech the
     * transcription model will bill when a VAD segment closes.
     */
    event(
      ev: Readonly<Record<string, unknown>>,
      at: number
    ): {
      segment?: { text: string; firstPartialMs: number; doneMs: number };
      transcribedSeconds?: number;
      usage?: RealtimeUsage;
    } {
      const type = typeof ev.type === "string" ? ev.type : "";
      if (type === "input_audio_buffer.speech_started") {
        speechStartMs = typeof ev.audio_start_ms === "number" ? ev.audio_start_ms : null;
        return {};
      }
      if (type === "input_audio_buffer.speech_stopped") {
        // speech_stopped is sent once silence_duration_ms of quiet has passed,
        // so the voice stopped that long before it arrived (give or take the
        // network hop — see lib/tabletop/metrics.ts).
        speechEnds.push(at - silenceMs);
        const endMs = typeof ev.audio_end_ms === "number" ? ev.audio_end_ms : null;
        const seconds =
          speechStartMs !== null && endMs !== null ? Math.max(0, (endMs - speechStartMs) / 1000) : 0;
        speechStartMs = null;
        return seconds > 0 ? { transcribedSeconds: seconds } : {};
      }
      if (type === "response.created") {
        // create_response: true → one response per committed VAD segment,
        // in order.
        current = { ref: speechEnds.shift() ?? at, firstAt: null, text: "" };
        return {};
      }
      if (type === "response.output_text.delta" || type === "response.text.delta") {
        const d = typeof ev.delta === "string" ? ev.delta : "";
        if (d && current) {
          current.firstAt ??= at;
          current.text += d;
        }
        return {};
      }
      if (type === "response.done") {
        const response = ev.response as { usage?: RealtimeUsage } | undefined;
        const done = current;
        current = null;
        const out: ReturnType<ReturnType<typeof openaiSegmentPairing>["event"]> = {
          usage: response?.usage
        };
        // A response that wrote nothing (noise, the listener's own language)
        // is not a segment anybody waited for.
        if (done && done.firstAt !== null && done.text.trim()) {
          out.segment = {
            text: done.text.trim(),
            firstPartialMs: done.firstAt - done.ref,
            doneMs: at - done.ref
          };
        }
        return out;
      }
      return {};
    }
  };
}

export async function startOpenAIBrain(
  events: TabletopBrainEvents,
  openingDirection: TabletopDirection
): Promise<ActiveTabletopBrain> {
  const pairing = openaiSegmentPairing();
  let spend: CallSpend = emptySpend();

  const live = await startTabletopLive(
    {
      onState: events.onState,
      onError: events.onError,
      onHeard: events.onHeard,
      onTranslationDelta: events.onPartial,
      onRealtimeEvent: (ev) => {
        const r = pairing.event(ev, performance.now());
        if (r.transcribedSeconds) spend = addTranscribedSeconds(spend, r.transcribedSeconds);
        if (r.usage) spend = addResponseUsage(spend, r.usage);
        if (r.transcribedSeconds || r.usage) events.onSpend?.(spendUsd(spend));
        if (r.segment) {
          events.onSegmentDone?.(r.segment.text, {
            firstPartialMs: r.segment.firstPartialMs,
            doneMs: r.segment.doneMs
          });
        }
      }
    },
    openingDirection
  );

  return { kind: "openai", ...live };
}
