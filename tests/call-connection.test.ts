// Why a call that "initiates" never connects.
//
// Field report 2026-08-31, Tom and Liz, two real phones: /call visible to
// both, the call starting, and no connection — ever, with no error. Reading
// lib/call/session.ts turned up three separate causes, and only the first is
// about NAT. The other two are why the failure was silent, and why it looked
// like one bug instead of three.
//
// This file drives the real `startCall` against a stubbed browser, because
// each of these passes a source-grep in its broken form. The old code DID
// call `restartIce()`, DID have an error message next to it, and DID call
// `addIceCandidate` — it just never reached the message and threw the
// candidates away. Only running it shows that.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authClient", () => ({
  authHeaders: async () => ({}),
  jsonAuthHeaders: async () => ({ "Content-Type": "application/json" })
}));

// ── The signaling channel, in the shape lib/call/session.ts uses one ───────
type Handler = (payload: unknown) => void;
let signalHandler: Handler | null = null;
let presenceHandler: Handler | null = null;
let presence: Record<string, unknown> = {};
let sent: Array<{ event: string; payload: Record<string, unknown> }> = [];

const channel = {
  on(type: string, opts: { event?: string }, cb: Handler) {
    if (type === "broadcast") signalHandler = cb;
    if (type === "presence" && opts.event === "sync") presenceHandler = cb;
    return channel;
  },
  subscribe(cb: (status: string) => void) {
    cb("SUBSCRIBED");
    return channel;
  },
  track: vi.fn(async () => {}),
  presenceState: () => presence,
  send: vi.fn(async (msg: { event: string; payload: Record<string, unknown> }) => {
    sent.push(msg);
  }),
  topic: "taos-call-TEST1"
};

vi.mock("@/lib/supabase", () => ({
  supabase: {
    channel: () => channel,
    getChannels: () => [],
    removeChannel: async () => {}
  }
}));

// ── The peer connection, as an observable ─────────────────────────────────
interface FakePeer {
  accepted: unknown[];
  iceServers: RTCIceServer[];
  connectionState: string;
  iceConnectionState: string;
  iceGatheringState: string;
  signalingState: string;
  remoteDescription: unknown;
  localDescription: unknown;
  restartIce: ReturnType<typeof vi.fn>;
  addIceCandidate: ReturnType<typeof vi.fn>;
  onconnectionstatechange: (() => void) | null;
  [key: string]: unknown;
}

let peers: FakePeer[] = [];
/** The connection the code is currently driving. */
const peer = (): FakePeer => peers[peers.length - 1];

/** Push a connectionState and fire the handler, as a browser would. */
function drive(state: string): void {
  const p = peer();
  p.connectionState = state;
  p.onconnectionstatechange?.();
}

const MINTED_TURN = {
  iceServers: [
    { urls: ["stun:stun.cloudflare.com:3478"] },
    {
      urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
      username: "minted-user",
      credential: "minted-secret"
    }
  ],
  relay: true,
  ttlSeconds: 3600
};

let iceReply: unknown = MINTED_TURN;
let iceStatus = 200;

beforeEach(() => {
  signalHandler = null;
  presenceHandler = null;
  presence = {};
  sent = [];
  peers = [];
  iceReply = MINTED_TURN;
  iceStatus = 200;

  const g = globalThis as Record<string, unknown>;
  g.window = globalThis;
  (globalThis as Record<string, unknown>).isSecureContext = true;

  g.document = {
    createElement: () => ({
      play: async () => {},
      pause: () => {},
      remove: () => {},
      style: {} as Record<string, string>,
      muted: false,
      volume: 1,
      srcObject: null
    }),
    body: { appendChild: vi.fn() }
  };

  g.MediaStream = class {
    tracks: unknown[];
    constructor(tracks: unknown[] = []) {
      this.tracks = tracks;
    }
    getTracks() {
      return this.tracks;
    }
    getAudioTracks() {
      return this.tracks;
    }
    getVideoTracks() {
      return [];
    }
  };

  // `navigator` is a getter-only property on the Node global, so it has to be
  // redefined rather than assigned.
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () =>
          new (g.MediaStream as new (t: unknown[]) => unknown)([
            { kind: "audio", enabled: true, stop: () => {} }
          ])
      }
    }
  });

  g.RTCPeerConnection = class {
    connectionState = "new";
    iceConnectionState = "new";
    iceGatheringState = "new";
    signalingState = "stable";
    remoteDescription: unknown = null;
    localDescription: unknown = { type: "offer", sdp: "v=0" };
    onconnectionstatechange: (() => void) | null = null;
    oniceconnectionstatechange: (() => void) | null = null;
    onicegatheringstatechange: (() => void) | null = null;
    onicecandidateerror: ((ev: unknown) => void) | null = null;
    onicecandidate: ((ev: unknown) => void) | null = null;
    onnegotiationneeded: (() => void) | null = null;
    ontrack: ((ev: unknown) => void) | null = null;
    iceServers: RTCIceServer[];
    restartIce = vi.fn();
    /**
     * The candidates ICE actually got to keep.
     *
     * This is the distinction bug 3 turns on, and asserting on call COUNT
     * misses it entirely: the old code called addIceCandidate for every
     * candidate too. It just called it too early, caught the throw, and moved
     * on — so the call happened and the candidate was still gone.
     */
    accepted: unknown[] = [];
    // Faithful to a real browser: this THROWS when there is no remote
    // description yet. A forgiving stub would let the old code pass.
    addIceCandidate = vi.fn(async (candidate: unknown) => {
      if (!this.remoteDescription) {
        throw new DOMException("The remote description was null", "InvalidStateError");
      }
      this.accepted.push(candidate);
    });
    constructor(config?: { iceServers?: RTCIceServer[] }) {
      this.iceServers = config?.iceServers ?? [];
      peers.push(this as unknown as FakePeer);
    }
    addTrack() {}
    async setLocalDescription() {}
    async setRemoteDescription(d: unknown) {
      this.remoteDescription = d;
    }
    async getStats() {
      return new Map();
    }
    close() {}
    getSenders() {
      return [];
    }
  };

  globalThis.fetch = vi.fn(async (input: unknown) => {
    if (String(input).includes("/api/call/ice")) {
      return new Response(JSON.stringify(iceReply), {
        status: iceStatus,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

interface Seen {
  states: string[];
  errors: string[];
  relay: boolean | null;
  diagnostics: string[];
}

/**
 * Start a call and put a partner in the room.
 *
 * `partner` sorts after any UUID, so this phone is always the POLITE one —
 * the side that accepts an incoming offer rather than ignoring it, which is
 * the side whose candidate handling the field report exercised.
 */
async function joinWithPartner(partner = "zzzz-partner"): Promise<Seen> {
  const { startCall } = await import("@/lib/call/session");
  const seen: Seen = { states: [], errors: [], relay: null, diagnostics: [] };
  await startCall(
    { room: "TEST1", video: false, language: "en" },
    {
      onState: (s) => seen.states.push(s),
      onError: (m) => seen.errors.push(m),
      onRelayAvailable: (r) => {
        seen.relay = r;
      },
      onDiagnostic: (line) => seen.diagnostics.push(line)
    }
  );
  presence = { [partner]: [{}] };
  presenceHandler?.({});
  return seen;
}

/** Deliver a signal from the partner, as the broadcast channel would. */
function fromPartner(kind: string, data: unknown, from = "zzzz-partner"): void {
  signalHandler?.({ payload: { from, kind, data } });
}

describe("bug 1 — there was no relay to fall back to", () => {
  it("builds the peer connection with the minted TURN server", async () => {
    // The whole fix. Before this, getIceServers() returned one public Google
    // STUN server and nothing else, so two phones behind carrier NAT had no
    // path to find and ICE simply ran out of pairs.
    const seen = await joinWithPartner();
    expect(peer().iceServers).toEqual(MINTED_TURN.iceServers);
    expect(seen.relay).toBe(true);
  });

  it("still places a STUN-only call when no relay could be minted", async () => {
    // Production as of 2026-08-31 has no Cloudflare key. /call must keep
    // making the calls it can already make; losing the relay degrades the
    // hard pairings, it does not break the easy ones.
    iceStatus = 500;
    iceReply = { error: "nope" };
    const seen = await joinWithPartner();
    expect(seen.relay).toBe(false);
    expect(peer().iceServers).toEqual([{ urls: "stun:stun.l.google.com:19302" }]);
    expect(seen.states).toContain("connecting");
  });

  it("mints once per join, not once per peer rebuild", async () => {
    // The credential outlives the call. Re-minting on every reconnect would
    // spend a round trip at the exact moment the network is already bad.
    await joinWithPartner();
    const before = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    presence = {};
    presenceHandler?.({});
    presence = { "zzzz-partner": [{}] };
    presenceHandler?.({});
    expect(peers.length).toBeGreaterThan(1);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
  });
});

describe("bug 2 — a doomed connection retried forever, silently", () => {
  it("restarts ICE once, then fails with a message", async () => {
    // The old code called restartIce() inside a try whose catch held the
    // only error message. restartIce() does not throw for a restart that is
    // about to fail — it succeeds, ICE fails again, and the handler restarted
    // it again. So the catch was unreachable and "reconnecting…" was
    // terminal. This is exactly what Tom and Liz sat looking at.
    const seen = await joinWithPartner();
    drive("failed");
    expect(peer().restartIce).toHaveBeenCalledTimes(1);
    expect(seen.errors).toHaveLength(0);

    drive("failed");
    expect(peer().restartIce).toHaveBeenCalledTimes(1);
    expect(seen.errors).toHaveLength(1);
    expect(seen.states.at(-1)).toBe("error");
  });

  it("says something a person can act on, in both languages", async () => {
    // Two people on one call who read different languages, each looking at
    // their own phone. "Connection failed" also tells neither of them what
    // to do; switching to wifi is the thing that actually works.
    const seen = await joinWithPartner();
    drive("failed");
    drive("failed");
    const message = seen.errors[0];
    expect(message).toContain("Could not connect");
    expect(message).toContain("wifi");
    expect(message).toContain("No se pudo conectar");
    expect(message).toContain("teléfonos");
  });

  it("gives up on a connection that simply never connects", async () => {
    // The other half of the silence: ICE that never reaches "failed" — it
    // just sits in "checking" while candidate pairs time out. There was no
    // timeout at all, so this state had no exit.
    vi.useFakeTimers();
    const seen = await joinWithPartner();
    expect(seen.errors).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(seen.errors).toHaveLength(1);
    expect(seen.states.at(-1)).toBe("error");
  });

  it("does not fire the watchdog on a call that connected", async () => {
    vi.useFakeTimers();
    const seen = await joinWithPartner();
    drive("connected");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen.errors).toHaveLength(0);
    expect(seen.states).toContain("connected");
  });
});

describe("bug 3 — trickled candidates were thrown away", () => {
  it("queues a candidate that arrives before the remote description", async () => {
    // addIceCandidate throws when there is no remote description yet, and the
    // old catch swallowed it as "stale candidate after a rollback". It
    // usually was not stale: the answerer applies the offer and immediately
    // starts trickling, so its candidates race its answer down the same
    // broadcast channel. Any that won the race were lost — and on a hard
    // network the lost one is the relay candidate.
    await joinWithPartner();
    const candidate = { candidate: "candidate:1 1 udp 2 1.2.3.4 1 typ relay", sdpMid: "0" };
    fromPartner("candidate", candidate);
    await Promise.resolve();
    // Held, not offered to a connection that would reject it.
    expect(peer().accepted).toEqual([]);

    fromPartner("description", { type: "offer", sdp: "v=0" });
    await vi.waitFor(() => expect(peer().accepted).toEqual([candidate]));
  });

  it("keeps every early candidate, in order", async () => {
    await joinWithPartner();
    const host = { candidate: "typ host", sdpMid: "0" };
    const srflx = { candidate: "typ srflx", sdpMid: "0" };
    const relay = { candidate: "typ relay", sdpMid: "0" };
    fromPartner("candidate", host);
    fromPartner("candidate", srflx);
    fromPartner("candidate", relay);
    fromPartner("description", { type: "offer", sdp: "v=0" });
    // The relay candidate is the one that connects a carrier-NAT pair. Under
    // the old code all three were "added" and all three were dropped.
    await vi.waitFor(() => expect(peer().accepted).toEqual([host, srflx, relay]));
  });

  it("applies a candidate directly once the description is in place", async () => {
    await joinWithPartner();
    fromPartner("description", { type: "offer", sdp: "v=0" });
    await vi.waitFor(() => expect(peer().remoteDescription).toBeTruthy());
    const late = { candidate: "typ host", sdpMid: "0" };
    fromPartner("candidate", late);
    await vi.waitFor(() => expect(peer().accepted).toEqual([late]));
  });
});

describe("the diagnostics that make the next failure readable", () => {
  it("records the ICE servers, the candidate types, and the verdict", async () => {
    const seen = await joinWithPartner();
    expect(seen.diagnostics.some((l) => l.includes("relay_available=true"))).toBe(true);

    // A candidate error is how a rejected TURN credential announces itself;
    // ICE otherwise proceeds quietly without a relay candidate, and the
    // failure is indistinguishable from "this network has no path".
    const onCandidateError = peer().onicecandidateerror as (ev: unknown) => void;
    onCandidateError({
      errorCode: 401,
      url: "turn:turn.cloudflare.com:3478",
      errorText: "Unauthorized"
    });
    expect(seen.diagnostics.some((l) => l.includes("candidate_error code=401"))).toBe(true);

    drive("failed");
    drive("failed");
    expect(seen.diagnostics.some((l) => l.startsWith("connect_failed"))).toBe(true);
  });
});
