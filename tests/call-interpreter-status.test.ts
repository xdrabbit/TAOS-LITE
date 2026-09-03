// The interpreter is not allowed to fail quietly any more.
//
// Tom and Liz, 2026-08-31: relay preflight green, call connected, audio and
// video good, no captions. Finding out why took the production logs, a
// live-fire probe against the real Realtime API and a browser measuring its
// own layout — none of which is available to two people holding phones,
// because lib/call/interpreter.ts reported its state to nobody. A session
// could mint, connect, translate, spend money and hang up, or fail to connect
// at all, and the screen looked identical either way.
//
// The three states below are the ones that used to be indistinguishable from
// "working": a connection that hangs rather than fails, an error that is
// erased by its own cleanup, and a session that is connected and being fed
// silence.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InterpreterState } from "@/lib/call/interpreter";

const requestSpeech = vi.fn();
vi.mock("@/lib/tts/speech", () => ({
  requestSpeech: (...args: unknown[]) => requestSpeech(...args),
  isTextOnlyLanguage: () => false,
  TEXT_ONLY_TITLE: "Text only"
}));

vi.mock("@/lib/authClient", () => ({
  jsonAuthHeaders: async () => ({ "Content-Type": "application/json" }),
  authHeaders: async () => ({})
}));

let dataChannel: {
  readyState: string;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: (() => void) | null;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};
let peer: {
  connectionState: string;
  onconnectionstatechange: (() => void) | null;
  ontrack: ((ev: unknown) => void) | null;
};
/** Set false to make the SDP exchange fail the way a dead provider does. */
let sdpOk = true;

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  vi.useFakeTimers();
  requestSpeech.mockReset();
  sdpOk = true;
  dataChannel = { readyState: "open", onmessage: null, onerror: null, send: vi.fn(), close: vi.fn() };

  const audioEl = {
    muted: false,
    autoplay: false,
    src: "",
    srcObject: null,
    style: {} as Record<string, string>,
    onended: null,
    onerror: null,
    pause: vi.fn(),
    play: vi.fn(async () => undefined),
    load: vi.fn(),
    remove: vi.fn(),
    removeAttribute: vi.fn()
  };

  const g = globalThis as Record<string, unknown>;
  g.document = { createElement: () => audioEl, body: { appendChild: vi.fn() } };
  g.MediaStream = class {
    constructor(public tracks: unknown[] = []) {}
  };
  g.RTCPeerConnection = class {
    onconnectionstatechange: (() => void) | null = null;
    ontrack: ((ev: unknown) => void) | null = null;
    connectionState = "new";
    constructor() {
      peer = this as unknown as typeof peer;
    }
    createDataChannel() {
      return dataChannel;
    }
    addTrack() {}
    async createOffer() {
      return { type: "offer", sdp: "v=0" };
    }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    close() {}
    getSenders() {
      return [];
    }
  };
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:readout";
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = vi.fn();
  g.window = globalThis;

  globalThis.fetch = vi.fn(async (input: unknown) => {
    if (String(input).includes("/api/call/realtime")) {
      return new Response(
        JSON.stringify({
          clientSecret: "ek_test",
          callUrl: "https://api.openai.com/v1/realtime/calls?model=gpt-realtime",
          model: "gpt-realtime",
          voice: "marin",
          mode: "clone"
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return sdpOk
      ? new Response("v=0\r\n", { status: 200 })
      : new Response("upstream is gone", { status: 502 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = ORIGINAL_FETCH;
});

interface Recorded {
  states: InterpreterState[];
  errors: string[];
  hearing: boolean[];
}

async function start(): Promise<{ recorded: Recorded; started: Promise<unknown> }> {
  const { startCallInterpreter } = await import("@/lib/call/interpreter");
  const recorded: Recorded = { states: [], errors: [], hearing: [] };
  const started = startCallInterpreter(
    {
      direction: { source: "es", target: "en" },
      inputTrack: { kind: "audio" } as unknown as MediaStreamTrack,
      voiceMode: "clone"
    },
    {
      onState: (s) => recorded.states.push(s),
      onError: (m) => recorded.errors.push(m),
      onHearing: (h) => recorded.hearing.push(h)
    }
  );
  return { recorded, started };
}

describe("a connection that hangs instead of failing", () => {
  it("gives up out loud after the watchdog rather than waiting forever", async () => {
    const { recorded, started } = await start();
    await started;

    // The provider took the SDP and the peer connection never came up.
    // `onconnectionstatechange` fires "connected" and "failed" and nothing in
    // between, so before the watchdog this state produced no event at all —
    // for the whole call.
    expect(recorded.errors).toEqual([]);

    await vi.advanceTimersByTimeAsync(15_000);

    expect(recorded.errors.length).toBe(1);
    expect(recorded.errors[0]).toContain("could not connect");
    // And the state the screen is left holding is the failure, not "idle".
    expect(recorded.states.at(-1)).toBe("error");
  });

  it("says nothing once the connection is up", async () => {
    const { recorded, started } = await start();
    await started;

    peer.connectionState = "connected";
    peer.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(recorded.errors).toEqual([]);
    expect(recorded.states).toContain("connected");
  });
});

describe("a failure that used to be erased by its own cleanup", () => {
  it("leaves the screen holding \"error\", not \"idle\"", async () => {
    sdpOk = false;
    const { recorded, started } = await start();
    await expect(started).rejects.toThrow();

    // `stop()` runs on the way out of every failure and used to finish by
    // announcing "idle" — so the screen was told the interpreter had failed
    // and then, three lines later, told it was merely not running.
    expect(recorded.errors.length).toBe(1);
    expect(recorded.states.at(-1)).toBe("error");
    expect(recorded.states.at(-1)).not.toBe("idle");
  });

  it("keeps the FIRST reason, which is the cause", async () => {
    sdpOk = false;
    const { recorded, started } = await start();
    await expect(started).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(recorded.errors.length).toBe(1);
    expect(recorded.errors[0]).toContain("502");
  });
});

describe("a session that is connected and being fed silence", () => {
  it("does not claim to be hearing anything until VAD says so", async () => {
    const { recorded, started } = await start();
    await started;
    peer.connectionState = "connected";
    peer.onconnectionstatechange?.();

    // Connected, open, no error — and the partner's forwarded track could be
    // carrying nothing at all. Nothing else the client can see distinguishes
    // this from a healthy call.
    expect(recorded.hearing).toEqual([]);
  });

  it("says so the first time the partner's voice arrives, and only once", async () => {
    const { recorded, started } = await start();
    await started;
    peer.connectionState = "connected";
    peer.onconnectionstatechange?.();

    const speech = () =>
      dataChannel.onmessage?.({
        data: JSON.stringify({ type: "input_audio_buffer.speech_started", audio_start_ms: 0 })
      });
    speech();
    speech();
    speech();

    expect(recorded.hearing).toEqual([true]);
  });
});
