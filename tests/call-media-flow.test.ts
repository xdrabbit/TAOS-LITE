// One-way audio, made legible.
//
// ── The symptom this file is about ─────────────────────────────────────────
// Field report 2026-08-31, second half. After the relay shipped (PR #52), a
// call between Tom and Liz — she on 5G behind carrier-grade NAT — CONNECTED,
// and carried audio in one direction only. She could be heard and could not
// hear.
//
// Everything on the screen was true and none of it helped. The status pill
// said `connected · conectado · relay`. The candidate pair was real. The
// trail showed a clean negotiation. /call had no word at all for "connected,
// and half of it works", so the only instrument was a person saying "I can't
// hear you" into a call that reported itself healthy — which is the same
// diagnostic position PR #52 was written to get out of.
//
// ── Why two numbers and not one boolean ────────────────────────────────────
// This is the trap the memory a-live-graph-can-carry-silence warns about, one
// level up: "is audio flowing?" is TRUE on the sending side of a one-way
// call. Both phones would have lit up green. The only thing that distinguishes
// the two ends is reading the directions SEPARATELY, which is what
// readMediaFlow does and what this file fences.
import { describe, expect, it, vi } from "vitest";
import { readMediaFlow, readTransport } from "@/lib/call/ice";
import { readFileSync } from "node:fs";

vi.mock("@/lib/authClient", () => ({ authHeaders: async () => ({}) }));

type Report = Record<string, unknown>;

/** A getStats() report set, in the shape a browser hands one over. */
function statsOf(reports: Report[]): RTCStatsReport {
  return new Map(reports.map((r) => [String(r.id), r])) as unknown as RTCStatsReport;
}

function pcWith(reports: Report[]): RTCPeerConnection {
  return { getStats: async () => statsOf(reports) } as unknown as RTCPeerConnection;
}

/** The candidate-pair scaffolding every case below shares. */
function pair(localType: string, remoteType: string, rtt?: number): Report[] {
  return [
    { id: "T1", type: "transport", selectedCandidatePairId: "P1" },
    {
      id: "P1",
      type: "candidate-pair",
      state: "succeeded",
      nominated: true,
      localCandidateId: "L1",
      remoteCandidateId: "R1",
      ...(rtt === undefined ? {} : { currentRoundTripTime: rtt })
    },
    { id: "L1", type: "local-candidate", candidateType: localType },
    { id: "R1", type: "remote-candidate", candidateType: remoteType }
  ];
}

describe("the two directions are counted apart", () => {
  it("reads a healthy call as flowing both ways", async () => {
    const flow = await readMediaFlow(
      pcWith([
        ...pair("relay", "relay", 0.081),
        { id: "O1", type: "outbound-rtp", kind: "audio", packetsSent: 1480 },
        { id: "I1", type: "inbound-rtp", kind: "audio", packetsReceived: 1465 }
      ])
    );
    expect(flow?.audioPacketsSent).toBe(1480);
    expect(flow?.audioPacketsReceived).toBe(1465);
    expect(flow?.transport).toBe("relay");
    expect(flow?.roundTripSeconds).toBeCloseTo(0.081);
  });

  it("reads Liz's call: sending, and receiving nothing", async () => {
    // THE case. A single "audio is flowing" boolean is true here, on this
    // phone, and that is exactly why the failure was invisible for a day.
    const flow = await readMediaFlow(
      pcWith([
        ...pair("relay", "relay"),
        { id: "O1", type: "outbound-rtp", kind: "audio", packetsSent: 1480 },
        { id: "I1", type: "inbound-rtp", kind: "audio", packetsReceived: 0 }
      ])
    );
    expect(flow?.audioPacketsSent).toBeGreaterThan(0);
    expect(flow?.audioPacketsReceived).toBe(0);
  });

  it("does not let video packets stand in for audio ones", async () => {
    // A video call with working video and dead audio is a real shape — the
    // camera works, so "packets are moving" is true — and it is the one a
    // combined counter would report as healthy.
    const flow = await readMediaFlow(
      pcWith([
        ...pair("srflx", "srflx"),
        { id: "OV", type: "outbound-rtp", kind: "video", packetsSent: 9000 },
        { id: "IV", type: "inbound-rtp", kind: "video", packetsReceived: 8800 },
        { id: "OA", type: "outbound-rtp", kind: "audio", packetsSent: 1200 },
        { id: "IA", type: "inbound-rtp", kind: "audio", packetsReceived: 0 }
      ])
    );
    expect(flow?.audioPacketsReceived).toBe(0);
    expect(flow?.videoPacketsReceived).toBe(8800);
    expect(flow?.transport).toBe("direct");
  });

  it("sums every encoding layer rather than reading the first", async () => {
    // Simulcast gives a video call one outbound-rtp per layer. Reading only
    // one of them under-reports a direction that is in fact working, which
    // would put a ✗ next to a direction that is fine.
    const flow = await readMediaFlow(
      pcWith([
        ...pair("relay", "host"),
        { id: "OV1", type: "outbound-rtp", kind: "video", packetsSent: 100 },
        { id: "OV2", type: "outbound-rtp", kind: "video", packetsSent: 250 },
        { id: "OV3", type: "outbound-rtp", kind: "video", packetsSent: 40 }
      ])
    );
    expect(flow?.videoPacketsSent).toBe(390);
  });

  it("accepts the older `mediaType` spelling", async () => {
    // Safari reported the kind under `mediaType` for years, and /call's whole
    // audience is on iPhones. Reading only `kind` would show both directions
    // as ✗ on the exact phones this was built for.
    const flow = await readMediaFlow(
      pcWith([
        ...pair("relay", "relay"),
        { id: "O1", type: "outbound-rtp", mediaType: "audio", packetsSent: 700 },
        { id: "I1", type: "inbound-rtp", mediaType: "audio", packetsReceived: 690 }
      ])
    );
    expect(flow?.audioPacketsSent).toBe(700);
    expect(flow?.audioPacketsReceived).toBe(690);
  });
});

describe("which path it took, and how sure it is", () => {
  it("calls it relayed when either end is a relay candidate", async () => {
    // One side behind carrier NAT is enough to put the whole call through
    // Cloudflare, and the bandwidth is billed either way.
    const flow = await readMediaFlow(pcWith(pair("srflx", "relay")));
    expect(flow?.transport).toBe("relay");
    expect(flow?.localCandidate).toBe("srflx");
    expect(flow?.remoteCandidate).toBe("relay");
  });

  it("falls back to a nominated pair when no transport names one", async () => {
    // `selectedCandidatePairId` is not implemented everywhere. Losing the
    // path label on older WebKit would blank the one line that says whether
    // this call is spending relay bandwidth.
    const flow = await readMediaFlow(
      pcWith([
        {
          id: "P1",
          type: "candidate-pair",
          state: "succeeded",
          nominated: true,
          localCandidateId: "L1",
          remoteCandidateId: "R1"
        },
        { id: "L1", type: "local-candidate", candidateType: "relay" },
        { id: "R1", type: "remote-candidate", candidateType: "relay" }
      ])
    );
    expect(flow?.transport).toBe("relay");
  });

  it("says `unknown` rather than guessing when there is no pair", async () => {
    const flow = await readMediaFlow(pcWith([]));
    expect(flow?.transport).toBe("unknown");
    expect(await readTransport(pcWith([]))).toBe("unknown");
  });

  it("survives a browser that throws on getStats", async () => {
    // Never take a call down to draw a diagnostic on it.
    const pc = {
      getStats: async () => {
        throw new Error("not supported");
      }
    } as unknown as RTCPeerConnection;
    expect(await readMediaFlow(pc)).toBeNull();
    expect(await readTransport(pc)).toBe("unknown");
  });
});

describe("the counters reach the screen", () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

  it("the live call exposes a sampler", async () => {
    // Without this on ActiveCall the numbers exist and nothing can read them:
    // the peer connection is a local inside startCall and the screen has no
    // other handle on it.
    expect(read("lib/call/session.ts")).toContain("readMediaFlow: async () =>");
  });

  it("the screen samples twice, so a frozen counter is not read as flowing", async () => {
    // Cumulative counters are the trap here. A call that carried audio for
    // ten seconds and then died has a large, unchanging packetsReceived — a
    // totals-only display would show ✓ for a direction that stopped. The
    // screen keeps the previous sample and prints a rate.
    const shell = read("components/CallShell.tsx");
    expect(shell).toContain("setPrevFlow");
    expect(shell).toContain("window.setInterval");
    expect(shell).toMatch(/flowLine\(\s*"sending"/);
    expect(shell).toMatch(/flowLine\(\s*"receiving"/);
  });
});
