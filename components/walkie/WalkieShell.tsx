"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ExitHome } from "@/components/ExitHome";
import { JumpToTail, useFollowTail } from "@/components/FollowTail";
import { LanguagePillRow, LanguageSheet } from "@/components/LanguagePicker";
import { authHeaders, jsonAuthHeaders } from "@/lib/authClient";
import { copyFor, fill } from "@/lib/chrome/copy";
import { languageNative } from "@/lib/languages/catalog";
import { fetchWithRetry, isConnectionError } from "@/lib/net";
import { supabase } from "@/lib/supabase";
import { generateRoomCode } from "@/lib/call/session";
import {
  contextForNextTurn,
  EMPTY_CONTEXT,
  rememberTurn,
  type ContextStore
} from "@/lib/translate/context";
import type { PairLangCode } from "@/lib/translate/pair";
import {
  AUDIO_BITS_PER_SECOND,
  MIN_TURN_DURATION_MS,
  fileNameFor,
  pickMimeType,
  pulsePeriod,
  rampStyle,
  rampWindows
} from "@/lib/translate/recorder";
import type { ConversationSession } from "@/lib/translate/session";
import { useLanguagePair } from "@/lib/translate/useLanguagePair";
import { ttsDeviceHeaders } from "@/lib/tts/deviceHints";
import { SUBSCRIBER_DEFAULT_ENGINE } from "@/lib/tts/engine";
import { personalVoiceHeaders } from "@/lib/tts/personalVoiceClient";
import { keepWake } from "@/lib/wakeLock";
import { joinWalkieChannel, type WalkieChannel, type WalkiePeerState } from "@/lib/walkie/channel";
import { WALKIE_DEFAULT_MAX_TURN_MS, WALKIE_DEFAULT_RETENTION_DAYS } from "@/lib/walkie/flag";
import { createWalkieChirps, type WalkieChirps } from "@/lib/walkie/chirps";
import { isWalkieRoom, normalizeWalkieRoom } from "@/lib/walkie/room";
import {
  CATCH_UP_EVERY_MS,
  DELIVERY_WAIT_MS,
  READY_RETRY_AT_MS,
  RECEIPT_REFRESH_WINDOW_MS,
  canHold,
  holdRefusal
} from "@/lib/walkie/state";
import { toggleLabelKey, toggleStep, type ToggleState } from "@/lib/walkie/toggle";
import type { WalkieFailStage } from "@/lib/walkie/timing";

// ── /taokie: the push-to-talk translation walkie ────────────────────────────
// Two founders in a channel. Tap the big button, talk, tap again: the turn
// goes to /api/walkie/turn (the home pipeline — transcribe, translate into
// the PARTNER's language, speak in the sender's voice) and the partner's
// phone plays it by itself, with the text. A walkie-talkie that translates.
//
// What this screen does NOT build, by decision (2026-11-01):
//   - a streaming mic: the home recorder is reused (lib/translate/recorder.ts)
//     because iOS WebKit defeats custom streaming mics (lib/release.ts)
//   - a relay: the channel is /call's Supabase Realtime signaling, reused
//     (lib/walkie/channel.ts); no WebRTC, no gpt-realtime anywhere
//   - push: none exists in the PWA, so this is foreground-only — incoming
//     turns play while the screen is open and on air
//
// ── After the first two-phone test (Tom, 2026-11-01, iPhone 17 + S23) ──────
// 1. TAP TO TALK, TAP TO SEND, on both platforms (lib/walkie/toggle.ts).
//    Hold-to-talk lost the release whenever the finger left before the mic
//    had opened, and stamped every other turn "cancelled". No long press
//    remains on this screen, so the iOS long-press cue — the lead suspect in
//    the open tap-eating bug — has nothing here to attach to. pointercancel
//    while recording still SENDS what was heard.
// 2. A LOCK THAT CANNOT STICK: "holding" is a heartbeat and the partner's
//    phone lets it expire (lib/walkie/state.ts). A Resync button re-reads
//    the channel and fetches what was missed; a lost socket says so.
// 3. NO SILENT DROPS: 13 of 22 turns that night reached the server and never
//    the other phone, because a broadcast only reaches a subscribed socket
//    and a phone whose screen slept had none. Now: the screen stays awake
//    while on air, the phone polls the server for turns it has not seen
//    (CATCH_UP_EVERY_MS) and catches up on every return to the foreground,
//    the sender hears about a turn nobody picked up (DELIVERY_WAIT_MS), and a
//    playback the speaker refused shows "tap to go on air" again. Every
//    failure lands on the timing line as fail_stage=.
//
// ── After the first production session (Tom + Liz, 2026-11-02) ─────────────
// 4. THE INVITE JOINS THE CHANNEL. The link is /taokie/<code> — a PATH, not
//    ?room=, because Google sign-in bounces through Supabase and comes back
//    to a path with its own ?code= appended; a query would not survive and
//    did not (both founders signed in fresh that night and landed on an
//    empty lobby). WalkieGate carries the path into the sign-in redirect,
//    and a room that came from a link goes on air by itself: no typing. The
//    one thing a link cannot do is unlock the speaker (iOS wants a gesture),
//    so the screen asks for one tap anywhere, and a turn that arrives before
//    it is held by the existing "tap to go on air" banner. Old ?room= links
//    still work the same way.
// 5. "NOT DELIVERED" ASKS THE SERVER FIRST. Eight of ten banners that night
//    were false: the partner had the turn (delivered_at was stamped within
//    seconds) but the sender's own channel was rejoining — Supabase had shut
//    it down for too many presence updates (lib/walkie/state.ts PRESENCE_*),
//    so the partner's "got" never arrived. Now "ready" is re-sent a bounded
//    number of times, the row's receipts are re-read on the catch-up tick,
//    and the banner fires only for a row the server says is undelivered.

type Phase = "lobby" | "joining" | "on-air";
type Receipt = "sent" | "stalled" | "delivered" | "played";

interface WalkieMessage {
  id: string;
  sender_id: string;
  source_lang: string;
  target_lang: string;
  original_text: string;
  translation_text: string;
  speech_url: string | null;
  created_at: string;
  delivered_at: string | null;
  played_at: string | null;
}

const MESSAGE_FETCH_TIMEOUT_MS = 20_000;
const TURN_FETCH_TIMEOUT_MS = 210_000;

interface WalkieReceiptOut {
  id: string;
  delivered_at: string | null;
  played_at: string | null;
}

/** Where a channel lives in the address bar: the invite link and the on-air URL are the same thing. */
export function walkiePath(code: string): string {
  return code ? `/taokie/${code}` : "/taokie";
}

/** The room an invite put in the address bar: the path form, else the old ?room= form. Empty when neither. */
export function roomFromLocation(pathname: string, search: string): string {
  const fromPath = pathname.match(/^\/taokie\/([^/?#]+)\/?$/i)?.[1];
  const code = normalizeWalkieRoom(fromPath ? decodeURIComponent(fromPath) : new URLSearchParams(search).get("room"));
  return isWalkieRoom(code) ? code : "";
}

function displayNameOf(user: { email?: string | null; user_metadata?: Record<string, unknown> } | null | undefined): string {
  const meta = user?.user_metadata ?? {};
  for (const key of ["full_name", "name", "given_name"]) {
    const v = meta[key];
    if (typeof v === "string" && v.trim()) return v.trim().split(/\s+/)[0] ?? v.trim();
  }
  const local = (user?.email ?? "").split("@")[0] ?? "";
  return local || "—";
}

function receiptOf(m: WalkieMessage, local: Receipt | undefined): Receipt {
  if (local === "played" || m.played_at) return "played";
  if (local === "delivered" || m.delivered_at) return "delivered";
  return local ?? "sent";
}

export function WalkieShell({
  maxTurnMs = WALKIE_DEFAULT_MAX_TURN_MS,
  retentionDays = WALKIE_DEFAULT_RETENTION_DAYS,
  initialRoom
}: {
  /** TAOS_WALKIE_MAX_TURN_MS, read on the server by the page. */
  maxTurnMs?: number;
  /** TAOS_WALKIE_RETENTION_DAYS, likewise. */
  retentionDays?: number;
  /** The code in the path (/taokie/<code>): an invite. Goes on air by itself. */
  initialRoom?: string;
}): JSX.Element {
  const { pair, mine, theirs, pills, sheetOpen, setSheetOpen, selectLanguage } = useLanguagePair({
    lockMine: false
  });
  const s = copyFor(mine);

  const [me, setMe] = useState<{ id: string; name: string } | null>(null);
  const [room, setRoom] = useState("");
  const [copied, setCopied] = useState(false);
  const [phase, setPhase] = useState<Phase>("lobby");
  const [partner, setPartner] = useState<WalkiePeerState | null>(null);
  const [rec, setRec] = useState<ToggleState>("idle");
  const [sending, setSending] = useState(false);
  const [wrappingUp, setWrappingUp] = useState(false);
  const [messages, setMessages] = useState<WalkieMessage[]>([]);
  const [receipts, setReceipts] = useState<Record<string, Receipt>>({});
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [channelLost, setChannelLost] = useState(false);
  const [unlockNeeded, setUnlockNeeded] = useState<WalkieMessage | null>(null);
  const [notifyText, setNotifyText] = useState<boolean | null>(null);
  // The speaker is blessed only by a gesture. An invite joins without one,
  // so until the first tap the screen says so.
  const [soundReady, setSoundReady] = useState(false);
  const soundReadyRef = useRef(false);
  // The room an invite link carried: joined by itself, once.
  const inviteRef = useRef("");
  const autoJoinedRef = useRef(false);

  const phaseRef = useRef<Phase>("lobby");
  phaseRef.current = phase;
  const partnerRef = useRef<WalkiePeerState | null>(null);
  partnerRef.current = partner;
  const recRef = useRef<ToggleState>("idle");
  const sendingRef = useRef(false);
  const receiptsRef = useRef<Record<string, Receipt>>({});
  receiptsRef.current = receipts;
  const channelRef = useRef<WalkieChannel | null>(null);
  const chirpsRef = useRef<WalkieChirps | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const meRef = useRef<{ id: string; name: string } | null>(null);
  meRef.current = me;
  const mineRef = useRef<PairLangCode>(mine);
  mineRef.current = mine;
  const theirsRef = useRef<PairLangCode>(theirs);
  theirsRef.current = theirs;
  const roomRef = useRef("");
  roomRef.current = room;

  // The recorder — the home screen's, piece for piece.
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef("");
  const recordStartRef = useRef(0);
  const releasedAtRef = useRef(0);
  const cancelledRef = useRef<0 | 1>(0);
  const busyBlockedRef = useRef(0);
  const maxStopTimerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const pulsePhaseRef = useRef(0);
  const lastTickRef = useRef(0);
  const holdBtnRef = useRef<HTMLButtonElement | null>(null);
  const wakeStopRef = useRef<(() => void) | null>(null);
  const onAirWakeRef = useRef<(() => void) | null>(null);
  const ramp = rampWindows(maxTurnMs);

  // Delivery bookkeeping. `sentIds` says which messages left THIS phone —
  // the sender column cannot, when one account tests on two phones.
  const sentIdsRef = useRef<Set<string>>(new Set());
  const receivedIdsRef = useRef<Set<string>>(new Set());
  const knownIdsRef = useRef<Set<string>>(new Set());
  const lastCreatedRef = useRef<string | null>(null);
  const deliveryTimersRef = useRef<Map<string, number>>(new Map());
  const readyRetryTimersRef = useRef<Map<string, number[]>>(new Map());
  const sentAtRef = useRef<Map<string, number>>(new Map());
  const catchingUpRef = useRef(false);
  const playQueueRef = useRef<Array<{ m: WalkieMessage; releasedAt: number | null; readyAt: number }>>([]);
  const playingRef = useRef(false);

  // The 3-turn context window, keyed on the room: both directions of the
  // conversation count, and ten quiet minutes start it over.
  const contextRef = useRef<ContextStore>(EMPTY_CONTEXT);
  const sessionRef = useRef<ConversationSession | null>(null);

  // The log keeps the newest turn in view unless the reader scrolled up.
  const tail = useFollowTail<HTMLDivElement>(true, `${messages.length}:${playingId ?? ""}`);

  // ── Who am I, and which channel ─────────────────────────────────────────
  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      const user = data.session?.user;
      if (user) setMe({ id: user.id, name: displayNameOf(user) });
    });
    const fromLink = isWalkieRoom(normalizeWalkieRoom(initialRoom))
      ? normalizeWalkieRoom(initialRoom)
      : roomFromLocation(window.location.pathname, window.location.search);
    if (fromLink) {
      setRoom(fromLink);
      inviteRef.current = fromLink;
    }
    return () => {
      active = false;
    };
  }, [initialRoom]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/walkie/settings", { headers: await authHeaders(), cache: "no-store" });
        const payload = (await res.json().catch(() => ({}))) as { notifyText?: unknown };
        if (active && res.ok && typeof payload.notifyText === "boolean") setNotifyText(payload.notifyText);
      } catch {
        /* the toggle stays hidden */
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Announce a language change to the partner; their next turn follows it.
  useEffect(() => {
    channelRef.current?.setLanguage(mine);
  }, [mine]);

  // ── Audio out ───────────────────────────────────────────────────────────
  const ensureAudioEl = useCallback((): HTMLAudioElement | null => {
    if (!audioRef.current) {
      audioRef.current = typeof Audio !== "undefined" ? new Audio() : null;
      if (audioRef.current) {
        (audioRef.current as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
      }
    }
    return audioRef.current;
  }, []);

  // play() inside the "go on air" tap blesses the element so later
  // programmatic play() — an incoming turn, minutes from now — is allowed on
  // iOS Safari. The same trick /live uses (components/LiveShell.tsx).
  const blessAudio = useCallback(() => {
    const a = ensureAudioEl();
    if (!a) return;
    a.play().catch(() => {});
    a.pause();
  }, [ensureAudioEl]);

  /** Inside a gesture: unlock the chirps and bless the speaker, once. */
  const armSound = useCallback(() => {
    if (!chirpsRef.current) chirpsRef.current = createWalkieChirps();
    void chirpsRef.current.unlock();
    blessAudio();
    soundReadyRef.current = true;
    setSoundReady(true);
  }, [blessAudio]);

  /** Resolves "played" when the audio finished, "failed" when it never started. */
  const playSpeech = useCallback(
    (url: string, onStarted: () => void): Promise<"played" | "failed"> => {
      const a = ensureAudioEl();
      if (!a) return Promise.resolve("failed");
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
      a.src = url;
      return new Promise<"played" | "failed">((resolve) => {
        let started = false;
        a.onplaying = () => {
          if (!started) {
            started = true;
            onStarted();
          }
        };
        a.onended = () => resolve(started ? "played" : "failed");
        a.onerror = () => resolve("failed");
        a.play()
          .then(() => {
            // play() resolved: the element is allowed to play. On engines that
            // never fire "playing" for a short clip, ended still arrives.
            if (!started) {
              started = true;
              onStarted();
            }
          })
          .catch(() => resolve("failed"));
      });
    },
    [ensureAudioEl]
  );

  // ── Receipts and the log ────────────────────────────────────────────────
  const postAck = useCallback(
    async (
      id: string,
      kind: "delivered" | "played" | "failed",
      extra: Record<string, number | WalkieFailStage> = {}
    ) => {
      try {
        await fetch("/api/walkie/ack", {
          method: "POST",
          headers: await jsonAuthHeaders(),
          body: JSON.stringify({ id, kind, ...extra })
        });
      } catch {
        /* a lost receipt is not a lost message */
      }
    },
    []
  );

  const rememberExchange = useCallback((m: WalkieMessage) => {
    const now = Date.now();
    const roomId = normalizeWalkieRoom(roomRef.current) || "walkie";
    const prev = sessionRef.current;
    const session: ConversationSession =
      prev && now - prev.lastTurnAt <= 10 * 60 * 1000 ? { id: prev.id, lastTurnAt: now } : { id: roomId, lastTurnAt: now };
    sessionRef.current = session;
    contextRef.current = rememberTurn(contextRef.current, session.id, {
      source_lang: m.source_lang,
      target_lang: m.target_lang,
      original: m.original_text,
      translation: m.translation_text
    });
  }, []);

  const noteCreated = useCallback((iso: string) => {
    if (!lastCreatedRef.current || iso > lastCreatedRef.current) lastCreatedRef.current = iso;
  }, []);

  const appendMessage = useCallback(
    (m: WalkieMessage): boolean => {
      if (knownIdsRef.current.has(m.id)) return false;
      knownIdsRef.current.add(m.id);
      noteCreated(m.created_at);
      setMessages((list) => (list.some((x) => x.id === m.id) ? list : [...list, m]));
      rememberExchange(m);
      return true;
    },
    [noteCreated, rememberExchange]
  );

  const clearDeliveryTimer = useCallback((id: string) => {
    const t = deliveryTimersRef.current.get(id);
    if (t !== undefined) {
      window.clearTimeout(t);
      deliveryTimersRef.current.delete(id);
    }
    for (const r of readyRetryTimersRef.current.get(id) ?? []) window.clearTimeout(r);
    readyRetryTimersRef.current.delete(id);
  }, []);

  /**
   * What the server has stamped: ✓ / ✓✓ from the row, for when the broadcast
   * was lost. Returns the server's word per id, whatever this phone thought.
   */
  const applyReceipts = useCallback(
    (rows: WalkieReceiptOut[]): Map<string, Receipt> => {
      const stamped = new Map<string, Receipt>();
      const updates: Record<string, Receipt> = {};
      for (const r of rows) {
        const server: Receipt | null = r.played_at ? "played" : r.delivered_at ? "delivered" : null;
        if (!server) continue;
        stamped.set(r.id, server);
        const current = receiptsRef.current[r.id];
        if (current === "played" || current === server) continue;
        updates[r.id] = server;
        clearDeliveryTimer(r.id);
      }
      const ids = Object.keys(updates);
      if (ids.length > 0) {
        setReceipts((prev) => ({ ...prev, ...updates }));
        setError((e) => (e === s.walkieNotDelivered ? null : e));
      }
      return stamped;
    },
    [clearDeliveryTimer, s.walkieNotDelivered]
  );

  /** Own turns still short of ✓✓ and young enough to matter. */
  const pendingOwnIds = useCallback((): string[] => {
    const now = Date.now();
    const ids: string[] = [];
    for (const [id, at] of sentAtRef.current) {
      if (now - at > RECEIPT_REFRESH_WINDOW_MS) {
        sentAtRef.current.delete(id);
        continue;
      }
      if (receiptsRef.current[id] !== "played") ids.push(id);
    }
    return ids.slice(-10);
  }, []);

  /** Ask the server for the pending receipts. Empty when nothing is stamped, or it could not be asked. */
  const refreshReceipts = useCallback(async (): Promise<Map<string, Receipt>> => {
    const ids = pendingOwnIds();
    if (ids.length === 0) return new Map();
    try {
      const res = await fetchWithRetry(
        `/api/walkie/messages?ids=${encodeURIComponent(ids.join(","))}`,
        { headers: await authHeaders(), cache: "no-store" },
        { retries: 0, timeoutMs: MESSAGE_FETCH_TIMEOUT_MS }
      );
      const payload = (await res.json().catch(() => ({}))) as { receipts?: WalkieReceiptOut[] };
      if (!res.ok || !Array.isArray(payload.receipts)) return new Map();
      return applyReceipts(payload.receipts);
    } catch {
      return new Map();
    }
  }, [applyReceipts, pendingOwnIds]);

  // ── Playback: one at a time, in arrival order ───────────────────────────
  const drainPlayQueue = useCallback(async () => {
    if (playingRef.current) return;
    playingRef.current = true;
    try {
      for (;;) {
        const next = playQueueRef.current.shift();
        if (!next) break;
        const { m, releasedAt, readyAt } = next;
        if (!m.speech_url || phaseRef.current !== "on-air") continue;
        let deliverMs = -1;
        let releaseToPlayMs = -1;
        setPlayingId(m.id);
        const outcome = await playSpeech(m.speech_url, () => {
          deliverMs = Math.round(performance.now() - readyAt);
          if (releasedAt) releaseToPlayMs = Math.max(0, Date.now() - releasedAt);
        });
        setPlayingId(null);
        if (outcome === "failed") {
          // The speaker refused (iOS: the blessing was lost with the audio
          // session). Say so, offer the unlock tap, and log the stage.
          setUnlockNeeded(m);
          setError(s.walkiePlaybackFailed);
          void postAck(m.id, "failed", { stage: "playback" });
          continue;
        }
        chirpsRef.current?.roger();
        channelRef.current?.sendPlayed(m.id);
        const extra: Record<string, number> = {};
        if (deliverMs >= 0) extra.deliver_ms = deliverMs;
        if (releaseToPlayMs >= 0) extra.release_to_play_ms = releaseToPlayMs;
        void postAck(m.id, "played", extra);
      }
    } finally {
      playingRef.current = false;
    }
  }, [playSpeech, postAck, s.walkiePlaybackFailed]);

  /** A partner's turn is in hand: show it, confirm it, queue it to play. */
  const deliver = useCallback(
    (m: WalkieMessage, releasedAt: number | null, readyAt: number) => {
      if (sentIdsRef.current.has(m.id)) return; // our own, echoed by a poll
      receivedIdsRef.current.add(m.id);
      const fresh = appendMessage(m);
      if (!fresh) return;
      channelRef.current?.sendGot(m.id);
      void postAck(m.id, "delivered");
      if (!m.speech_url || phaseRef.current !== "on-air") return;
      playQueueRef.current.push({ m, releasedAt, readyAt });
      void drainPlayQueue();
    },
    [appendMessage, drainPlayQueue, postAck]
  );

  // An incoming "ready": fetch it and deliver it.
  const receiveTurn = useCallback(
    async (id: string, releasedAt: number | null) => {
      const readyAt = performance.now();
      if (knownIdsRef.current.has(id)) return;
      let m: WalkieMessage | null = null;
      try {
        const res = await fetchWithRetry(
          `/api/walkie/messages?id=${encodeURIComponent(id)}`,
          { headers: await authHeaders(), cache: "no-store" },
          { retries: 2, timeoutMs: MESSAGE_FETCH_TIMEOUT_MS }
        );
        const payload = (await res.json().catch(() => ({}))) as { message?: WalkieMessage };
        if (res.ok && payload.message) m = payload.message;
      } catch {
        m = null;
      }
      // Not fetched: the catch-up poll will find it by created_at.
      if (!m) return;
      deliver(m, releasedAt, readyAt);
    },
    [deliver]
  );

  // The catch-up: anything in the room newer than what this phone has. A
  // "ready" that found this socket asleep is otherwise gone for good.
  const catchUp = useCallback(async (): Promise<number> => {
    const code = normalizeWalkieRoom(roomRef.current);
    if (!code || catchingUpRef.current) return 0;
    catchingUpRef.current = true;
    try {
      const after = lastCreatedRef.current;
      const qs = `room=${encodeURIComponent(code)}${after ? `&after=${encodeURIComponent(after)}` : ""}`;
      const res = await fetchWithRetry(
        `/api/walkie/messages?${qs}`,
        { headers: await authHeaders(), cache: "no-store" },
        { retries: 0, timeoutMs: MESSAGE_FETCH_TIMEOUT_MS }
      );
      const payload = (await res.json().catch(() => ({}))) as { messages?: WalkieMessage[] };
      if (!res.ok || !Array.isArray(payload.messages)) return 0;
      const readyAt = performance.now();
      let found = 0;
      for (const m of payload.messages) {
        if (knownIdsRef.current.has(m.id)) continue;
        if (!after) {
          // First load: history, shown but not played.
          appendMessage(m);
          continue;
        }
        found += 1;
        // Ours: sent from this phone, or from this account while this phone's
        // upload is still in flight (the row lands before the response does).
        // One account on two phones is how Tom tests, so the sender column
        // alone cannot say whose a row is.
        const ours = sentIdsRef.current.has(m.id) || (sendingRef.current && meRef.current?.id === m.sender_id);
        if (ours) {
          appendMessage(m);
          continue;
        }
        deliver(m, null, readyAt);
      }
      return found;
    } catch {
      return 0;
    } finally {
      catchingUpRef.current = false;
      // And the other direction: receipts the partner stamped that this
      // phone's socket never heard about.
      void refreshReceipts();
    }
  }, [appendMessage, deliver, refreshReceipts]);

  const replay = useCallback(
    async (m: WalkieMessage) => {
      if (!m.speech_url || playingId) return;
      setPlayingId(m.id);
      const outcome = await playSpeech(m.speech_url, () => undefined);
      setPlayingId(null);
      if (outcome === "failed") {
        setUnlockNeeded(m);
        setError(s.walkiePlaybackFailed);
      }
    },
    [playSpeech, playingId, s.walkiePlaybackFailed]
  );

  // ── On air / off air ────────────────────────────────────────────────────
  const leaveChannel = useCallback(async () => {
    const ch = channelRef.current;
    channelRef.current = null;
    onAirWakeRef.current?.();
    onAirWakeRef.current = null;
    for (const t of deliveryTimersRef.current.values()) window.clearTimeout(t);
    deliveryTimersRef.current.clear();
    for (const list of readyRetryTimersRef.current.values()) for (const r of list) window.clearTimeout(r);
    readyRetryTimersRef.current.clear();
    playQueueRef.current = [];
    await ch?.leave();
    setPartner(null);
    setChannelLost(false);
    setPhase("lobby");
    inviteRef.current = "";
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/taokie/")) {
      window.history.replaceState(null, "", walkiePath(""));
    }
  }, []);

  const goOnAir = useCallback(async (opts: { gesture: boolean } = { gesture: true }) => {
    const code = normalizeWalkieRoom(room);
    if (!code) return;
    setError(null);
    setNotice(null);
    setUnlockNeeded(null);
    setChannelLost(false);
    setPhase("joining");
    // Inside the tap, before any await: the whole reason this button exists.
    // An invite joins WITHOUT a tap, so it cannot do this part; the first
    // gesture on the screen does (see onAnyTap).
    if (opts.gesture) armSound();
    try {
      // The log first, so a partner's turns from before this phone arrived
      // are on screen before the channel starts delivering live ones.
      try {
        const res = await fetchWithRetry(
          `/api/walkie/messages?room=${encodeURIComponent(code)}`,
          { headers: await authHeaders(), cache: "no-store" },
          { retries: 1, timeoutMs: MESSAGE_FETCH_TIMEOUT_MS }
        );
        const payload = (await res.json().catch(() => ({}))) as { messages?: WalkieMessage[]; error?: string };
        if (!res.ok) throw new Error(payload.error || s.walkieFailed);
        const list = Array.isArray(payload.messages) ? payload.messages : [];
        for (const m of list) {
          knownIdsRef.current.add(m.id);
          noteCreated(m.created_at);
        }
        setMessages(list);
      } catch (e) {
        setError(isConnectionError(e) ? s.connectionLost : e instanceof Error ? e.message : s.walkieFailed);
      }
      const channel = await joinWalkieChannel(
        { room: code, lang: mineRef.current, name: meRef.current?.name ?? "—", maxTurnMs },
        {
          onPartner: (state) => setPartner(state),
          onHoldExpired: () => setNotice(fill(s.walkieHoldExpired, { name: partnerRef.current?.name || "—" })),
          onStatus: (status) => {
            if (status === "lost") {
              setChannelLost(true);
              setError(s.walkieChannelLost);
            } else {
              setChannelLost(false);
              setError((e) => (e === s.walkieChannelLost ? null : e));
              setNotice(s.walkieChannelBack);
              void catchUp();
            }
          },
          onReady: ({ id, releasedAt }) => void receiveTurn(id, releasedAt),
          onGot: (id) => {
            clearDeliveryTimer(id);
            setReceipts((r) => (r[id] === "played" ? r : { ...r, [id]: "delivered" }));
            setError((e) => (e === s.walkieNotDelivered ? null : e));
          },
          onPlayed: (id) => {
            clearDeliveryTimer(id);
            setReceipts((r) => ({ ...r, [id]: "played" }));
            setError((e) => (e === s.walkieNotDelivered ? null : e));
          },
          onError: (message) => {
            setError(message);
            void leaveChannel();
          }
        }
      );
      channelRef.current = channel;
      // On air = a session: the screen stays awake (lib/wakeLock.ts keeps
      // the lock refreshed and drops it a minute after we leave).
      onAirWakeRef.current?.();
      onAirWakeRef.current = keepWake("walkie-on-air");
      setPhase("on-air");
      window.history.replaceState(null, "", walkiePath(code));
    } catch (e) {
      setError(e instanceof Error ? e.message : s.walkieFailed);
      setPhase("lobby");
    }
  }, [
    armSound,
    catchUp,
    clearDeliveryTimer,
    leaveChannel,
    maxTurnMs,
    noteCreated,
    receiveTurn,
    room,
    s.connectionLost,
    s.walkieChannelBack,
    s.walkieChannelLost,
    s.walkieFailed,
    s.walkieHoldExpired,
    s.walkieNotDelivered
  ]);

  // An invite goes on air by itself — once, after this phone knows who it is
  // (the name travels in presence). A gesture is still owed for the speaker.
  useEffect(() => {
    const invite = inviteRef.current;
    if (!invite || autoJoinedRef.current || !me || phase !== "lobby") return;
    if (normalizeWalkieRoom(room) !== invite) return;
    autoJoinedRef.current = true;
    void goOnAir({ gesture: false });
  }, [goOnAir, me, phase, room]);

  // Resync: re-announce, re-read the partner, fetch what was missed. If the
  // socket is gone, rejoin outright.
  const resync = useCallback(async () => {
    setNotice(null);
    const ch = channelRef.current;
    if (!ch || !ch.resync()) {
      await leaveChannel();
      await goOnAir();
      return;
    }
    await catchUp();
    setError((e) => (e === s.walkieChannelLost ? null : e));
    setNotice(s.walkieResynced);
  }, [catchUp, goOnAir, leaveChannel, s.walkieChannelLost, s.walkieResynced]);

  // While on air: poll for missed turns, and catch up on every return to the
  // foreground (a sleeping phone's socket heard nothing).
  useEffect(() => {
    if (phase !== "on-air") return;
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void catchUp();
    };
    const interval = window.setInterval(tick, CATCH_UP_EVERY_MS);
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const ch = channelRef.current;
      if (ch && !ch.isJoined()) setChannelLost(true);
      void catchUp();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [catchUp, phase]);

  useEffect(() => {
    const deliveryTimers = deliveryTimersRef.current;
    const readyRetryTimers = readyRetryTimersRef.current;
    return () => {
      void channelRef.current?.leave();
      chirpsRef.current?.close();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      wakeStopRef.current?.();
      onAirWakeRef.current?.();
      for (const t of deliveryTimers.values()) window.clearTimeout(t);
      for (const list of readyRetryTimers.values()) for (const r of list) window.clearTimeout(r);
    };
  }, []);

  // ── The turn: tap to talk, tap to send ──────────────────────────────────
  function setRecState(next: ToggleState) {
    recRef.current = next;
    setRec(next);
  }

  function resetHoldButtonStyle() {
    const btn = holdBtnRef.current;
    if (btn) {
      btn.style.transform = "";
      btn.style.boxShadow = "";
    }
  }

  function tickRamp() {
    const now = performance.now();
    const remaining = maxTurnMs - (now - recordStartRef.current);
    const btn = holdBtnRef.current;
    setWrappingUp(remaining <= ramp.early);
    if (btn) {
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      if (remaining > ramp.early) {
        resetHoldButtonStyle();
      } else {
        const urgent = remaining <= ramp.fast;
        const period = pulsePeriod(remaining, ramp);
        let wave: number;
        if (reduceMotion) wave = urgent ? 1 : 0.5;
        else {
          const dt = now - (lastTickRef.current || now);
          pulsePhaseRef.current += (dt / period) * Math.PI * 2;
          wave = (Math.sin(pulsePhaseRef.current) + 1) / 2;
        }
        const style = rampStyle(remaining, wave, ramp, reduceMotion);
        btn.style.transform = style.transform;
        btn.style.boxShadow = style.boxShadow;
      }
    }
    lastTickRef.current = now;
    if (remaining <= 0) {
      // Hard cap: the turn sends itself. The setTimeout below is the backstop.
      endTurn("cap");
      return;
    }
    rafRef.current = requestAnimationFrame(tickRamp);
  }

  function clearRecordingTimers() {
    if (maxStopTimerRef.current !== null) {
      window.clearTimeout(maxStopTimerRef.current);
      maxStopTimerRef.current = null;
    }
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    resetHoldButtonStyle();
  }

  function armFailed(message: string) {
    setRecState(toggleStep(recRef.current, "arm_failed").state);
    channelRef.current?.setHolding(false);
    wakeStopRef.current?.();
    wakeStopRef.current = null;
    setError(message);
  }

  async function startRecording() {
    setError(null);
    setNotice(null);
    wakeStopRef.current?.();
    wakeStopRef.current = keepWake("walkie-mic");
    // The partner locks the moment the tap lands, not when the mic opens.
    channelRef.current?.setHolding(true);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      armFailed(s.micUnavailable);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (recRef.current !== "arming") {
        // Left the channel while the mic was opening: let it go.
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      const mime = pickMimeType();
      mimeRef.current = mime;
      const opts: MediaRecorderOptions = { audioBitsPerSecond: AUDIO_BITS_PER_SECOND };
      if (mime) opts.mimeType = mime;
      const recorder = new MediaRecorder(stream, opts);
      chunksRef.current = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      recorder.onstop = () => void handleRecordingStopped();
      // iOS ends the mic track SILENTLY on an audio-session interruption;
      // both paths finish the turn with whatever was heard (home does the same).
      recorder.onerror = () => endTurn("cancel");
      for (const track of stream.getAudioTracks()) {
        track.onended = () => endTurn("cancel");
      }
      recorder.start(1000);
      recorderRef.current = recorder;
      setRecState(toggleStep(recRef.current, "armed").state);
      clearRecordingTimers();
      recordStartRef.current = performance.now();
      cancelledRef.current = 0;
      pulsePhaseRef.current = 0;
      lastTickRef.current = 0;
      setWrappingUp(false);
      maxStopTimerRef.current = window.setTimeout(() => endTurn("cap"), maxTurnMs);
      rafRef.current = requestAnimationFrame(tickRamp);
    } catch {
      armFailed(s.walkieMicDenied);
    }
  }

  /** The one way a turn ends. The machine decides whether this event counts. */
  function endTurn(reason: "tap" | "cap" | "cancel") {
    const step = toggleStep(recRef.current, reason);
    setRecState(step.state);
    if (!step.effect) return;
    clearRecordingTimers();
    setWrappingUp(false);
    cancelledRef.current = step.effect === "stop_cancelled" ? 1 : 0;
    const recorder = recorderRef.current;
    releasedAtRef.current = Date.now();
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    } else {
      // The recorder is already gone (the OS ended the track and the
      // recorder stopped itself): finish from what was collected.
      void handleRecordingStopped();
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    wakeStopRef.current?.();
    wakeStopRef.current = null;
    channelRef.current?.setHolding(false);
  }

  async function handleRecordingStopped() {
    if (recRef.current !== "stopping") return; // onstop after we already finished
    const mime = mimeRef.current || "audio/webm";
    const blob = new Blob(chunksRef.current, { type: mime });
    recorderRef.current = null;
    chunksRef.current = [];
    setRecState(toggleStep(recRef.current, "stopped").state);
    const turnMs = Math.round(performance.now() - recordStartRef.current);
    if (turnMs < MIN_TURN_DURATION_MS) {
      setError(s.walkieTooShort);
      return;
    }
    if (blob.size === 0) {
      setError(s.noAudio);
      return;
    }
    await sendTurn(blob, mime, turnMs);
  }

  async function sendTurn(blob: Blob, mime: string, recMs: number) {
    const code = normalizeWalkieRoom(roomRef.current);
    const source = mineRef.current;
    // The PARTNER's language is the target — from their presence when they
    // are here, else this phone's idea of the other side of the pair.
    const partnerLang = partnerRef.current?.lang;
    const target = partnerLang && partnerLang !== source ? partnerLang : theirsRef.current;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("audio", blob, fileNameFor(mime));
      form.append("room", code);
      form.append("sourceLanguage", source);
      form.append("targetLanguage", target);
      form.append("engine", SUBSCRIBER_DEFAULT_ENGINE);
      form.append("rec_ms", String(recMs));
      form.append("released_at", String(releasedAtRef.current || Date.now()));
      form.append("busy_blocked", String(busyBlockedRef.current));
      form.append("cancelled", String(cancelledRef.current));
      const context = contextForNextTurn(contextRef.current, sessionRef.current, Date.now());
      if (context.length > 0) form.append("context", JSON.stringify(context));
      const post = async () =>
        fetchWithRetry(
          "/api/walkie/turn",
          {
            method: "POST",
            headers: { ...(await authHeaders()), ...personalVoiceHeaders(), ...ttsDeviceHeaders("walkie") },
            body: form
          },
          { retries: 1, timeoutMs: TURN_FETCH_TIMEOUT_MS }
        );
      let res = await post();
      if (res.status === 401) {
        // One 401 on 2026-11-02: a token that had just lapsed. Refresh the
        // session and send the same recording once more rather than lose it.
        await supabase.auth.refreshSession().catch(() => null);
        res = await post();
      }
      const payload = (await res.json().catch(() => ({}))) as {
        message?: WalkieMessage;
        tts_failed?: boolean;
        error?: string;
        details?: string;
      };
      if (!res.ok || !payload.message) throw new Error(payload.details || payload.error || s.walkieFailed);
      const sent = payload.message;
      busyBlockedRef.current = 0;
      sentIdsRef.current.add(sent.id);
      sentAtRef.current.set(sent.id, Date.now());
      appendMessage(sent);
      setReceipts((r) => ({ ...r, [sent.id]: "sent" }));
      if (payload.tts_failed) setError(s.walkieVoiceFailed);
      const releasedAt = releasedAtRef.current || null;
      channelRef.current?.sendReady(sent.id, releasedAt);
      // A "ready" that fell into a rejoin gap is re-sent, a bounded number
      // of times, until the partner's "got" arrives.
      readyRetryTimersRef.current.set(
        sent.id,
        READY_RETRY_AT_MS.map((at) =>
          window.setTimeout(() => {
            const r = receiptsRef.current[sent.id];
            if (r === "delivered" || r === "played") return;
            channelRef.current?.sendReady(sent.id, releasedAt);
          }, at)
        )
      );
      // Nobody picked it up inside the window? Ask the server before saying
      // so: the partner may have it while THIS phone's socket missed the
      // "got". Only a row the server says is undelivered earns the banner.
      deliveryTimersRef.current.set(
        sent.id,
        window.setTimeout(() => {
          deliveryTimersRef.current.delete(sent.id);
          void (async () => {
            const r = receiptsRef.current[sent.id];
            if (r === "delivered" || r === "played") return;
            if ((await refreshReceipts()).has(sent.id)) return; // the partner has it; only this phone's socket missed it
            const after = receiptsRef.current[sent.id];
            if (after === "delivered" || after === "played") return; // the "got" landed meanwhile
            clearDeliveryTimer(sent.id);
            setReceipts((prev) => ({ ...prev, [sent.id]: "stalled" }));
            setError(s.walkieNotDelivered);
            void postAck(sent.id, "failed", { stage: "deliver" });
          })();
        }, DELIVERY_WAIT_MS)
      );
    } catch (e) {
      setError(isConnectionError(e) ? s.connectionLost : e instanceof Error ? e.message : s.walkieFailed);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  const conditions = {
    onAir: phase === "on-air",
    joined: Boolean(channelRef.current) && !channelLost,
    partnerHolding: Boolean(partner?.holding),
    sending
  };
  const holdAllowed = canHold(conditions);
  const recording = rec === "arming" || rec === "recording";

  // pointerdown, never click and never up: the chirp and the mic belong to
  // the gesture, and a tap must not depend on where the finger lifts.
  function onTap(ev: ReactPointerEvent<HTMLButtonElement>) {
    if (ev.button !== undefined && ev.button !== 0) return;
    ev.preventDefault();
    const state = recRef.current;
    if (state === "recording") {
      endTurn("tap");
      return;
    }
    if (state !== "idle") return; // arming or stopping: this tap changes nothing
    const refusal = holdRefusal({
      onAir: phaseRef.current === "on-air",
      joined: Boolean(channelRef.current?.isJoined()),
      partnerHolding: Boolean(partnerRef.current?.holding),
      sending: sendingRef.current
    });
    if (refusal) {
      if (refusal === "partner-holding") busyBlockedRef.current += 1;
      chirpsRef.current?.busy();
      return;
    }
    const step = toggleStep(state, "tap");
    setRecState(step.state);
    if (step.effect !== "start") return;
    chirpsRef.current?.keyDown();
    void startRecording();
  }

  function onTapCancel(ev: ReactPointerEvent<HTMLButtonElement>) {
    ev.preventDefault();
    // pointercancel = the OS took the gesture (a scroll, an incoming call).
    // While recording that sends what was heard; while arming or idle it is
    // nothing — the machine says so.
    endTurn("cancel");
  }

  async function shareChannel() {
    const code = normalizeWalkieRoom(room);
    if (!code) return;
    const url = `${window.location.origin}${walkiePath(code)}`;
    const nav = navigator as Navigator & { share?: (d: { url: string; title?: string }) => Promise<void> };
    try {
      if (nav.share) await nav.share({ url, title: "Taokie" });
      else {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      /* user cancelled the share sheet */
    }
  }

  async function toggleNotifyText() {
    if (notifyText === null) return;
    const next = !notifyText;
    setNotifyText(next);
    try {
      const res = await fetch("/api/walkie/settings", {
        method: "POST",
        headers: await jsonAuthHeaders(),
        body: JSON.stringify({ notifyText: next })
      });
      if (!res.ok) setNotifyText(!next);
    } catch {
      setNotifyText(!next);
    }
  }

  // The speaker refused a turn: this tap re-blesses the element and plays it.
  function unlockAndReplay() {
    const m = unlockNeeded;
    armSound();
    setUnlockNeeded(null);
    setError((e) => (e === s.walkiePlaybackFailed ? null : e));
    if (m) void replay(m);
  }

  // The first gesture anywhere on the screen blesses the speaker — an invite
  // joined without one. pointerdown, like the button: it is the gesture.
  function onAnyTap() {
    if (soundReadyRef.current) return;
    armSound();
  }

  const partnerName = partner?.name || "—";
  const hearLang = languageNative(mine);
  const theyHearLang = languageNative(partner?.lang && partner.lang !== mine ? partner.lang : theirs);
  const onAir = phase === "on-air";
  const isOwn = (m: WalkieMessage): boolean =>
    sentIdsRef.current.has(m.id) || (!receivedIdsRef.current.has(m.id) && me !== null && m.sender_id === me.id);

  return (
    <main
      onPointerDownCapture={onAnyTap}
      className="min-h-screen px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-[calc(env(safe-area-inset-top)+1rem)]"
    >
      <div className="mx-auto flex min-h-[calc(100dvh-3rem)] max-w-md flex-col gap-4">
        <header className="flex items-center justify-between gap-3">
          <ExitHome lang={mine} />
          <div className="min-w-0 text-right">
            <h1 className="text-lg font-semibold text-amber-200">{s.walkieTitle}</h1>
            <p className="truncate text-[11px] text-amber-100/50">{s.walkieTagline}</p>
          </div>
        </header>

        {/* The pair: your side outlined, the other side solid — the row every
            screen shares. "Theirs" is the fallback target until the partner's
            presence says what they actually speak. */}
        <LanguagePillRow
          pills={pills}
          selected={theirs}
          paired={mine}
          caption={fill(s.walkieTheyHear, { language: theyHearLang })}
          labels={s}
          sheetOpen={sheetOpen}
          onSelect={selectLanguage}
          onOpenSheet={() => setSheetOpen(true)}
        />
        <p className="-mt-2 text-xs text-amber-100/50">{fill(s.walkieYouHear, { language: hearLang })}</p>

        {/* ── Lobby: the channel code ─────────────────────────────────── */}
        {!onAir ? (
          <section className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <label className="text-xs uppercase tracking-wide text-amber-100/60" htmlFor="walkie-room">
              {s.walkieChannel}
            </label>
            <div className="flex gap-2">
              <input
                id="walkie-room"
                value={room}
                onChange={(e) => setRoom(normalizeWalkieRoom(e.target.value))}
                placeholder={s.walkieCodePlaceholder}
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                inputMode="text"
                className="min-h-[44px] flex-1 rounded-xl border border-amber-300/30 bg-stone-950 px-3 font-mono text-lg tracking-widest text-amber-100"
              />
              <button
                type="button"
                onClick={() => {
                  setRoom(generateRoomCode());
                  setCopied(false);
                }}
                className="min-h-[44px] rounded-xl border border-amber-300/30 px-3 text-sm text-amber-200"
              >
                {s.walkieNewChannel}
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void shareChannel()}
                disabled={!room}
                className="min-h-[44px] rounded-xl border border-amber-300/30 px-3 text-sm text-amber-200 disabled:opacity-40"
              >
                {copied ? s.walkieCopied : s.walkieShareChannel}
              </button>
              <button
                type="button"
                data-walkie-on-air=""
                onClick={() => void goOnAir()}
                disabled={!room || phase === "joining"}
                className="min-h-[44px] flex-1 rounded-xl bg-emerald-400 px-4 text-sm font-semibold text-stone-950 transition active:scale-[0.99] disabled:opacity-40"
              >
                {phase === "joining" ? s.working : s.walkieGoOnAir}
              </button>
            </div>
            <p className="text-xs text-amber-100/50">{s.walkieGoOnAirHint}</p>
          </section>
        ) : null}

        {/* ── Presence line + Resync ──────────────────────────────────── */}
        {onAir ? (
          <div className="flex items-stretch gap-2">
            <div
              data-walkie-presence=""
              className={`min-w-0 flex-1 rounded-xl border px-3 py-2 text-sm ${
                channelLost
                  ? "border-rose-400/40 bg-rose-500/10 text-rose-100"
                  : partner?.holding
                    ? "border-amber-300/50 bg-amber-400/15 text-amber-100"
                    : partner
                      ? "border-emerald-300/30 bg-emerald-400/10 text-emerald-100"
                      : "border-white/10 bg-white/[0.03] text-amber-100/60"
              }`}
            >
              {channelLost
                ? s.walkieChannelLost
                : partner?.holding
                  ? fill(s.walkiePartnerTalking, { name: partnerName })
                  : partner
                    ? fill(s.walkiePartnerHere, { name: partnerName })
                    : s.walkieWaiting}
            </div>
            <button
              type="button"
              data-walkie-resync=""
              onClick={() => void resync()}
              title={s.walkieResyncHint}
              className={`min-h-[44px] shrink-0 rounded-xl border px-3 text-sm ${
                channelLost ? "border-rose-300/60 bg-rose-400/20 text-rose-50" : "border-amber-300/30 text-amber-200"
              }`}
            >
              {s.walkieResync}
            </button>
          </div>
        ) : null}

        {onAir && !soundReady ? (
          <button
            type="button"
            data-walkie-sound-off=""
            onClick={armSound}
            className="min-h-[44px] rounded-xl border border-amber-300/50 bg-amber-400/15 px-3 text-sm text-amber-100"
          >
            🔈 {s.walkieSoundOff}
          </button>
        ) : null}

        {error ? (
          <div
            role="alert"
            data-walkie-error=""
            className="flex flex-col gap-2 rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-100"
          >
            <span>{error}</span>
            {unlockNeeded ? (
              <button
                type="button"
                data-walkie-unlock=""
                onClick={unlockAndReplay}
                className="min-h-[44px] rounded-xl bg-emerald-400 px-4 text-sm font-semibold text-stone-950"
              >
                {s.walkieGoOnAir}
              </button>
            ) : null}
          </div>
        ) : null}
        {notice ? <p className="text-sm text-amber-100/70">{notice}</p> : null}

        {/* ── The log: oldest first, follows the tail ──────────────────── */}
        <div className="relative min-h-[8rem] flex-1">
          <div
            ref={tail.ref}
            data-walkie-log=""
            className="absolute inset-0 flex flex-col gap-2 overflow-y-auto rounded-2xl border border-white/10 bg-white/[0.02] p-3 [overflow-anchor:none]"
          >
            {messages.length === 0 ? (
              <p className="m-auto text-center text-sm text-amber-100/50">{s.walkieNothingYet}</p>
            ) : (
              messages.map((m) => {
                const own = isOwn(m);
                const text = own ? m.original_text : m.translation_text;
                const receipt = receiptOf(m, receipts[m.id]);
                return (
                  <div
                    key={m.id}
                    data-walkie-msg={own ? "own" : "partner"}
                    className={`flex max-w-[88%] flex-col gap-1 rounded-2xl px-3 py-2 text-sm ${
                      own ? "self-end bg-amber-400/15 text-amber-50" : "self-start bg-white/[0.06] text-amber-50"
                    }`}
                  >
                    <p className="whitespace-pre-wrap">{text}</p>
                    <div className="flex items-center justify-between gap-3 text-[11px] text-amber-100/50">
                      <span data-walkie-receipt={own ? receipt : undefined}>
                        {own
                          ? receipt === "played"
                            ? `✓✓ ${s.walkiePlayed}`
                            : receipt === "delivered"
                              ? `✓ ${s.walkieDelivered}`
                              : receipt === "stalled"
                                ? `! ${s.walkieStalled}`
                                : "…"
                          : languageNative(m.source_lang)}
                      </span>
                      {m.speech_url ? (
                        <button
                          type="button"
                          onClick={() => void replay(m)}
                          disabled={playingId !== null}
                          aria-label={s.walkieReplay}
                          className="min-h-[32px] rounded-full border border-amber-300/30 px-2 text-amber-200 disabled:opacity-40"
                        >
                          {playingId === m.id ? "▶…" : "▶"}
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <JumpToTail show={tail.detached} onJump={tail.jumpToTail} />
        </div>

        {/* ── The button ──────────────────────────────────────────────── */}
        {onAir ? (
          <div className="flex flex-col items-center gap-3">
            <button
              ref={holdBtnRef}
              type="button"
              data-walkie-hold=""
              data-walkie-rec={rec}
              aria-pressed={recording}
              aria-disabled={!holdAllowed && !recording}
              onPointerDown={onTap}
              onPointerCancel={onTapCancel}
              onContextMenu={(ev) => ev.preventDefault()}
              style={{ WebkitTouchCallout: "none", userSelect: "none", WebkitUserSelect: "none", touchAction: "none" }}
              className={`flex h-40 w-40 select-none touch-none items-center justify-center rounded-full border-4 text-center text-base font-bold uppercase tracking-wide transition ${
                recording
                  ? "border-amber-300 bg-amber-400 text-stone-950"
                  : !holdAllowed
                    ? "border-white/10 bg-white/[0.04] text-amber-100/40"
                    : "border-emerald-300 bg-emerald-400 text-stone-950 active:scale-[0.98]"
              }`}
            >
              {recording || rec === "stopping"
                ? s[toggleLabelKey(rec)]
                : sending
                  ? s.walkieSending
                  : partner?.holding
                    ? s.walkieBusy
                    : s.walkieHold}
            </button>
            {wrappingUp ? <p className="text-xs text-amber-200">{s.wrapUp}</p> : null}
            <button
              type="button"
              onClick={() => {
                if (recRef.current === "recording") endTurn("cancel");
                void leaveChannel();
                setNotice(s.walkieLeftChannel);
              }}
              className="min-h-[44px] text-sm text-amber-100/60 underline-offset-4 hover:underline"
            >
              {s.walkieOffAir}
            </button>
          </div>
        ) : null}

        {/* ── Settings and the retention note ──────────────────────────── */}
        <section className="flex flex-col gap-2 text-xs text-amber-100/50">
          {notifyText !== null ? (
            <label className="flex min-h-[44px] items-center justify-between gap-3">
              <span>
                {s.walkieNotifyText}
                <br />
                <span className="text-amber-100/40">{s.walkieNotifyTextHint}</span>
              </span>
              <input
                type="checkbox"
                data-walkie-notify-text=""
                checked={notifyText}
                onChange={() => void toggleNotifyText()}
                className="h-5 w-5 accent-amber-400"
              />
            </label>
          ) : null}
          <p>{fill(s.walkieRetention, { days: retentionDays })}</p>
          {mine === "es" ? <p className="text-amber-100/30">Textos en español pendientes de revisión por Liz.</p> : null}
        </section>
      </div>

      <LanguageSheet
        open={sheetOpen}
        selected={theirs}
        paired={mine}
        caption={s.walkieChannel}
        labels={s}
        onSelect={selectLanguage}
        onClose={() => setSheetOpen(false)}
      />
    </main>
  );
}
