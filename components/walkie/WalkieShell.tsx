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
import { normalizeWalkieRoom } from "@/lib/walkie/room";
import { canHold, holdRefusal } from "@/lib/walkie/state";

// ── /taokie: the push-to-talk translation walkie ────────────────────────────
// Two founders in a channel. Hold the big button, talk, let go: the turn
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
// ── iPhone, in particular ──────────────────────────────────────────────────
// Hold-to-talk IS a long press, and the iOS long-press cue is the lead
// suspect in the open tap-eating bug. The button uses pointer events (never
// click), captures the pointer so a finger that drifts still releases here,
// carries -webkit-touch-callout/user-select/touch-action none, and treats
// pointercancel as a release: what was recorded is SENT, never dropped.

type Phase = "lobby" | "joining" | "on-air";
type Receipt = "sent" | "delivered" | "played";

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
  return "sent";
}

export function WalkieShell({
  maxTurnMs = WALKIE_DEFAULT_MAX_TURN_MS,
  retentionDays = WALKIE_DEFAULT_RETENTION_DAYS
}: {
  /** TAOS_WALKIE_MAX_TURN_MS, read on the server by the page. */
  maxTurnMs?: number;
  /** TAOS_WALKIE_RETENTION_DAYS, likewise. */
  retentionDays?: number;
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
  const [holding, setHolding] = useState(false);
  const [sending, setSending] = useState(false);
  const [wrappingUp, setWrappingUp] = useState(false);
  const [messages, setMessages] = useState<WalkieMessage[]>([]);
  const [receipts, setReceipts] = useState<Record<string, Receipt>>({});
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [notifyText, setNotifyText] = useState<boolean | null>(null);

  const phaseRef = useRef<Phase>("lobby");
  phaseRef.current = phase;
  const partnerRef = useRef<WalkiePeerState | null>(null);
  partnerRef.current = partner;
  const sendingRef = useRef(false);
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
  const ramp = rampWindows(maxTurnMs);

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
    const q = new URLSearchParams(window.location.search).get("room");
    if (q) setRoom(normalizeWalkieRoom(q));
    return () => {
      active = false;
    };
  }, []);

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

  const playSpeech = useCallback(
    (url: string, onStarted: () => void): Promise<void> => {
      const a = ensureAudioEl();
      if (!a) return Promise.resolve();
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
      a.src = url;
      return new Promise<void>((resolve) => {
        let started = false;
        a.onplaying = () => {
          if (!started) {
            started = true;
            onStarted();
          }
        };
        a.onended = () => resolve();
        a.onerror = () => resolve();
        a.play().catch(() => resolve());
      });
    },
    [ensureAudioEl]
  );

  // ── Receipts and the log ────────────────────────────────────────────────
  const postAck = useCallback(
    async (id: string, kind: "delivered" | "played", extra: Record<string, number> = {}) => {
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
    const roomId = normalizeWalkieRoom(room) || "walkie";
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
  }, [room]);

  const appendMessage = useCallback(
    (m: WalkieMessage) => {
      setMessages((list) => (list.some((x) => x.id === m.id) ? list : [...list, m]));
      rememberExchange(m);
    },
    [rememberExchange]
  );

  // An incoming turn: fetch it, confirm it, play it, confirm that too.
  const receiveTurn = useCallback(
    async (id: string, releasedAt: number | null) => {
      const readyAt = performance.now();
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
      if (!m) return;
      appendMessage(m);
      channelRef.current?.sendGot(id);
      void postAck(id, "delivered");
      if (!m.speech_url || phaseRef.current !== "on-air") return;

      let deliverMs = -1;
      let releaseToPlayMs = -1;
      setPlayingId(id);
      await playSpeech(m.speech_url, () => {
        deliverMs = Math.round(performance.now() - readyAt);
        if (releasedAt) releaseToPlayMs = Math.max(0, Date.now() - releasedAt);
      });
      setPlayingId(null);
      chirpsRef.current?.roger();
      channelRef.current?.sendPlayed(id);
      const extra: Record<string, number> = {};
      if (deliverMs >= 0) extra.deliver_ms = deliverMs;
      if (releaseToPlayMs >= 0) extra.release_to_play_ms = releaseToPlayMs;
      void postAck(id, "played", extra);
    },
    [appendMessage, playSpeech, postAck]
  );

  const replay = useCallback(
    async (m: WalkieMessage) => {
      if (!m.speech_url || playingId) return;
      setPlayingId(m.id);
      await playSpeech(m.speech_url, () => undefined);
      setPlayingId(null);
    },
    [playSpeech, playingId]
  );

  // ── On air / off air ────────────────────────────────────────────────────
  const leaveChannel = useCallback(async () => {
    const ch = channelRef.current;
    channelRef.current = null;
    await ch?.leave();
    setPartner(null);
    setPhase("lobby");
  }, []);

  const goOnAir = useCallback(async () => {
    const code = normalizeWalkieRoom(room);
    if (!code) return;
    setError(null);
    setNotice(null);
    setPhase("joining");
    // Inside the tap, before any await: the whole reason this button exists.
    if (!chirpsRef.current) chirpsRef.current = createWalkieChirps();
    void chirpsRef.current.unlock();
    blessAudio();
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
        setMessages(Array.isArray(payload.messages) ? payload.messages : []);
      } catch (e) {
        setError(isConnectionError(e) ? s.connectionLost : e instanceof Error ? e.message : s.walkieFailed);
      }
      const channel = await joinWalkieChannel(
        { room: code, lang: mineRef.current, name: meRef.current?.name ?? "—" },
        {
          onPartner: (state) => setPartner(state),
          onReady: ({ id, releasedAt }) => void receiveTurn(id, releasedAt),
          onGot: (id) => setReceipts((r) => (r[id] === "played" ? r : { ...r, [id]: "delivered" })),
          onPlayed: (id) => setReceipts((r) => ({ ...r, [id]: "played" })),
          onError: (message) => {
            setError(message);
            void leaveChannel();
          }
        }
      );
      channelRef.current = channel;
      setPhase("on-air");
      window.history.replaceState(null, "", `/taokie?room=${code}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : s.walkieFailed);
      setPhase("lobby");
    }
  }, [blessAudio, leaveChannel, receiveTurn, room, s.connectionLost, s.walkieFailed]);

  useEffect(() => {
    return () => {
      void channelRef.current?.leave();
      chirpsRef.current?.close();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      wakeStopRef.current?.();
    };
  }, []);

  // ── The hold ────────────────────────────────────────────────────────────
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
      stopRecording(0);
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

  async function startRecording() {
    setError(null);
    wakeStopRef.current?.();
    wakeStopRef.current = keepWake("walkie-mic");
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError(s.micUnavailable);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
      recorder.onerror = () => stopRecording(1);
      for (const track of stream.getAudioTracks()) {
        track.onended = () => stopRecording(1);
      }
      recorder.start(1000);
      recorderRef.current = recorder;
      setHolding(true);
      channelRef.current?.setHolding(true);
      clearRecordingTimers();
      recordStartRef.current = performance.now();
      cancelledRef.current = 0;
      pulsePhaseRef.current = 0;
      lastTickRef.current = 0;
      setWrappingUp(false);
      maxStopTimerRef.current = window.setTimeout(() => stopRecording(0), maxTurnMs);
      rafRef.current = requestAnimationFrame(tickRamp);
    } catch {
      wakeStopRef.current?.();
      wakeStopRef.current = null;
      setError(s.walkieMicDenied);
    }
  }

  function stopRecording(cancelled: 0 | 1) {
    clearRecordingTimers();
    setWrappingUp(false);
    if (cancelled) cancelledRef.current = 1;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      releasedAtRef.current = Date.now();
      recorder.stop();
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    wakeStopRef.current?.();
    wakeStopRef.current = null;
    setHolding(false);
    channelRef.current?.setHolding(false);
  }

  async function handleRecordingStopped() {
    const mime = mimeRef.current || "audio/webm";
    const blob = new Blob(chunksRef.current, { type: mime });
    recorderRef.current = null;
    chunksRef.current = [];
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
    const code = normalizeWalkieRoom(room);
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
      const res = await fetchWithRetry(
        "/api/walkie/turn",
        {
          method: "POST",
          headers: { ...(await authHeaders()), ...personalVoiceHeaders(), ...ttsDeviceHeaders("walkie") },
          body: form
        },
        { retries: 1, timeoutMs: TURN_FETCH_TIMEOUT_MS }
      );
      const payload = (await res.json().catch(() => ({}))) as {
        message?: WalkieMessage;
        error?: string;
        details?: string;
      };
      if (!res.ok || !payload.message) throw new Error(payload.details || payload.error || s.walkieFailed);
      busyBlockedRef.current = 0;
      appendMessage(payload.message);
      setReceipts((r) => ({ ...r, [payload.message!.id]: "sent" }));
      channelRef.current?.sendReady(payload.message.id, releasedAtRef.current || null);
    } catch (e) {
      setError(isConnectionError(e) ? s.connectionLost : e instanceof Error ? e.message : s.walkieFailed);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  const conditions = {
    onAir: phase === "on-air",
    joined: Boolean(channelRef.current),
    partnerHolding: Boolean(partner?.holding),
    sending
  };
  const holdAllowed = canHold(conditions);

  function onHoldDown(ev: ReactPointerEvent<HTMLButtonElement>) {
    if (ev.button !== undefined && ev.button !== 0) return;
    ev.preventDefault();
    if (holding) return;
    const refusal = holdRefusal({
      onAir: phaseRef.current === "on-air",
      joined: Boolean(channelRef.current),
      partnerHolding: Boolean(partnerRef.current?.holding),
      sending: sendingRef.current
    });
    if (refusal) {
      if (refusal === "partner-holding") busyBlockedRef.current += 1;
      chirpsRef.current?.busy();
      return;
    }
    try {
      ev.currentTarget.setPointerCapture(ev.pointerId);
    } catch {
      /* not every pointer can be captured; the up still lands on the button */
    }
    chirpsRef.current?.keyDown();
    void startRecording();
  }

  function onHoldUp(ev: ReactPointerEvent<HTMLButtonElement>) {
    ev.preventDefault();
    if (!holding && !recorderRef.current) return;
    stopRecording(0);
  }

  function onHoldCancel(ev: ReactPointerEvent<HTMLButtonElement>) {
    ev.preventDefault();
    if (!holding && !recorderRef.current) return;
    // pointercancel = the OS took the gesture (a scroll, the long-press cue,
    // an incoming call). Send what was recorded; never drop it.
    stopRecording(1);
  }

  async function shareChannel() {
    const code = normalizeWalkieRoom(room);
    if (!code) return;
    const url = `${window.location.origin}/taokie?room=${code}`;
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

  const partnerName = partner?.name || "—";
  const hearLang = languageNative(mine);
  const theyHearLang = languageNative(partner?.lang && partner.lang !== mine ? partner.lang : theirs);
  const onAir = phase === "on-air";

  return (
    <main className="min-h-screen px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-[calc(env(safe-area-inset-top)+1rem)]">
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

        {/* ── Presence line ───────────────────────────────────────────── */}
        {onAir ? (
          <div
            data-walkie-presence=""
            className={`rounded-xl border px-3 py-2 text-sm ${
              partner?.holding
                ? "border-amber-300/50 bg-amber-400/15 text-amber-100"
                : partner
                  ? "border-emerald-300/30 bg-emerald-400/10 text-emerald-100"
                  : "border-white/10 bg-white/[0.03] text-amber-100/60"
            }`}
          >
            {partner?.holding
              ? fill(s.walkiePartnerTalking, { name: partnerName })
              : partner
                ? fill(s.walkiePartnerHere, { name: partnerName })
                : s.walkieWaiting}
          </div>
        ) : null}

        {error ? (
          <div role="alert" className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-100">
            {error}
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
                const own = me ? m.sender_id === me.id : false;
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
                      <span>
                        {own
                          ? receipt === "played"
                            ? `✓✓ ${s.walkiePlayed}`
                            : receipt === "delivered"
                              ? `✓ ${s.walkieDelivered}`
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
              aria-pressed={holding}
              aria-disabled={!holdAllowed}
              onPointerDown={onHoldDown}
              onPointerUp={onHoldUp}
              onPointerCancel={onHoldCancel}
              onLostPointerCapture={(ev) => {
                // Capture lost without an up (iOS taking the gesture): same
                // as a cancel — send what we have.
                if (holding || recorderRef.current) onHoldCancel(ev);
              }}
              onContextMenu={(ev) => ev.preventDefault()}
              style={{ WebkitTouchCallout: "none", userSelect: "none", WebkitUserSelect: "none", touchAction: "none" }}
              className={`flex h-40 w-40 select-none touch-none items-center justify-center rounded-full border-4 text-center text-base font-bold uppercase tracking-wide transition ${
                holding
                  ? "border-amber-300 bg-amber-400 text-stone-950"
                  : !holdAllowed
                    ? "border-white/10 bg-white/[0.04] text-amber-100/40"
                    : "border-emerald-300 bg-emerald-400 text-stone-950 active:scale-[0.98]"
              }`}
            >
              {holding
                ? s.walkieHolding
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
