// A real gpt-realtime session, driven from Node, with the usage numbers kept.
//
// This is the instrument behind docs/realtime-cost-model.md. The /call model
// (2026-08-27) was measured with a throwaway script against a hand-copied
// session object; that made its numbers unreproducible and, worse, made them
// describe a configuration that only ever existed in the script. This driver
// takes the session object from the same builder the mint route uses
// (lib/live/session.ts, lib/tabletop/session.ts), so a measurement is a
// measurement OF THE THING THAT SHIPS.
//
// It is not a test. `npm test` never runs it — it costs real money and needs
// OPENAI_API_KEY. See vitest.measure.config.ts and the README block at the top
// of realtime-cost.measure.ts for how to run it.
//
// ── The one honest difference from production ──────────────────────────────
// The app reaches Realtime over WebRTC, where the audio format is negotiated
// in the SDP. A WebSocket has no SDP, so the driver adds exactly one field the
// browser gets for free — `audio.input.format` — and changes nothing else.
// Every other byte of the session is the builder's.

import { AUDIO_TOKENS_PER_SECOND, type RealtimeUsage } from "@/lib/call/cost";

const REALTIME_WS_URL = "wss://api.openai.com/v1/realtime";
const SPEECH_URL = "https://api.openai.com/v1/audio/speech";

/** The realtime API's native input format: 24 kHz, 16-bit, mono. */
export const SAMPLE_RATE = 24_000;
const BYTES_PER_SAMPLE = 2;

/** One utterance's worth of PCM, with the length it will be billed for. */
export interface Utterance {
  text: string;
  pcm: Buffer;
  seconds: number;
}

/** What one response cost, and what it was given to work with. */
export interface TurnRecord {
  index: number;
  /** The text the model produced (transcript in audio mode, text in text mode). */
  output: string;
  usage: RealtimeUsage;
  audioInTokens: number;
  cachedAudioInTokens: number;
  textInTokens: number;
  cachedTextInTokens: number;
  textOutTokens: number;
  audioOutTokens: number;
}

export interface RunResult {
  label: string;
  turns: TurnRecord[];
  /** Seconds of speech actually streamed in — the denominator for the ratio. */
  spokenSeconds: number;
  /** What VAD committed, per the API's own speech_started/stopped clock. */
  committedSeconds: number;
  heard: string[];
}

/**
 * Synthesise one Spanish utterance as raw PCM.
 *
 * Real speech, not a tone: VAD has to commit it and the transcriber has to
 * read it, and neither does anything useful with a sine wave. The same text
 * produces near-identical audio every run, which is what lets two arms of the
 * measurement differ only in the setting under test — the property the /call
 * measurement was built on ("same audio each run, changing only truncation").
 */
export async function synthesize(text: string, voice = "alloy"): Promise<Utterance> {
  const apiKey = requireKey();
  const res = await fetch(SPEECH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice,
      input: text,
      response_format: "pcm"
    })
  });
  if (!res.ok) throw new Error(`TTS ${res.status}: ${await res.text()}`);
  const pcm = Buffer.from(await res.arrayBuffer());
  return { text, pcm, seconds: pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE) };
}

export function requireKey(): string {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("OPENAI_API_KEY is required to run a live-fire measurement.");
  return key;
}

function silence(ms: number): Buffer {
  return Buffer.alloc(Math.round((SAMPLE_RATE * BYTES_PER_SAMPLE * ms) / 1000));
}

export interface DriveOptions {
  label: string;
  model: string;
  /** The session object, straight from the surface's builder. */
  session: Record<string, unknown>;
  utterances: Utterance[];
  /**
   * false when the session is minted with `create_response: false` and the
   * real client is the one that asks for a response (/live, /call). true when
   * the server creates one per VAD segment (/tabletop).
   */
  serverCreatesResponses: boolean;
  /**
   * A `session.update` patch to send before utterance `index`, or null for
   * none. /tabletop's client does exactly this on every turn — it re-points
   * the interpreter with `buildTurnInstructions(direction)` as the phone goes
   * round the table (lib/tabletop/live.ts, beginTurn). Measuring the table
   * WITHOUT it made every second turn an out-of-direction utterance and the
   * model broke character trying to cope, which would have been recorded as a
   * quality cliff caused by the cap. It was caused by the harness.
   */
  beforeUtterance?: (index: number) => Record<string, unknown> | null;
  /** Milliseconds of trailing silence after each utterance, to close VAD. */
  trailingSilenceMs?: number;
  onEvent?: (type: string, ev: Record<string, unknown>) => void;
}

/**
 * Stream the utterances into a live session and collect what each response
 * cost. Resolves once every utterance has produced a response, or rejects if
 * the session errors or stalls.
 */
export async function driveSession(opts: DriveOptions): Promise<RunResult> {
  const apiKey = requireKey();
  const trailingSilenceMs = opts.trailingSilenceMs ?? 1200;

  const ws = new WebSocket(`${REALTIME_WS_URL}?model=${encodeURIComponent(opts.model)}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  } as unknown as string[]);

  const turns: TurnRecord[] = [];
  const heard: string[] = [];
  let committedSeconds = 0;
  let speechStartMs: number | null = null;
  let outputBuffer = "";
  let fatal: Error | null = null;

  const waiters = new Set<{ match: (t: string, ev: Record<string, unknown>) => boolean; resolve: (ev: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  const settleAll = (err: Error) => {
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    waiters.clear();
  };

  /** Resolve when an event of a given type (and optional predicate) arrives. */
  const waitFor = (
    match: (t: string, ev: Record<string, unknown>) => boolean,
    timeoutMs = 45_000,
    what = "event"
  ): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      if (fatal) {
        reject(fatal);
        return;
      }
      const entry = {
        match,
        resolve,
        reject,
        timer: setTimeout(() => {
          waiters.delete(entry);
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`));
        }, timeoutMs)
      };
      waiters.add(entry);
    });

  ws.onmessage = ({ data }) => {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(String(data)) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = typeof ev.type === "string" ? ev.type : "";
    opts.onEvent?.(type, ev);

    if (type === "input_audio_buffer.speech_started") {
      speechStartMs = typeof ev.audio_start_ms === "number" ? ev.audio_start_ms : null;
    }
    if (type === "input_audio_buffer.speech_stopped") {
      const endMs = typeof ev.audio_end_ms === "number" ? ev.audio_end_ms : null;
      if (speechStartMs !== null && endMs !== null && endMs > speechStartMs) {
        committedSeconds += (endMs - speechStartMs) / 1000;
      }
      speechStartMs = null;
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      const t = typeof ev.transcript === "string" ? ev.transcript.trim() : "";
      if (t) heard.push(t);
    }
    // Both shapes, because /live runs in audio mode and /tabletop in text.
    if (
      type === "response.output_audio_transcript.delta" ||
      type === "response.audio_transcript.delta" ||
      type === "response.output_text.delta" ||
      type === "response.text.delta"
    ) {
      if (typeof ev.delta === "string") outputBuffer += ev.delta;
    }
    if (type === "response.done") {
      const response = (ev.response ?? {}) as { usage?: RealtimeUsage };
      const usage = response.usage ?? {};
      const inDetails = usage.input_token_details ?? {};
      const cached = inDetails.cached_tokens_details ?? {};
      const outDetails = usage.output_token_details ?? {};
      turns.push({
        index: turns.length + 1,
        output: outputBuffer.trim(),
        usage,
        audioInTokens: inDetails.audio_tokens ?? 0,
        cachedAudioInTokens: cached.audio_tokens ?? 0,
        textInTokens: inDetails.text_tokens ?? 0,
        cachedTextInTokens: cached.text_tokens ?? 0,
        textOutTokens: outDetails.text_tokens ?? 0,
        audioOutTokens: outDetails.audio_tokens ?? 0
      });
      outputBuffer = "";
    }
    if (type === "error") {
      const err = ev.error as Record<string, unknown> | undefined;
      const message = (err && typeof err.message === "string" && err.message) || "realtime error";
      // A response that fails is fatal to the measurement: a missing turn
      // would quietly flatter whichever arm dropped it.
      fatal = new Error(`Realtime error: ${message}`);
      settleAll(fatal);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    }

    for (const w of [...waiters]) {
      if (w.match(type, ev)) {
        clearTimeout(w.timer);
        waiters.delete(w);
        w.resolve(ev);
      }
    }
  };

  ws.onerror = () => {
    fatal = fatal ?? new Error("WebSocket error");
    settleAll(fatal);
  };
  ws.onclose = (e) => {
    if (waiters.size) {
      settleAll(new Error(`Socket closed (${e.code}) with work outstanding: ${e.reason}`));
    }
  };

  const send = (payload: unknown) => ws.send(JSON.stringify(payload));

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket open timed out")), 20_000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    await waitFor((t) => t === "session.created", 20_000, "session.created");

    // The builder's session, verbatim, plus the audio format the SDP would
    // have negotiated over WebRTC. `model` is already fixed by the URL.
    const { model: _model, ...sessionRest } = opts.session as { model?: string };
    const audio = (sessionRest as { audio?: Record<string, unknown> }).audio ?? {};
    const input = (audio as { input?: Record<string, unknown> }).input ?? {};
    send({
      type: "session.update",
      session: {
        ...sessionRest,
        audio: {
          ...audio,
          input: { ...input, format: { type: "audio/pcm", rate: SAMPLE_RATE } }
        }
      }
    });
    await waitFor((t) => t === "session.updated", 20_000, "session.updated");

    let spokenSeconds = 0;
    for (const [index, utterance] of opts.utterances.entries()) {
      const before = turns.length;
      const patch = opts.beforeUtterance?.(index) ?? null;
      if (patch) {
        send({ type: "session.update", session: patch });
        await waitFor((t) => t === "session.updated", 20_000, `session.updated (turn ${index + 1})`);
      }
      // Register both waiters BEFORE a single byte goes out. Transcription can
      // complete while the trailing silence is still streaming — subscribing
      // afterwards misses it and the run stalls on an event that already
      // happened. (It did, on the first attempt.)
      const transcribed = opts.serverCreatesResponses
        ? null
        : waitFor(
            (t, ev) =>
              t === "conversation.item.input_audio_transcription.completed" &&
              typeof ev.transcript === "string" &&
              /[\p{L}\p{N}]{2,}/u.test(ev.transcript),
            60_000,
            "input transcription"
          );
      const responded = waitFor(() => turns.length > before, 90_000, `response ${before + 1}`);

      const withTail = Buffer.concat([utterance.pcm, silence(trailingSilenceMs)]);
      // 100 ms at a time, paced in real time. Streaming the whole utterance in
      // one burst makes server VAD see a single instantaneous blob and changes
      // where it puts the segment boundaries — which is the very thing being
      // measured.
      const chunkBytes = (SAMPLE_RATE * BYTES_PER_SAMPLE) / 10;
      for (let off = 0; off < withTail.length; off += chunkBytes) {
        if (fatal) throw fatal;
        send({
          type: "input_audio_buffer.append",
          audio: withTail.subarray(off, off + chunkBytes).toString("base64")
        });
        await new Promise((r) => setTimeout(r, 100));
      }
      spokenSeconds += utterance.seconds;

      // The client is the one that asks, on the surfaces minted with
      // create_response:false — exactly as lib/live/ambient.ts does, and only
      // after the transcription confirms real words.
      if (transcribed) {
        await transcribed;
        send({ type: "response.create" });
      }
      await responded;
    }

    return { label: opts.label, turns, spokenSeconds, committedSeconds, heard };
  } finally {
    settleAll(new Error("run finished"));
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * The headline number: billed input audio as a percentage of audio actually
 * spoken. Over 100% is the model re-reading earlier turns. It is a percentage
 * rather than a dollar figure because the trend is the finding — a total over
 * five turns hides whether the per-turn cost is flat or climbing.
 */
export function billedRatio(run: RunResult): number {
  const spokenTokens = run.spokenSeconds * AUDIO_TOKENS_PER_SECOND;
  if (spokenTokens <= 0) return 0;
  const billed = run.turns.reduce((sum, t) => sum + t.audioInTokens, 0);
  return billed / spokenTokens;
}
