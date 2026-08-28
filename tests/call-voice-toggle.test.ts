// The /call output toggle, driven for real.
//
// Tom's field report (8/28): the output settings "appeared not to work or
// lagged". They did work, eventually — and "eventually" was the bug. The
// toggle changed what the NEXT sentence would do and left the one already in
// the air to finish, so a tap during a six-second translation looked like a
// button that did nothing, and a tap back the other way looked the same
// because the readout it would have restored had already decided not to play.
//
// This file starts a real `startCallInterpreter` against stubbed browser APIs
// and asserts on what the audio element and the TTS service were actually
// told. Source-grepping would have passed against the broken version too:
// the old code set `audioEl.muted = true` on every tap, which reads exactly
// like a control that takes effect immediately and is not one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── The TTS service, as the thing that costs money ─────────────────────────
// A muted call must not reach it at all. The old code asked for the audio and
// then threw it away, which is $0.05 per 1,000 characters for a voice nobody
// can hear, for as long as the call lasts.
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

// ── A browser, in the shape this module uses one ───────────────────────────

interface FakeAudio {
  muted: boolean;
  autoplay: boolean;
  src: string;
  srcObject: unknown;
  style: Record<string, string>;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  pause: ReturnType<typeof vi.fn>;
  play: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  removeAttribute: (name: string) => void;
}

let audioEl: FakeAudio;
let dataChannel: {
  readyState: string;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: (() => void) | null;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

function makeAudio(): FakeAudio {
  const el: FakeAudio = {
    muted: false,
    autoplay: false,
    src: "",
    srcObject: null,
    style: {},
    onended: null,
    onerror: null,
    pause: vi.fn(),
    play: vi.fn(async () => undefined),
    load: vi.fn(),
    remove: vi.fn(),
    removeAttribute: (name: string) => {
      if (name === "src") el.src = "";
    }
  };
  return el;
}

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  requestSpeech.mockReset();
  audioEl = makeAudio();
  dataChannel = {
    readyState: "open",
    onmessage: null,
    onerror: null,
    send: vi.fn(),
    close: vi.fn()
  };

  const g = globalThis as Record<string, unknown>;
  g.document = {
    createElement: () => audioEl,
    body: { appendChild: vi.fn() }
  };
  g.MediaStream = class {
    constructor(public tracks: unknown[] = []) {}
  };
  g.RTCPeerConnection = class {
    onconnectionstatechange: (() => void) | null = null;
    ontrack: ((ev: unknown) => void) | null = null;
    connectionState = "new";
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
  // Patch the two statics onto the real URL — replacing the object outright
  // breaks `new URL(...)`, which Next's Response uses internally.
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:readout";
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = vi.fn();
  // window.setTimeout / clearTimeout are what the module reaches for.
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
    return new Response("v=0\r\n", { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

async function startInterpreter(overrides: Record<string, unknown> = {}) {
  const { startCallInterpreter } = await import("@/lib/call/interpreter");
  const session = await startCallInterpreter(
    {
      direction: { source: "es", target: "en" },
      inputTrack: { kind: "audio" } as unknown as MediaStreamTrack,
      voiceMode: "clone",
      ...overrides
    },
    {}
  );
  return session;
}

/** The event the session sends when a translation has finished generating. */
function translationDone(text: string): void {
  dataChannel.onmessage?.({
    data: JSON.stringify({ type: "response.output_text.done", text })
  });
}

/** Let queued microtasks settle without leaning on fake timers. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("turning the translated voice off", () => {
  it("stops the sentence already playing instead of letting it finish", async () => {
    let releaseSpeech: (blob: Blob) => void = () => {};
    requestSpeech.mockImplementation(
      () => new Promise((resolve) => (releaseSpeech = resolve as (b: Blob) => void))
    );

    const interpreter = await startInterpreter();
    translationDone("The train leaves at four thirty.");
    await settle();

    releaseSpeech(new Blob(["mp3"]));
    await settle();
    // The readout is playing: the element has the blob and was told to play.
    expect(audioEl.src).toBe("blob:readout");
    expect(audioEl.play).toHaveBeenCalled();

    interpreter.setMuted(true);

    // Muting the element alone would leave this mp3 running inaudibly for its
    // full length — silent, but still holding the response gate, so the next
    // translation waits behind a sentence nobody can hear.
    expect(audioEl.muted).toBe(true);
    expect(audioEl.pause).toHaveBeenCalled();
    expect(audioEl.src).toBe("");
  });

  it("stops paying for a voice nobody can hear", async () => {
    requestSpeech.mockResolvedValue(new Blob(["mp3"]));

    const interpreter = await startInterpreter();
    interpreter.setMuted(true);

    translationDone("Tenemos como una hora.");
    await settle();

    // Not "asked and discarded" — never asked. ElevenLabs bills by the
    // character whether or not the blob is played.
    expect(requestSpeech).not.toHaveBeenCalled();
  });

  it("drops a readout that was still being synthesised when the tap landed", async () => {
    let releaseSpeech: (blob: Blob) => void = () => {};
    requestSpeech.mockImplementation(
      () => new Promise((resolve) => (releaseSpeech = resolve as (b: Blob) => void))
    );

    const interpreter = await startInterpreter();
    translationDone("Nos vemos el domingo.");
    await settle();

    // The tap happens while the sentence is still in the air at the TTS
    // service. Without the generation check it would arrive a second later
    // and start playing — after the button that turned it off.
    interpreter.setMuted(true);
    releaseSpeech(new Blob(["mp3"]));
    await settle();

    expect(audioEl.src).toBe("");
    expect(audioEl.play).not.toHaveBeenCalled();
  });
});

describe("turning it back on", () => {
  it("speaks the very next utterance", async () => {
    requestSpeech.mockResolvedValue(new Blob(["mp3"]));

    const interpreter = await startInterpreter({ muted: true });
    translationDone("Uno.");
    await settle();
    expect(requestSpeech).not.toHaveBeenCalled();

    interpreter.setMuted(false);
    translationDone("Dos.");
    await settle();

    expect(requestSpeech).toHaveBeenCalledTimes(1);
    expect(audioEl.muted).toBe(false);
    expect(audioEl.play).toHaveBeenCalled();
  });

  it("ignores a tap that changes nothing", async () => {
    requestSpeech.mockResolvedValue(new Blob(["mp3"]));
    const interpreter = await startInterpreter();

    interpreter.setMuted(false);
    // No teardown, no generation bump, nothing to undo — an idempotent set
    // must not cancel a readout that is happily playing.
    expect(audioEl.pause).not.toHaveBeenCalled();
  });
});

describe("the model's own voice, in 'instant' mode", () => {
  it("asks the server to drop the speech it has already queued", async () => {
    const interpreter = await startInterpreter({ voiceMode: "instant" });

    // The model is speaking: its audio is in the session's output buffer, not
    // in the element, so no element property can stop it mid-word.
    dataChannel.onmessage?.({ data: JSON.stringify({ type: "output_audio_buffer.started" }) });
    interpreter.setMuted(true);

    const sent = dataChannel.send.mock.calls.map((c) => JSON.parse(String(c[0])).type);
    expect(sent).toContain("output_audio_buffer.clear");
  });

  it("does not tear down the element that is rendering the live track", async () => {
    const interpreter = await startInterpreter({ voiceMode: "instant" });
    dataChannel.onmessage?.({ data: JSON.stringify({ type: "output_audio_buffer.started" }) });
    interpreter.setMuted(true);

    // In instant mode the element carries a WebRTC track. load() would reset
    // it and there would be nothing to restore it from — unmuting would
    // produce permanent silence for the rest of the call.
    expect(audioEl.load).not.toHaveBeenCalled();
    interpreter.setMuted(false);
    expect(audioEl.muted).toBe(false);
  });
});
