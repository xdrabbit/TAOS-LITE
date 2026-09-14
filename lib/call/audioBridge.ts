"use client";

// One AudioContext for a call, and the bridge the interpreter listens through.
//
// ── The 2026-09-03 field report ────────────────────────────────────────────
// Two iPhones, Safari, Wi-Fi ↔ cellular. Both people heard each other's real
// voice perfectly, so the peer connection and the relay were both fine. Both
// interpreters minted, connected, and then said nothing at all: no responses,
// no usage POST, no error — just dead air until the idle timer.
//
// What /call did was hand the track it received from the CALL peer connection
// straight to `addTrack` on the INTERPRETER peer connection. On WebKit a
// received `MediaStreamTrack` re-sent that way carries silence: the frames
// arrive at the first connection and the second one sends an empty stream.
// Nothing throws. Server VAD hears nothing, so it commits nothing, so with
// `create_response: false` there is nothing to respond to, forever.
//
// Routing the track through WebAudio — source → destination node — produces a
// LOCALLY GENERATED track, which is a thing Safari does send. That is the
// whole fix. The cause is inferred from the symptom and from what WebKit is
// known to do here, not measured on the phone, which is why the interpreter
// also grew input telemetry in the same change: `interp in level=…` on the
// trail is what will actually confirm or refute it.
//
// ── Why the context is shared ──────────────────────────────────────────────
// iOS will not start an AudioContext outside a user gesture, and neither the
// interpreter (started from `ontrack`) nor the ducking graph in session.ts is
// in one. The Join tap is. So there is exactly one context per call, created
// and resumed inside that tap by CallShell, and both the ducking gain and the
// interpreter bridge hang off it. A second context built later is a context
// that stays suspended on the one platform this bug is about.

let sharedCtx: AudioContext | null = null;

function contextCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  return (
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ??
    null
  );
}

/**
 * The call's AudioContext, created on first use and resumed every time.
 *
 * Call this from inside the Join/answer tap at least once — that is the only
 * moment WebKit will let it start. Later calls are cheap and idempotent, and
 * the `resume()` on each one is what recovers a context iOS suspended when
 * the phone locked mid-call.
 */
export function ensureCallAudioContext(): AudioContext | null {
  if (sharedCtx && sharedCtx.state !== "closed") {
    if (sharedCtx.state === "suspended") {
      void sharedCtx.resume().catch(() => {
        /* resumes on the next gesture */
      });
    }
    return sharedCtx;
  }
  const Ctor = contextCtor();
  if (!Ctor) return null;
  try {
    sharedCtx = new Ctor();
  } catch {
    sharedCtx = null;
    return null;
  }
  void sharedCtx.resume().catch(() => {
    /* created outside a gesture; the next ensure() will try again */
  });
  return sharedCtx;
}

/** Hang-up. Nothing on the call may still be holding a node off this. */
export function closeCallAudioContext(): void {
  const ctx = sharedCtx;
  sharedCtx = null;
  if (!ctx) return;
  void ctx.close().catch(() => {
    /* already closed */
  });
}

export interface InterpreterInputBridge {
  /** The stream to hand to `addTrack` — locally generated, so Safari sends it. */
  stream: MediaStream;
  track: MediaStreamTrack;
  /**
   * How far this graph's clock has fallen behind wall time since the bridge
   * was built, in ms — `audio_arrival_ms` in lib/call/lag.ts. Null where the
   * context exposes no clock.
   */
  clockDriftMs: () => number | null;
  /** Drop the nodes. Never touches the partner's own track. */
  release: () => void;
}

/**
 * Re-originate a received audio track so it can be sent on a second peer
 * connection.
 *
 * Returns null when there is no WebAudio to do it with, and the caller falls
 * back to the raw track: a browser without an AudioContext is not a browser
 * with this bug, and half an interpreter beats none.
 */
export function bridgeInterpreterInput(
  track: MediaStreamTrack
): InterpreterInputBridge | null {
  const ctx = ensureCallAudioContext();
  if (
    !ctx ||
    typeof ctx.createMediaStreamSource !== "function" ||
    typeof ctx.createMediaStreamDestination !== "function"
  ) {
    return null;
  }
  try {
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const destination = ctx.createMediaStreamDestination();
    source.connect(destination);
    const bridged = destination.stream.getAudioTracks()[0];
    if (!bridged) {
      source.disconnect();
      return null;
    }

    // The graph's own timeline — `currentTime` advances by rendered sample
    // frames — against `performance.now()`. A context that stalls, glitches or
    // gets suspended by iOS stops advancing while wall time does not, and the
    // gap between the two is audio the bridge is holding rather than sending.
    // Baselined at the first reading taken while the context is RUNNING, so a
    // context still waking up from the Join tap does not start the call owing.
    //
    // What this cannot see: a queue building inside the source node without
    // the render clock slowing down. `vad_lag_ms` and `heard_ms` (lib/call/
    // lag.ts) are end-to-end and do see that, which is why they ride along.
    let baseline: { ctxMs: number; wallMs: number } | null = null;
    const clockDriftMs = (): number | null => {
      if (typeof ctx.currentTime !== "number" || typeof performance === "undefined") return null;
      const ctxMs = ctx.currentTime * 1000;
      const wallMs = performance.now();
      if (!baseline) {
        if (ctx.state !== "running") return null;
        baseline = { ctxMs, wallMs };
        return 0;
      }
      return wallMs - baseline.wallMs - (ctxMs - baseline.ctxMs);
    };
    clockDriftMs();

    return {
      stream: destination.stream,
      track: bridged,
      clockDriftMs,
      release: () => {
        try {
          source.disconnect();
        } catch {
          /* ignore */
        }
        try {
          destination.disconnect();
        } catch {
          /* ignore */
        }
        // This track was minted here, so stopping it stops nothing the human
        // listener needs — unlike the partner's track, which must keep going.
        destination.stream.getTracks().forEach((t) => t.stop());
      }
    };
  } catch {
    return null;
  }
}
