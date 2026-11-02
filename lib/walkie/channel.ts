"use client";

import { supabase } from "@/lib/supabase";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { normalizeWalkieRoom } from "./room";
import { HOLD_HEARTBEAT_MS, holdingExpired, type HoldClock } from "./state";

// Taokie's channel IS /call's signaling, reused (Tom's decision #1,
// 2026-11-01): a Supabase Realtime channel named by the room code, with
// presence for "who is here and what are they doing" and broadcast for the
// tiny events a walkie needs. lib/call/session.ts uses exactly this to carry
// SDP/ICE blobs and the "interpreter speaking" / "language" signals; the
// only thing /call adds on top is a WebRTC peer connection, which Taokie
// does not need, and the only thing /call's interpreter adds is a
// gpt-realtime session, which Taokie does not touch — the speech path is
// the home pipeline over HTTP. No realtime-model dependency anywhere here.
//
// ── What travels ───────────────────────────────────────────────────────────
// PRESENCE (state, synced to everyone, survives a late join):
//   { lang, name, holding, beat, joined_at }
//   The partner's language is read from here, which is what makes "translate
//   into the PARTNER's language" work without /call's announce-and-echo
//   dance: presence has retention. `holding` is a HEARTBEAT: while a phone
//   records it re-tracks every HOLD_HEARTBEAT_MS with a fresh `beat`, and the
//   partner's phone stops believing it when the beats stop or the turn cap
//   is past (lib/walkie/state.ts holdingExpired). A release that never
//   arrives cannot lock the channel.
// BROADCAST (fire and forget, only to those listening now):
//   ready   { id, releasedAt }  a turn is stored and spoken; come and get it
//   got     { id }              the partner's phone has it          → ✓
//   played  { id }              the partner's phone finished it     → ✓✓
// Audio and text never travel on the channel. A message is a row plus two
// storage objects, read back through /api/walkie/messages with a session.
// Because a broadcast reaches only a subscribed socket, the shell ALSO polls
// the server for turns it has not seen (components/walkie/WalkieShell.tsx):
// the first two-phone test lost 13 of 22 turns to sockets that had gone
// quiet with the screen, and nothing on either phone said so.
//
// ── Status after the first join ────────────────────────────────────────────
// supabase-js calls the subscribe callback on EVERY status change, not just
// the first: SUBSCRIBED again after a reconnect, CLOSED / CHANNEL_ERROR /
// TIMED_OUT when the socket goes. PR #114 handled only the first; a dropped
// socket left the screen saying "Liz is here" with nobody listening. Now a
// loss is reported (onStatus "lost"), a rejoin re-tracks presence and is
// reported too (onStatus "joined"), and resync() re-reads the presence
// cache on demand.
//
// Strictly 1:1, like a call: a third presence in the room is turned away
// unless we are already paired with one of the others (a forwarded link
// tapped twice must not kill the channel that is working).

export interface WalkiePeerState {
  lang: string;
  name: string;
  holding: boolean;
}

export type WalkieChannelStatus = "joined" | "lost";

export interface WalkieChannelEvents {
  onJoined?: () => void;
  /** The partner's state changed, or they left (null). */
  onPartner?: (state: WalkiePeerState | null) => void;
  /** The partner's hold heartbeat stopped or ran past the cap: lock released. */
  onHoldExpired?: () => void;
  /** The socket came back (joined) or went away (lost) after the first join. */
  onStatus?: (status: WalkieChannelStatus) => void;
  onReady?: (msg: { id: string; releasedAt: number | null }) => void;
  onGot?: (id: string) => void;
  onPlayed?: (id: string) => void;
  onError?: (message: string) => void;
}

export interface WalkieChannel {
  leave: () => Promise<void>;
  setHolding: (holding: boolean) => void;
  setLanguage: (lang: string) => void;
  sendReady: (id: string, releasedAt: number | null) => void;
  sendGot: (id: string) => void;
  sendPlayed: (id: string) => void;
  /** Re-read the presence cache and re-announce this phone. Returns whether the socket is up. */
  resync: () => boolean;
  /** Whether the channel is currently subscribed. */
  isJoined: () => boolean;
}

interface Signal {
  from: string;
  kind: "ready" | "got" | "played";
  id: string;
  releasedAt?: number | null;
}

function randomPeerId(): string {
  const c = crypto as Crypto & { randomUUID?: () => string };
  if (typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export const WALKIE_TOPIC_PREFIX = "taos-walkie-";
/** How often this phone re-checks a partner's hold against its clocks. */
const HOLD_CHECK_EVERY_MS = 1_000;

export async function joinWalkieChannel(
  config: { room: string; lang: string; name: string; maxTurnMs: number },
  events: WalkieChannelEvents
): Promise<WalkieChannel> {
  const room = normalizeWalkieRoom(config.room);
  if (!room) throw new Error("Enter a channel code first.");
  const peerId = randomPeerId();
  let mine: WalkiePeerState = { lang: config.lang, name: config.name, holding: false };
  let partnerId: string | null = null;
  let ended = false;
  let joined = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let holdCheck: ReturnType<typeof setInterval> | null = null;
  // The partner's hold, on THIS phone's clock.
  let holdClock: HoldClock | null = null;
  let lastBeat: unknown = null;
  let expiredRaised = false;

  // One channel per room, never two — the same double-tap trap /call hit
  // (lib/call/session.ts explains the "cannot add presence callbacks after
  // subscribe()" failure this avoids).
  const topic = `${WALKIE_TOPIC_PREFIX}${room}`;
  for (const stale of supabase.getChannels()) {
    if (stale.topic === topic || stale.topic === `realtime:${topic}`) {
      await supabase.removeChannel(stale);
    }
  }

  const channel: RealtimeChannel = supabase.channel(topic, {
    config: { broadcast: { self: false }, presence: { key: peerId } }
  });

  const track = () => {
    if (ended) return;
    void channel.track({ ...mine, beat: Date.now(), joined_at: new Date().toISOString() });
  };

  const send = (msg: Omit<Signal, "from">) => {
    if (ended) return;
    void channel.send({ type: "broadcast", event: "signal", payload: { ...msg, from: peerId } });
  };

  const stopHeartbeat = () => {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  const stopHoldCheck = () => {
    if (holdCheck !== null) {
      clearInterval(holdCheck);
      holdCheck = null;
    }
  };

  const rawPartner = (): (WalkiePeerState & { beat: unknown }) | null => {
    if (!partnerId) return null;
    const state = channel.presenceState() as Record<string, Array<Record<string, unknown>>>;
    const entry = state[partnerId]?.[0];
    if (!entry) return null;
    return {
      lang: typeof entry.lang === "string" ? entry.lang : "",
      name: typeof entry.name === "string" ? entry.name : "",
      holding: entry.holding === true,
      beat: entry.beat ?? null
    };
  };

  /** The partner as this phone should believe them: a hold past its clocks is a release. */
  const readPartner = (now = Date.now()): WalkiePeerState | null => {
    const raw = rawPartner();
    if (!raw) {
      holdClock = null;
      lastBeat = null;
      expiredRaised = false;
      stopHoldCheck();
      return null;
    }
    if (!raw.holding) {
      holdClock = null;
      lastBeat = null;
      expiredRaised = false;
      stopHoldCheck();
      return { lang: raw.lang, name: raw.name, holding: false };
    }
    if (!holdClock) {
      holdClock = { since: now, seenAt: now };
      lastBeat = raw.beat;
      expiredRaised = false;
    } else if (raw.beat !== lastBeat) {
      // A fresh beat: still talking.
      holdClock.seenAt = now;
      lastBeat = raw.beat;
    }
    const expired = holdingExpired(holdClock, now, config.maxTurnMs);
    if (expired && !expiredRaised) {
      expiredRaised = true;
      events.onHoldExpired?.();
    }
    if (!expired && holdCheck === null) {
      holdCheck = setInterval(() => {
        if (ended) return;
        events.onPartner?.(readPartner());
      }, HOLD_CHECK_EVERY_MS);
    }
    if (expired) stopHoldCheck();
    return { lang: raw.lang, name: raw.name, holding: !expired };
  };

  channel.on("broadcast", { event: "signal" }, ({ payload }) => {
    const msg = payload as Signal;
    if (!msg || msg.from === peerId || typeof msg.id !== "string") return;
    if (partnerId && msg.from !== partnerId) return; // strictly 1:1
    if (msg.kind === "ready") {
      events.onReady?.({
        id: msg.id,
        releasedAt: typeof msg.releasedAt === "number" ? msg.releasedAt : null
      });
    } else if (msg.kind === "got") events.onGot?.(msg.id);
    else if (msg.kind === "played") events.onPlayed?.(msg.id);
  });

  channel.on("presence", { event: "sync" }, () => {
    if (ended) return;
    const others = Object.keys(channel.presenceState()).filter((k) => k !== peerId);
    if (others.length > 1) {
      if (partnerId && others.includes(partnerId)) {
        events.onPartner?.(readPartner());
        return;
      }
      events.onError?.("This channel already has two people in it. · Este canal ya tiene dos personas.");
      void leave();
      return;
    }
    const next = others[0] ?? null;
    if (next !== partnerId) {
      holdClock = null;
      lastBeat = null;
      expiredRaised = false;
    }
    partnerId = next;
    events.onPartner?.(readPartner());
  });

  const leave = async () => {
    if (ended) return;
    ended = true;
    joined = false;
    stopHeartbeat();
    stopHoldCheck();
    try {
      // removeChannel, not unsubscribe — see lib/call/session.ts hangUp().
      await supabase.removeChannel(channel);
    } catch {
      /* ignore */
    }
  };

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    channel.subscribe((status) => {
      if (ended) return;
      if (status === "SUBSCRIBED") {
        const rejoin = settled;
        joined = true;
        track(); // on a rejoin too: presence is not re-sent for us
        if (!settled) {
          settled = true;
          events.onJoined?.();
          resolve();
        }
        if (rejoin) events.onStatus?.("joined");
        return;
      }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        joined = false;
        if (!settled) {
          settled = true;
          reject(new Error("Could not reach the channel. Check your connection."));
          return;
        }
        events.onStatus?.("lost");
      }
    });
  });

  return {
    leave,
    isJoined: () => joined && !ended,
    setHolding: (holding) => {
      if (mine.holding === holding) return;
      mine = { ...mine, holding };
      track();
      stopHeartbeat();
      if (holding) {
        heartbeat = setInterval(track, HOLD_HEARTBEAT_MS);
      }
    },
    setLanguage: (lang) => {
      if (mine.lang === lang) return;
      mine = { ...mine, lang };
      track();
    },
    resync: () => {
      if (ended) return false;
      track();
      events.onPartner?.(readPartner());
      return joined;
    },
    sendReady: (id, releasedAt) => send({ kind: "ready", id, releasedAt }),
    sendGot: (id) => send({ kind: "got", id }),
    sendPlayed: (id) => send({ kind: "played", id })
  };
}
