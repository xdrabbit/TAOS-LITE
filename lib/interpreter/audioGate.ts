// The gate in front of a socket leg's speaker. Pure — no browser in it — so
// the tests and the live-fire probe run the very gate the phone runs
// (lib/interpreter/client.ts wraps its PCM player in one).
//
// A leg told to keep quiet for one of the two languages still SENDS something
// for it — wordless frames, the sound of a `<no speech>`, a cascade's echo —
// so, on a two-leg table, audio is HELD until the reader says the response has
// words (LegSink.gate) and thrown away if it ends without any
// (LegSink.responseSilent). On a one-leg table nothing is held.

export interface GateOutput<Chunk> {
  play: (chunk: Chunk) => void;
  flush: () => void;
}

export interface AudioGate<Chunk> {
  play: (chunk: Chunk) => void;
  setAudible: (open: boolean) => void;
  dropHeld: () => void;
  /** A new response begins: shut the gate again. */
  rearm: () => void;
  flush: () => void;
}

export interface AudioGateHooks {
  /** The gate opened for a response. */
  onOpen?: () => void;
  /** Held audio was thrown away unplayed — a COUNT of bytes, nothing else. */
  onDropped?: (bytes: number) => void;
}

/** ~20 s of 24 kHz s16 — far past any real lead of audio over its words. */
export const GATE_MAX_HELD_BYTES = 960_000;

export function createAudioGate<Chunk extends { length: number }>(
  out: GateOutput<Chunk>,
  startHeld: boolean,
  hooks: AudioGateHooks = {}
): AudioGate<Chunk> {
  let audible = !startHeld;
  let held: Chunk[] = [];
  let heldBytes = 0;
  const dropHeld = () => {
    if (heldBytes > 0) hooks.onDropped?.(heldBytes);
    held = [];
    heldBytes = 0;
  };
  return {
    play: (chunk) => {
      if (audible) {
        out.play(chunk);
        return;
      }
      held.push(chunk);
      heldBytes += chunk.length;
      while (heldBytes > GATE_MAX_HELD_BYTES && held.length > 1) heldBytes -= held.shift()!.length;
    },
    setAudible: (open) => {
      if (!startHeld) return;
      if (open && !audible) hooks.onOpen?.();
      audible = open;
      if (open) {
        for (const chunk of held) out.play(chunk);
        held = [];
        heldBytes = 0;
      }
    },
    dropHeld,
    rearm: () => {
      if (!startHeld) return;
      audible = false;
      dropHeld();
    },
    flush: () => {
      dropHeld();
      out.flush();
    }
  };
}
