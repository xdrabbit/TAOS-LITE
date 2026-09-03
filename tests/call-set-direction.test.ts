// Re-pointing the interpreter before its data channel can carry the message.
//
// `setDirection` assigned the local direction FIRST and only then checked
// whether the channel was open — and if it was not, the `session.update`
// simply fell on the floor with no retry. There is a real window for that:
// the ~1s between asking for a realtime session and having one, which is
// exactly when a person who just joined a call is fiddling with the pills.
// The result was a session still running its ORIGINAL instructions while this
// phone believed it had moved, forever — silent, and indistinguishable from
// a model ignoring its prompt.
//
// Found alongside the 9/3 pill-flip report (the flip is what made a
// mid-connect re-point so easy to trigger). Fixed by moving the local
// assignment behind a successful send, and parking the change until the
// channel opens.
//
// The harness is tests/call-voice-toggle.test.ts's: a real
// `startCallInterpreter` against a stubbed browser, asserting on what the data
// channel was actually HANDED. Asserting that setDirection was called would
// have passed against the broken version too.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tts/speech", () => ({
  requestSpeech: vi.fn(),
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
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  dataChannel = {
    // Not open yet: the state a phone is in for the first second of a call.
    readyState: "connecting",
    onmessage: null,
    onopen: null,
    onerror: null,
    send: vi.fn(),
    close: vi.fn()
  };

  const g = globalThis as Record<string, unknown>;
  g.document = { createElement: () => makeAudio(), body: { appendChild: vi.fn() } };
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
    return new Response("v=0\r\n", { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function makeAudio() {
  return {
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
}

async function startInterpreter() {
  const { startCallInterpreter } = await import("@/lib/call/interpreter");
  return startCallInterpreter(
    {
      direction: { source: "es", target: "en" },
      inputTrack: { kind: "audio" } as unknown as MediaStreamTrack,
      voiceMode: "clone"
    },
    {}
  );
}

/** Every `session.update` the channel was handed, newest last. */
function sessionUpdates(): string[] {
  return dataChannel.send.mock.calls
    .map((c) => String(c[0]))
    .filter((body) => body.includes('"session.update"'));
}

describe("re-pointing a session whose channel is not open yet", () => {
  it("does not drop the update on the floor", async () => {
    const interpreter = await startInterpreter();

    // Tom picks Italian a beat after Join, while the session is still being
    // minted. The old code returned here having already moved `direction`.
    interpreter.setDirection({ source: "it", target: "en" });
    expect(sessionUpdates()).toHaveLength(0);

    // The channel opens. The parked change goes out with it.
    dataChannel.readyState = "open";
    dataChannel.onopen?.();

    const updates = sessionUpdates();
    expect(updates).toHaveLength(1);
    // Not "an update was sent" — an update carrying the language he picked.
    // buildCallInterpreterInstructions names both ends in full.
    expect(updates[0]).toContain("Italian");
    expect(updates[0]).toContain("English");
  });

  it("sends only the LAST direction when several land before it opens", async () => {
    const interpreter = await startInterpreter();

    interpreter.setDirection({ source: "it", target: "en" });
    interpreter.setDirection({ source: "fr", target: "en" });

    dataChannel.readyState = "open";
    dataChannel.onopen?.();

    const updates = sessionUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain("French");
    expect(updates[0]).not.toContain("Italian");
  });

  it("goes straight out when the channel is already open", async () => {
    dataChannel.readyState = "open";
    const interpreter = await startInterpreter();

    interpreter.setDirection({ source: "it", target: "en" });

    expect(sessionUpdates()).toHaveLength(1);
    expect(sessionUpdates()[0]).toContain("Italian");

    // ...and nothing is left parked to fire a second time on open.
    dataChannel.onopen?.();
    expect(sessionUpdates()).toHaveLength(1);
  });

  it("keeps the parked change if the channel throws on the way out", async () => {
    dataChannel.readyState = "open";
    const interpreter = await startInterpreter();
    // An open-but-closing channel: readyState still says "open" and send
    // throws. The local direction must not move on that either.
    dataChannel.send.mockImplementationOnce(() => {
      throw new Error("closing");
    });

    interpreter.setDirection({ source: "it", target: "en" });
    // The attempt is recorded by the spy and then throws, so it never left
    // the phone. What matters is that the change was PARKED rather than
    // counted as delivered.
    expect(sessionUpdates()).toHaveLength(1);

    // A channel that reopens gets it again — this is the retry the old code
    // had nowhere to put.
    dataChannel.onopen?.();
    expect(sessionUpdates()).toHaveLength(2);
    expect(sessionUpdates()[1]).toContain("Italian");
  });
});
