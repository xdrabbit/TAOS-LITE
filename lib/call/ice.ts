"use client";

import { authHeaders } from "@/lib/authClient";
import type { RelayStatus, RelayStatusReport } from "./relay";

// The browser half of the relay: fetch the ICE servers a peer connection is
// built with, ask ahead of time whether there is a relay at all, and
// afterwards say which path the media actually took and whether it is
// carrying anything in both directions.
//
// All of it exists because of the same field report (Tom + Liz, 2026-08-31:
// the call initiates and never connects, and on the retry one of them can
// hear and the other cannot). The first part stops it happening; the rest is
// so that the next time it happens, nobody has to guess.

/**
 * How the two phones ended up talking.
 *
 * - `direct` — a candidate pair the two phones reached each other on. Free.
 * - `relay`  — one or both ends could not be reached, so packets go through
 *              Cloudflare. Works everywhere; costs bandwidth.
 * - `unknown` — connected, but the stats did not name a pair (older WebKit).
 */
export type CallTransport = "direct" | "relay" | "unknown";

export interface CallIce {
  iceServers: RTCIceServer[];
  /** Whether a relay is actually among them, rather than merely hoped for. */
  relay: boolean;
  /** Why not, when `relay` is false. Same words as /api/call/relay-status. */
  status: RelayStatus;
}

/** What /call has always used, and what it falls back to when minting fails. */
const STUN_ONLY: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

/**
 * Mint ICE servers for one call.
 *
 * Never throws and never returns nothing: a call with STUN-only is the call
 * /call has been making all along, and it connects on the same wifi that has
 * always worked. Losing the relay must degrade the hard pairings, not break
 * the easy ones.
 */
export async function fetchIceServers(): Promise<CallIce> {
  try {
    const res = await fetch("/api/call/ice", {
      method: "POST",
      headers: await authHeaders(),
      cache: "no-store"
    });
    if (!res.ok) return { iceServers: STUN_ONLY, relay: false, status: "error" };
    const body = (await res.json()) as {
      iceServers?: RTCIceServer[];
      relay?: boolean;
      status?: RelayStatus;
    };
    const servers = Array.isArray(body.iceServers) ? body.iceServers : [];
    if (servers.length === 0) {
      return { iceServers: STUN_ONLY, relay: false, status: body.status ?? "error" };
    }
    return {
      iceServers: servers,
      relay: Boolean(body.relay),
      // A route from before this field existed answers without one; a relay
      // that came back is `ready` by definition, and one that did not is at
      // least honestly `error` rather than silently absent.
      status: body.status ?? (body.relay ? "ready" : "error")
    };
  } catch {
    return { iceServers: STUN_ONLY, relay: false, status: "error" };
  }
}

/**
 * Ask whether the relay is alive, without taking a credential.
 *
 * Runs when the lobby renders, so the answer is on screen before anybody
 * taps Join. Never throws: a status check that fails is reported as `error`,
 * which is what it is — /call is not degraded by a preflight it could not
 * run, and the lobby says "no answer" rather than claiming a verdict.
 */
export async function fetchRelayStatus(): Promise<RelayStatusReport> {
  try {
    const res = await fetch("/api/call/relay-status", {
      method: "POST",
      headers: await authHeaders(),
      cache: "no-store"
    });
    if (!res.ok) {
      return {
        status: "error",
        ttlSeconds: 0,
        httpStatus: res.status,
        detail: `the status check itself answered HTTP ${res.status}`
      };
    }
    const body = (await res.json()) as Partial<RelayStatusReport>;
    const known: RelayStatus[] = ["ready", "not_configured", "rejected", "error"];
    return {
      status: known.includes(body.status as RelayStatus) ? (body.status as RelayStatus) : "error",
      ttlSeconds: typeof body.ttlSeconds === "number" ? body.ttlSeconds : 0,
      httpStatus: typeof body.httpStatus === "number" ? body.httpStatus : null,
      detail: typeof body.detail === "string" ? body.detail : null
    };
  } catch (error) {
    return {
      status: "error",
      ttlSeconds: 0,
      httpStatus: null,
      detail: error instanceof Error ? error.message : "the status check did not answer"
    };
  }
}

/** Index a stats report by id, so candidate ids can be followed. */
function indexStats(stats: RTCStatsReport): Map<string, Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  stats.forEach((report) => byId.set(report.id, report as unknown as Record<string, unknown>));
  return byId;
}

/**
 * The candidate pair that won, found the portable way.
 *
 * `RTCIceCandidatePairStats.selected` is not implemented everywhere, so try
 * the transport's `selectedCandidatePairId` first and fall back to any
 * succeeded pair marked nominated.
 */
function selectedPair(
  byId: Map<string, Record<string, unknown>>
): Record<string, unknown> | undefined {
  for (const report of byId.values()) {
    if (report.type === "transport" && typeof report.selectedCandidatePairId === "string") {
      const pair = byId.get(report.selectedCandidatePairId);
      if (pair) return pair;
    }
  }
  for (const report of byId.values()) {
    if (
      report.type === "candidate-pair" &&
      report.state === "succeeded" &&
      (report.nominated === true || report.selected === true)
    ) {
      return report;
    }
  }
  return undefined;
}

/**
 * Which candidate pair won, read off the live connection.
 *
 * A `relay` candidateType on EITHER end means the media is being relayed —
 * one side behind carrier NAT is enough to put the whole call through
 * Cloudflare.
 */
export async function readTransport(pc: RTCPeerConnection): Promise<CallTransport> {
  try {
    const flow = await readMediaFlow(pc);
    return flow?.transport ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * What is actually moving, per direction.
 *
 * ── Why the counters are per direction ─────────────────────────────────────
 * The 2026-08-31 field report has two halves. The first is the call that
 * never connected, which PR #52 addressed. The second is the one that did:
 * Liz on 5G behind CGNAT, connected, and audio flowing ONE WAY — she could
 * be heard and could not hear. That is not a state /call had any word for.
 * The status pill said `connected`, the transport said `relay`, and both were
 * true; nothing on the screen distinguished a working call from half of one.
 *
 * A single "is audio flowing?" boolean cannot, either — it is true on the
 * sending side of a one-way call. So this returns the two numbers separately.
 * `packetsSent` climbing while `packetsReceived` sits at zero IS one-way
 * audio, stated as an observation rather than inferred from a complaint.
 *
 * Counters are cumulative; the caller samples twice and compares. A total is
 * not enough on its own — a call that carried audio for ten seconds and then
 * stopped has a large, frozen `packetsReceived`.
 */
export interface CallMediaFlow {
  transport: CallTransport;
  /** Candidate types of the selected pair, e.g. "relay"/"srflx". */
  localCandidate: string | null;
  remoteCandidate: string | null;
  /** Cumulative RTP packets, this phone → the partner. */
  audioPacketsSent: number;
  videoPacketsSent: number;
  /** Cumulative RTP packets, the partner → this phone. */
  audioPacketsReceived: number;
  videoPacketsReceived: number;
  /** Round-trip time on the selected pair, seconds, when the browser has one. */
  roundTripSeconds: number | null;
  /** When this sample was taken, for turning cumulative counters into rates. */
  at: number;
}

export async function readMediaFlow(pc: RTCPeerConnection): Promise<CallMediaFlow | null> {
  try {
    const byId = indexStats(await pc.getStats());
    const pair = selectedPair(byId);
    const local = pair ? byId.get(String(pair.localCandidateId)) : undefined;
    const remote = pair ? byId.get(String(pair.remoteCandidateId)) : undefined;

    const localType = typeof local?.candidateType === "string" ? local.candidateType : null;
    const remoteType = typeof remote?.candidateType === "string" ? remote.candidateType : null;

    let transport: CallTransport = "unknown";
    if (localType || remoteType) {
      transport = localType === "relay" || remoteType === "relay" ? "relay" : "direct";
    }

    const flow: CallMediaFlow = {
      transport,
      localCandidate: localType,
      remoteCandidate: remoteType,
      audioPacketsSent: 0,
      videoPacketsSent: 0,
      audioPacketsReceived: 0,
      videoPacketsReceived: 0,
      roundTripSeconds:
        typeof pair?.currentRoundTripTime === "number" ? pair.currentRoundTripTime : null,
      at: Date.now()
    };

    // Summed across reports rather than taking the first: a video call has an
    // outbound-rtp per encoding layer, and reading only one of them
    // under-reports a direction that is in fact working.
    for (const report of byId.values()) {
      const kind = report.kind ?? report.mediaType;
      if (report.type === "outbound-rtp" && typeof report.packetsSent === "number") {
        if (kind === "audio") flow.audioPacketsSent += report.packetsSent;
        if (kind === "video") flow.videoPacketsSent += report.packetsSent;
      }
      if (report.type === "inbound-rtp" && typeof report.packetsReceived === "number") {
        if (kind === "audio") flow.audioPacketsReceived += report.packetsReceived;
        if (kind === "video") flow.videoPacketsReceived += report.packetsReceived;
      }
    }

    return flow;
  } catch {
    return null;
  }
}
