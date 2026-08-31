"use client";

import { authHeaders } from "@/lib/authClient";

// The browser half of the relay: fetch the ICE servers a peer connection is
// built with, and afterwards say which path the media actually took.
//
// Both halves exist because of the same field report (Tom + Liz, 2026-08-31:
// the call initiates and never connects). The first stops it happening; the
// second is so that the next time it happens, nobody has to guess.

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
    if (!res.ok) return { iceServers: STUN_ONLY, relay: false };
    const body = (await res.json()) as {
      iceServers?: RTCIceServer[];
      relay?: boolean;
    };
    const servers = Array.isArray(body.iceServers) ? body.iceServers : [];
    if (servers.length === 0) return { iceServers: STUN_ONLY, relay: false };
    return { iceServers: servers, relay: Boolean(body.relay) };
  } catch {
    return { iceServers: STUN_ONLY, relay: false };
  }
}

/**
 * Which candidate pair won, read off the live connection.
 *
 * `RTCIceCandidatePairStats.selected` is not implemented everywhere, so the
 * pair is found the portable way: the transport's `selectedCandidatePairId`
 * first, then any succeeded pair marked nominated. A `relay` candidateType on
 * EITHER end means the media is being relayed — one side behind carrier NAT
 * is enough to put the whole call through Cloudflare.
 */
export async function readTransport(pc: RTCPeerConnection): Promise<CallTransport> {
  try {
    const stats = await pc.getStats();
    const byId = new Map<string, Record<string, unknown>>();
    stats.forEach((report) => byId.set(report.id, report as unknown as Record<string, unknown>));

    let pair: Record<string, unknown> | undefined;
    for (const report of byId.values()) {
      if (report.type === "transport" && typeof report.selectedCandidatePairId === "string") {
        pair = byId.get(report.selectedCandidatePairId);
        if (pair) break;
      }
    }
    if (!pair) {
      for (const report of byId.values()) {
        if (
          report.type === "candidate-pair" &&
          report.state === "succeeded" &&
          (report.nominated === true || report.selected === true)
        ) {
          pair = report;
          break;
        }
      }
    }
    if (!pair) return "unknown";

    const local = byId.get(String(pair.localCandidateId));
    const remote = byId.get(String(pair.remoteCandidateId));
    if (!local && !remote) return "unknown";
    const relayed = local?.candidateType === "relay" || remote?.candidateType === "relay";
    return relayed ? "relay" : "direct";
  } catch {
    return "unknown";
  }
}
