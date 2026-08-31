// The "Test connection · Probar conexión" button, and what it is allowed to
// claim.
//
// ── Why a button, when a harness already exists ────────────────────────────
// tests/live-fire/call-relay-check.mjs proves the relay path by spawning
// Chrome over CDP and forcing two peer connections through TURN. It is the
// strongest evidence /call has (207 ms, relay/relay, against real Cloudflare
// on 2026-08-31). It is also a node script on a laptop, and the founders are
// not at a laptop when a call fails — they are holding two phones in two
// rooms, which is how every relay test since PR #52 has been run.
//
// lib/call/relayProbe.ts is that harness with the terminal removed. This file
// is the fence around the four claims it makes, because each of them is the
// kind of thing that quietly stops being true:
//
//   1. The probe is RELAY-ONLY. Without `iceTransportPolicy: "relay"` both
//      ends are the same phone and would connect over loopback every time —
//      a green light that proves nothing and would have been green all
//      through the outage.
//   2. It never touches the microphone. A preflight is tapped idly in a
//      lobby, and on iOS a getUserMedia inside it burns the user gesture the
//      real Join tap needs (the /fast WebKit AudioContext bug, again).
//   3. "Minted" and "allocated" are DIFFERENT verdicts. A credential
//      Cloudflare happily mints can still be refused by the TURN server at
//      allocate time, which no server-side check can see and which looks
//      like "connecting…" forever on a phone.
//   4. It never reports `ok` for a connection that did not go through the
//      relay.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authClient", () => ({
  authHeaders: async () => ({}),
  jsonAuthHeaders: async () => ({ "Content-Type": "application/json" })
}));

// ── A pair of peer connections, as observable as the real thing ───────────
//
// The scenario decides what ICE does, because that is the only variable this
// probe reads. Everything else — offer, answer, trickle — is the same in
// every run and is modelled faithfully so the probe's own sequencing is under
// test rather than stubbed around.
type Scenario =
  | "relay" // TURN allocates; the two ends pair on relay/relay
  | "refused" // TURN answers 401; nothing is allocated
  | "silent" // nothing comes back at all (UDP blocked, say)
  | "failed" // relay candidates allocated, ICE still fails
  | "leaked"; // a host candidate appears — the relay policy did not take

let scenario: Scenario = "relay";
let created: FakePC[] = [];

class FakePC {
  config: RTCConfiguration;
  connectionState = "new";
  onconnectionstatechange: (() => void) | null = null;
  onicecandidate: ((e: { candidate: FakeCandidate | null }) => void) | null = null;
  onicecandidateerror: ((e: unknown) => void) | null = null;
  localDescription: unknown = null;
  remoteDescription: unknown = null;
  accepted: unknown[] = [];
  channels: string[] = [];
  closed = false;
  /** The candidate type this end actually gathered — what getStats reports. */
  gathered: string[] = [];

  constructor(config: RTCConfiguration) {
    this.config = config;
    created.push(this);
  }

  createDataChannel(label: string) {
    this.channels.push(label);
    return { label };
  }

  async createOffer() {
    return { type: "offer", sdp: "v=0 offer" };
  }
  async createAnswer() {
    return { type: "answer", sdp: "v=0 answer" };
  }

  async setLocalDescription(d: unknown) {
    this.localDescription = d;
    // A real allocation is a round trip to the TURN server, so gathering
    // happens after setLocalDescription returns, never inside it. Modelled
    // with a timeout because the probe's candidate plumbing has to survive
    // arriving late — that is the race PR #52's bug 3 was losing.
    setTimeout(() => this.gather(), 0);
  }
  async setRemoteDescription(d: unknown) {
    this.remoteDescription = d;
  }

  async addIceCandidate(c: unknown) {
    if (!this.remoteDescription) throw new Error("no remote description");
    this.accepted.push(c);
    this.maybeConnect();
  }

  private gather() {
    if (this.closed) return;
    if (scenario === "refused") {
      this.onicecandidateerror?.({ errorCode: 401, errorText: "Unauthorized" });
      this.onicecandidate?.({ candidate: null });
      return;
    }
    if (scenario === "silent") {
      this.onicecandidate?.({ candidate: null });
      return;
    }
    const type = scenario === "leaked" ? "host" : "relay";
    this.gathered.push(type);
    this.onicecandidate?.({ candidate: new FakeCandidate(type) });
    this.onicecandidate?.({ candidate: null });
  }

  private maybeConnect() {
    if (scenario === "failed") {
      this.connectionState = "failed";
      this.onconnectionstatechange?.();
      return;
    }
    if (this.connectionState === "connected") return;
    this.connectionState = "connected";
    this.onconnectionstatechange?.();
  }

  async getStats() {
    const type = this.gathered[0] ?? "relay";
    return new Map<string, Record<string, unknown>>([
      ["T1", { id: "T1", type: "transport", selectedCandidatePairId: "P1" }],
      [
        "P1",
        {
          id: "P1",
          type: "candidate-pair",
          state: "succeeded",
          nominated: true,
          localCandidateId: "L1",
          remoteCandidateId: "R1"
        }
      ],
      ["L1", { id: "L1", type: "local-candidate", candidateType: type }],
      ["R1", { id: "R1", type: "remote-candidate", candidateType: type }]
    ]) as unknown as RTCStatsReport;
  }

  close() {
    this.closed = true;
  }
}

class FakeCandidate {
  constructor(public type: string) {}
  toJSON() {
    return { candidate: `candidate ${this.type}`, type: this.type };
  }
}

// ── What the server hands back ────────────────────────────────────────────
const MINTED_ICE = {
  iceServers: [
    { urls: ["stun:stun.cloudflare.com:3478"] },
    {
      urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
      username: "minted-user",
      credential: "minted-secret"
    }
  ],
  relay: true,
  ttlSeconds: 3600,
  status: "ready"
};

let iceBody: unknown = MINTED_ICE;
const getUserMedia = vi.fn(async () => {
  throw new Error("a preflight must never open the microphone");
});

beforeEach(() => {
  scenario = "relay";
  created = [];
  iceBody = MINTED_ICE;
  getUserMedia.mockClear();

  const g = globalThis as Record<string, unknown>;
  g.RTCPeerConnection = FakePC;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { getUserMedia } }
  });
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(iceBody), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
  ) as unknown as typeof fetch;
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

async function probe() {
  const { probeRelay } = await import("@/lib/call/relayProbe");
  return probeRelay();
}

describe("the probe proves the relay, or nothing", () => {
  it("connects through the relay and says how long it took", async () => {
    const result = await probe();
    expect(result.status).toBe("ok");
    expect(result.pair).toBe("relay/relay");
    expect(result.relayCandidates).toBeGreaterThan(0);
    expect(result.ms).not.toBeNull();
  });

  it("forces iceTransportPolicy:'relay' on both ends", async () => {
    // Without this the probe is two peer connections in one tab, which reach
    // each other over loopback unconditionally. The button would have been
    // green through the entire outage it exists to diagnose.
    await probe();
    expect(created).toHaveLength(2);
    for (const pc of created) expect(pc.config.iceTransportPolicy).toBe("relay");
  });

  it("hands the peer connections TURN servers only, never STUN", async () => {
    // Relay-only ICE cannot use a STUN entry, and leaving one in lets a
    // "connected" be claimed by the path this probe exists to exclude.
    await probe();
    for (const pc of created) {
      const urls = (pc.config.iceServers ?? []).flatMap((s) => [s.urls].flat());
      expect(urls.length).toBeGreaterThan(0);
      expect(urls.every((u) => String(u).startsWith("turn"))).toBe(true);
    }
  });

  it("never opens the microphone", async () => {
    // Claim 2. A data channel negotiates ICE identically and asks for no
    // permission; a getUserMedia here would prompt in a lobby and, on iOS,
    // consume the user gesture the real Join tap needs.
    await probe();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(created[0].channels).toContain("taos-relay-probe");
  });

  it("closes both peer connections whatever the verdict", async () => {
    // A probe that leaks a connection leaks a TURN allocation, which is
    // billed bandwidth sitting open on a lobby nobody is using.
    await probe();
    expect(created.every((pc) => pc.closed)).toBe(true);
    created = [];
    scenario = "failed";
    await probe();
    expect(created.every((pc) => pc.closed)).toBe(true);
  });
});

describe("minted is not allocated", () => {
  it("reports no_allocation with the TURN error when the relay refuses", async () => {
    // Claim 3, and the failure nothing else in the stack can see. The server
    // minted happily — /api/call/relay-status would say `ready` — and the
    // TURN server refused the credential at allocate time. On a phone this
    // is "connecting…" forever with no error at all.
    scenario = "refused";
    const result = await probe();
    expect(result.status).toBe("no_allocation");
    expect(result.turnErrorCode).toBe(401);
    expect(result.relayCandidates).toBe(0);
    expect(result.detail).toContain("401");
  });

  it("reports no_allocation when nothing comes back at all", async () => {
    // No candidates and no error: a network blocking UDP 3478 and TCP 443 to
    // Cloudflare. Different cause, same verdict for the founder — the relay
    // cannot be reached from HERE, which is worth knowing before dialling.
    scenario = "silent";
    const result = await probe();
    expect(result.status).toBe("no_allocation");
    expect(result.relayCandidates).toBe(0);
    expect(result.detail).toContain("no relay candidate");
  });

  it("distinguishes a failed pairing from a failed allocation", async () => {
    // Candidates existed and the connection still failed: a network problem,
    // not a credential problem, and it wants a different next move.
    scenario = "failed";
    const result = await probe();
    expect(result.status).toBe("failed");
    expect(result.relayCandidates).toBeGreaterThan(0);
  });

  it("refuses to call a non-relay pair a success", async () => {
    // Claim 4. If the policy ever stops being honoured, "Relay works" would
    // be a statement about a path that was never tested.
    scenario = "leaked";
    const result = await probe();
    expect(result.status).not.toBe("ok");
    expect(result.detail).toContain("not the relay path");
  });
});

describe("the probe does not go looking when there is nothing to look at", () => {
  it("short-circuits on an unconfigured server without building a connection", async () => {
    iceBody = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }], relay: false, status: "not_configured" };
    const result = await probe();
    expect(result.status).toBe("not_configured");
    expect(created).toHaveLength(0);
  });

  it("reports the server's refusal rather than inventing a client one", async () => {
    // The lobby indicator already said `rejected`. A button that answered
    // "connection failed" would look like a second, different problem.
    iceBody = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }], relay: false, status: "rejected" };
    const result = await probe();
    expect(result.status).toBe("rejected");
    expect(created).toHaveLength(0);
  });

  it("says so plainly where there is no WebRTC", async () => {
    delete (globalThis as Record<string, unknown>).RTCPeerConnection;
    const result = await probe();
    expect(result.status).toBe("unsupported");
  });
});

describe("what the founder actually reads", () => {
  it("puts the timing and the pair in the success line", async () => {
    const { probeCopy } = await import("@/lib/call/relayProbe");
    const result = await probe();
    const copy = probeCopy(result);
    expect(copy.tone).toBe("ok");
    expect(copy.text).toContain("Relay works");
    expect(copy.text).toContain("funciona");
    expect(copy.text).toContain("relay/relay");
  });

  it("names Cloudflare in the failure that a human has to fix", async () => {
    const { probeCopy } = await import("@/lib/call/relayProbe");
    iceBody = { iceServers: [], relay: false, status: "rejected" };
    const copy = probeCopy(await probe());
    expect(copy.tone).toBe("bad");
    expect(copy.text).toContain("Cloudflare");
    // Bilingual on one line, like every other status on this screen: the two
    // people on a call read different languages and hold their own phones.
    expect(copy.text).toContain("·");
  });
});
