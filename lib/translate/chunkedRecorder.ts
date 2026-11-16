// One turn, several recordings: the home recorder, rolled.
//
// The home mic is a plain MediaRecorder (lib/translate/recorder.ts has why
// that is the one microphone that works on an iPhone). A long turn keeps it
// plain: when a chunk reaches its length, the current recorder is stopped
// and a NEW one is started on the SAME MediaStream in the same task — no new
// getUserMedia, no AudioContext, no second permission prompt, nothing WebKit
// treats differently from the first recorder of the turn. Every chunk is
// therefore a complete file with its own container header, which is what
// lets the server transcribe it on its own.
//
// The seam costs the audio between one encoder stopping and the next
// starting. Measured in Chrome with a swept tone through the real
// MediaRecorder (tests/live-fire/chunk-boundary-browser-check.mjs); the
// number is in the PR. The words on either side of it are stitched in order
// and translated as one text, so a syllable clipped at the seam costs a
// word, not a thought.
//
// If the next recorder cannot be started (a phone that refuses a second
// MediaRecorder mid-session), the turn simply ends there and goes through
// the normal flow with everything captured so far — never a dead button.
//
// This file owns no timers. The owner asks `shouldRoll()` on its own tick —
// the same tick that enforces the turn cap — so there is one clock to lose,
// not two.

export interface RecordedChunk {
  /** 0 for the first chunk of the turn. */
  index: number;
  blob: Blob;
  /** How long this chunk recorded, by the phone's clock. */
  ms: number;
  /** True for the chunk that ends the turn. */
  final: boolean;
}

export interface ChunkedRecorderOptions {
  stream: MediaStream;
  /** "" lets the browser choose. */
  mime: string;
  bitsPerSecond: number;
  /** A chunk's longest recording, ms. */
  chunkMs: number;
  /** Each chunk, in order, once its recorder has flushed. */
  onChunk: (chunk: RecordedChunk) => void;
  /** A recorder error mid-turn; the owner finishes the turn. */
  onError?: (event: Event) => void;
  now?: () => number;
  /** For tests: the MediaRecorder constructor. */
  Recorder?: typeof MediaRecorder;
}

export interface ChunkedRecorder {
  start(): void;
  /** End the turn; the last chunk arrives through onChunk with final=true. */
  stop(): void;
  /** Is the current chunk at its length? */
  shouldRoll(): boolean;
  /**
   * Close the current chunk and open the next. False when the next recorder
   * could not be started — the turn has then ended, and the chunk just
   * closed is delivered as the final one.
   */
  roll(): boolean;
  /** "inactive" before start and after stop. */
  readonly state: "inactive" | "recording";
  /** How many chunks have been opened so far. */
  readonly chunkCount: number;
}

export function createChunkedRecorder(options: ChunkedRecorderOptions): ChunkedRecorder {
  const now = options.now ?? (() => performance.now());
  const Recorder = options.Recorder ?? MediaRecorder;
  let current: MediaRecorder | null = null;
  let currentStartedAt = 0;
  let opened = 0;
  let state: "inactive" | "recording" = "inactive";
  // How each open recorder is told, before stop(), whether it ends the turn.
  const closers = new WeakMap<MediaRecorder, (final: boolean) => void>();

  function open(): MediaRecorder {
    const opts: MediaRecorderOptions = { audioBitsPerSecond: options.bitsPerSecond };
    if (options.mime) opts.mimeType = options.mime;
    const recorder = new Recorder(options.stream, opts);
    const index = opened;
    const parts: Blob[] = [];
    const startedAt = now();
    let stoppedAt: number | null = null;
    let endsTurn = false;
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) parts.push(ev.data);
    };
    recorder.onerror = (ev) => options.onError?.(ev);
    recorder.onstop = () => {
      options.onChunk({
        index,
        blob: new Blob(parts, { type: options.mime || recorder.mimeType || "audio/webm" }),
        ms: (stoppedAt ?? now()) - startedAt,
        final: endsTurn
      });
    };
    // Marked before stop() is called, so onstop (a later task) knows.
    closers.set(recorder, (final) => {
      endsTurn = final;
      stoppedAt = stoppedAt ?? now();
    });
    // Flush every second so a long chunk is never one fragile buffer that a
    // suspended page could lose whole.
    recorder.start(1000);
    opened += 1;
    currentStartedAt = startedAt;
    return recorder;
  }

  function close(recorder: MediaRecorder, final: boolean): void {
    closers.get(recorder)?.(final);
    if (recorder.state !== "inactive") recorder.stop();
  }

  return {
    start() {
      if (state === "recording") return;
      current = open();
      state = "recording";
    },
    stop() {
      const recorder = current;
      current = null;
      state = "inactive";
      if (recorder) close(recorder, true);
    },
    shouldRoll() {
      return state === "recording" && now() - currentStartedAt >= options.chunkMs;
    },
    roll() {
      const previous = current;
      if (!previous || state !== "recording") return false;
      // Stop, then start, in one task: the gap is the encoder's turnaround
      // and nothing else.
      close(previous, false);
      try {
        current = open();
        return true;
      } catch {
        // No later chunk is coming, so the one just closed ends the turn. Its
        // onstop has not run yet (it is dispatched as a later task), so it
        // still reads this.
        closers.get(previous)?.(true);
        current = null;
        state = "inactive";
        return false;
      }
    },
    get state() {
      return state;
    },
    get chunkCount() {
      return opened;
    }
  };
}
