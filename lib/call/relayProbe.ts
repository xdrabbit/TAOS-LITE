"use client";

import { fetchIceServers } from "./ice";

// "Test connection · Probar conexión" — the one-tap proof that the relay
// carries a packet, run from the lobby before anybody dials.
//
// ── What it is a port of ───────────────────────────────────────────────────
// tests/live-fire/call-relay-check.mjs, minus the terminal. That harness
// spawns Chrome over CDP, builds two peer connections with
// `iceTransportPolicy: "relay"`, and proves that a browser handed nothing but
// TURN credentials will allocate a relay and connect through it. It is the
// two-phones-on-cellular row of Tom's network matrix, minus the phones — and
// it is the strongest evidence /call has. It is also a node script on a
// laptop, which is not where the founders are when a call fails.
//
// ── Why a loopback proves anything at all ──────────────────────────────────
// Both ends of this probe are the same phone, so it says nothing about NAT —
// two peer connections in one tab could always reach each other. What
// `iceTransportPolicy: "relay"` adds is that they are FORBIDDEN to: Chrome
// and WebKit discard their own host and server-reflexive candidates under it
// and will only offer a relay candidate allocated on the TURN server. So a
// connection that comes up here came up through Cloudflare, over the real
// internet, on this phone's real network, authenticated with a credential
// minted seconds ago by the real production route.
//
// That is precisely the leg nothing else could test:
//
//   /api/call/relay-status  proves Cloudflare will MINT for these keys
//   this probe              proves the relay will ALLOCATE for that credential
//
// They fail independently. A key with the wrong scope mints happily and is
// refused at allocate time with a 401 on the TURN server, which is invisible
// to every server-side check and shows up in a real call as "connecting…"
// forever. That is the failure this button exists to name.
//
// ── What it deliberately does not do ───────────────────────────────────────
// Touch the microphone. A preflight must be safe to tap idly in a lobby, and
// on iOS a getUserMedia inside a probe would burn the user gesture that the
// real Join tap needs (see the /fast WebKit AudioContext write-up — the same
// class of bug). A data channel negotiates ICE identically and needs no
// permission, so the probe measures the transport and nothing else.

/**
 * - `ok`              — connected through the relay. `ms` is how long it took.
 * - `not_configured`  — no Cloudflare keys on the server. Nothing to probe.
 * - `rejected`        — the server could not even mint. /api/call/relay-status
 *                       already said so; repeated here so the button is
 *                       honest when tapped anyway.
 * - `no_allocation`   — minted, but the phone gathered ZERO relay candidates.
 *                       The credential was refused by the TURN server itself,
 *                       or UDP/TCP to it is blocked on this network.
 * - `failed`          — relay candidates on both sides and ICE still failed.
 * - `timeout`         — never reached a verdict inside the cap.
 * - `unsupported`     — no RTCPeerConnection (an in-app browser, or a test).
 */
export type RelayProbeStatus =
  | "ok"
  | "not_configured"
  | "rejected"
  | "no_allocation"
  | "failed"
  | "timeout"
  | "unsupported";

export interface RelayProbeResult {
  status: RelayProbeStatus;
  /** Time to a connected relay-only pair. Null unless `ok`. */
  ms: number | null;
  /** The candidate pair that carried it, e.g. "relay/relay". */
  pair: string | null;
  /** How many relay candidates this phone managed to allocate. */
  relayCandidates: number;
  /**
   * The TURN server's own refusal code, when it gave one.
   * 401 means the credential was rejected at allocate time — the failure that
   * a successful mint cannot see.
   */
  turnErrorCode: number | null;
  /** A short sentence for the screen. Never contains a credential. */
  detail: string | null;
}

/** Long enough for a relay allocation on a slow cellular link, short enough
 *  that a founder does not think the button is broken. The live-fire harness
 *  measured 207 ms against real Cloudflare; this is 40x that. */
const PROBE_CAP_MS = 8000;

/** One line of probe trail, alongside the call's own under the same prefix. */
type Trace = (line: string) => void;

/** How the race below ended. `no_candidates` is ICE conceding, not a timeout. */
type Verdict = "connected" | "failed" | "timeout" | "no_candidates";

export async function probeRelay(onTrace?: Trace): Promise<RelayProbeResult> {
  const trace: Trace = (line) => {
    console.info(`[taos-call-ice] probe ${line}`);
    onTrace?.(line);
  };

  const PC = (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection })
    .RTCPeerConnection;
  if (!PC) {
    return blank("unsupported", "this browser has no WebRTC");
  }

  const ice = await fetchIceServers();
  if (ice.status !== "ready" || !ice.relay) {
    trace(`mint=${ice.status}`);
    return blank(
      ice.status === "not_configured" ? "not_configured" : "rejected",
      ice.status === "not_configured"
        ? "no Cloudflare TURN keys on the server"
        : "the server could not mint a credential"
    );
  }

  // Relay-only ICE cannot use a STUN entry, and leaving one in lets a
  // "connected" be claimed by the very path this probe is meant to exclude.
  const turnOnly = ice.iceServers.filter((s) =>
    [s.urls].flat().some((u) => String(u).startsWith("turn"))
  );
  if (turnOnly.length === 0) {
    return blank("rejected", "the mint came back without a relay");
  }

  const config: RTCConfiguration = { iceServers: turnOnly, iceTransportPolicy: "relay" };
  const a = new PC(config);
  const b = new PC(config);
  let relayCandidates = 0;
  let turnErrorCode: number | null = null;
  let gatheringDone = 0;

  // One verdict, whoever reaches it first: a connection, a failure, both ends
  // finishing gathering with nothing to show, or the cap.
  //
  // "Finished gathering with nothing" is in here rather than being left to
  // the timeout because it is the DEFINITIVE answer, arriving in a fraction
  // of the time: ICE has said it has no relay candidate to offer, so there is
  // nothing left that could still succeed. Waiting the full eight seconds to
  // report it would make the commonest credential failure — the one this
  // button exists to name — feel like the button is broken.
  let settle: ((v: Verdict) => void) | null = null;
  const verdict = new Promise<Verdict>((resolve) => {
    settle = resolve;
  });
  const finish = (v: Verdict) => {
    const s = settle;
    settle = null;
    s?.(v);
  };

  const done = (result: RelayProbeResult): RelayProbeResult => {
    try {
      a.close();
      b.close();
    } catch {
      /* already closed */
    }
    trace(
      `result=${result.status} ms=${result.ms ?? "-"} pair=${result.pair ?? "-"} ` +
        `relay_candidates=${result.relayCandidates}` +
        (result.turnErrorCode ? ` turn_error=${result.turnErrorCode}` : "")
    );
    return result;
  };

  try {
    for (const [from, to] of [
      [a, b],
      [b, a]
    ] as Array<[RTCPeerConnection, RTCPeerConnection]>) {
      from.onicecandidate = (e) => {
        if (!e.candidate) {
          // The null candidate is "gathering complete". Both ends done with
          // nothing allocated is a finished question, not a slow one.
          gatheringDone += 1;
          if (gatheringDone >= 2 && relayCandidates === 0) finish("no_candidates");
          return;
        }
        if (e.candidate.type === "relay") relayCandidates += 1;
        // Both ends are local, so signaling is a function call. Trickled all
        // the same: a relay candidate takes a round trip to allocate and
        // arrives well after the answer, which is exactly the race that lost
        // candidates before PR #52.
        void to.addIceCandidate(e.candidate.toJSON()).catch(() => {
          /* a candidate arriving before the description; harmless here,
             both descriptions are set synchronously below */
        });
      };
      // The TURN server's refusal, when there is one. `errorCode` 401 here is
      // the whole reason this probe exists: it is the ALLOCATE rejection that
      // a 201 from the mint endpoint cannot rule out.
      from.onicecandidateerror = (event) => {
        const err = event as unknown as { errorCode?: number; errorText?: string };
        if (typeof err.errorCode === "number" && err.errorCode >= 400) {
          turnErrorCode = err.errorCode;
          trace(`turn_error code=${err.errorCode} text=${err.errorText ?? ""}`);
        }
      };
    }

    // A data channel, not media: it negotiates ICE identically and asks for
    // no permission. See the note at the top of this file.
    a.createDataChannel("taos-relay-probe");

    const started = Date.now();
    const offer = await a.createOffer();
    await a.setLocalDescription(offer);
    await b.setRemoteDescription(offer);
    const answer = await b.createAnswer();
    await b.setLocalDescription(answer);
    await a.setRemoteDescription(answer);

    const check = () => {
      if (a.connectionState === "failed" || b.connectionState === "failed") return finish("failed");
      if (a.connectionState === "connected" && b.connectionState === "connected") {
        finish("connected");
      }
    };
    a.onconnectionstatechange = check;
    b.onconnectionstatechange = check;
    check();
    const cap = setTimeout(() => finish("timeout"), PROBE_CAP_MS);
    const connected = await verdict;
    clearTimeout(cap);
    const ms = Date.now() - started;

    if (connected !== "connected") {
      // Zero relay candidates is a different failure from a failed pairing,
      // and the two want different fixes. Nothing allocated at all means the
      // TURN server said no — bad credential scope, or this network blocking
      // it. Candidates that paired and failed is a network problem.
      if (relayCandidates === 0 || connected === "no_candidates") {
        return done({
          status: "no_allocation",
          ms: null,
          pair: null,
          relayCandidates,
          turnErrorCode,
          detail: turnErrorCode
            ? `the relay refused to allocate (TURN error ${turnErrorCode})`
            : "no relay candidate was allocated — the credential was refused, or this network blocks TURN"
        });
      }
      return done({
        status: connected === "timeout" ? "timeout" : "failed",
        ms: null,
        pair: null,
        relayCandidates,
        turnErrorCode,
        detail:
          connected === "timeout"
            ? `no verdict in ${PROBE_CAP_MS} ms`
            : "relay candidates were allocated but the connection failed"
      });
    }

    const pair = await readProbePair(a);
    if (pair && pair !== "relay/relay") {
      // Under a relay-only policy this should be unreachable. If it happens,
      // the policy did not take and "the relay works" would be a false claim
      // about a path that was never tested.
      return done({
        status: "failed",
        ms,
        pair,
        relayCandidates,
        turnErrorCode,
        detail: `connected on a ${pair} pair, which is not the relay path`
      });
    }

    return done({
      status: "ok",
      ms,
      pair: pair ?? "relay/relay",
      relayCandidates,
      turnErrorCode,
      detail: null
    });
  } catch (error) {
    return done({
      status: "failed",
      ms: null,
      pair: null,
      relayCandidates,
      turnErrorCode,
      detail: error instanceof Error ? error.message : "the probe threw"
    });
  }
}

function blank(status: RelayProbeStatus, detail: string): RelayProbeResult {
  return { status, ms: null, pair: null, relayCandidates: 0, turnErrorCode: null, detail };
}

/** The candidate types of the pair that carried the probe, "local/remote". */
async function readProbePair(pc: RTCPeerConnection): Promise<string | null> {
  try {
    const byId = new Map<string, Record<string, unknown>>();
    (await pc.getStats()).forEach((r) => byId.set(r.id, r as unknown as Record<string, unknown>));
    let pair: Record<string, unknown> | undefined;
    for (const r of byId.values()) {
      if (r.type === "transport" && typeof r.selectedCandidatePairId === "string") {
        pair = byId.get(r.selectedCandidatePairId);
        if (pair) break;
      }
    }
    if (!pair) {
      for (const r of byId.values()) {
        if (r.type === "candidate-pair" && r.state === "succeeded" && r.nominated === true) {
          pair = r;
          break;
        }
      }
    }
    if (!pair) return null;
    const local = byId.get(String(pair.localCandidateId))?.candidateType ?? "?";
    const remote = byId.get(String(pair.remoteCandidateId))?.candidateType ?? "?";
    return `${local}/${remote}`;
  } catch {
    return null;
  }
}

/** The bilingual line the lobby shows for a finished probe. */
export function probeCopy(result: RelayProbeResult): { text: string; tone: "ok" | "warn" | "bad" } {
  switch (result.status) {
    case "ok":
      return { text: `Relay works · funciona (${result.ms} ms, ${result.pair})`, tone: "ok" };
    case "not_configured":
      return {
        text: "Nothing to test · nada que probar — no TURN keys on the server",
        tone: "warn"
      };
    case "rejected":
      return { text: "Keys rejected · claves rechazadas — revisar Cloudflare", tone: "bad" };
    case "no_allocation":
      return {
        text: `Relay refused · el relé rechazó la conexión${
          result.turnErrorCode ? ` (TURN ${result.turnErrorCode})` : ""
        }`,
        tone: "bad"
      };
    case "timeout":
      return { text: "No answer in 8 s · sin respuesta — network too slow or blocked", tone: "bad" };
    case "unsupported":
      return { text: "This browser cannot test · no se puede probar aquí", tone: "warn" };
    default:
      return { text: "Relay did not connect · no conectó", tone: "bad" };
  }
}
