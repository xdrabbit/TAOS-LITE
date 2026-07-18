"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { SignIn } from "./SignIn";
import {
  getChatThread,
  getVoiceUrl,
  listMessages,
  markThreadRead,
  sendMessage,
  sendVoiceMessage,
  subscribeMessages,
  type ChatMessageRow,
  type ChatThreadInfo
} from "@/lib/chat";

// ── /chat: private translated messages ──────────────────────────────────────
// Tier 1+ of the private message app: one thread between Tom and Liz. Text
// messages are stored as typed AND auto-translated into the partner's
// language. Voice messages (🎤) upload the audio, transcribe it, translate the
// transcript, and can be replayed either as the real recording or as the
// translation spoken by the sender's cloned voice (existing /api/tts,
// voice-follows-speaker). Delivery is instant while the app is open; push
// notifications are tier 2.

interface PendingMessage {
  tempId: string;
  kind: "text" | "voice";
  body: string;
  blob?: Blob;
  mime?: string;
  failed: boolean;
}

const MAX_RECORD_SEC = 120;

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function formatDay(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Chrome/Android record webm/opus; iOS Safari records mp4/aac.
function pickRecordingMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

export function ChatShell(): JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [thread, setThread] = useState<ChatThreadInfo | null>(null);
  const [threadMissing, setThreadMissing] = useState(false);
  const [messages, setMessages] = useState<ChatMessageRow[]>([]);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [recording, setRecording] = useState(false);
  const [recordSec, setRecordSec] = useState(0);
  const [playingKey, setPlayingKey] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement | null>(null);
  const nextTempIdRef = useRef(1);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recChunksRef = useRef<Blob[]>([]);
  const recStreamRef = useRef<MediaStream | null>(null);
  const recTimerRef = useRef<number | null>(null);
  const recCancelledRef = useRef(false);
  const playerRef = useRef<HTMLAudioElement | null>(null);
  // Object-URL / signed-URL caches so replays don't refetch.
  const voiceUrlCacheRef = useRef<Map<string, string>>(new Map());
  const ttsUrlCacheRef = useRef<Map<string, string>>(new Map());

  // Auth gating — same listener pattern as AppShell.
  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setReady(true);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  // Load the thread + history, subscribe to live inserts.
  useEffect(() => {
    if (!session) {
      setThread(null);
      setMessages([]);
      return;
    }
    let active = true;
    let unsubscribe: (() => void) | null = null;

    void (async () => {
      const t = await getChatThread();
      if (!active) return;
      if (!t) {
        setThreadMissing(true);
        return;
      }
      setThread(t);
      setThreadMissing(false);
      try {
        const rows = await listMessages(t.threadId);
        if (!active) return;
        setMessages(rows);
      } catch {
        if (active) setError("Could not load messages.");
      }
      void markThreadRead(t.threadId);

      unsubscribe = subscribeMessages(t.threadId, (row) => {
        setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]));
        if (row.sender_id !== t.myUserId) void markThreadRead(t.threadId);
      });
    })();

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [session]);

  // Keep the newest message in view.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  // ── Audio playback (voice notes + cloned-voice TTS) ───────────────────────

  const stopPlayback = useCallback(() => {
    playerRef.current?.pause();
    playerRef.current = null;
    setPlayingKey(null);
  }, []);

  const playUrl = useCallback(
    async (key: string, getUrl: () => Promise<string>) => {
      if (playingKey === key) {
        stopPlayback();
        return;
      }
      stopPlayback();
      setPlayingKey(key);
      try {
        const url = await getUrl();
        const el = new Audio(url);
        playerRef.current = el;
        el.onended = () => {
          playerRef.current = null;
          setPlayingKey(null);
        };
        await el.play();
      } catch {
        setPlayingKey(null);
        setError("Could not play the audio.");
      }
    },
    [playingKey, stopPlayback]
  );

  const playVoiceNote = useCallback(
    (m: ChatMessageRow) =>
      playUrl(m.id, async () => {
        const cached = voiceUrlCacheRef.current.get(m.id);
        if (cached) return cached;
        if (!m.audio_path) throw new Error("no audio");
        const url = await getVoiceUrl(m.audio_path);
        voiceUrlCacheRef.current.set(m.id, url);
        return url;
      }),
    [playUrl]
  );

  // The translation, spoken by the SENDER's cloned voice (/api/tts picks the
  // clone from the source→target direction).
  const playClonedVoice = useCallback(
    (m: ChatMessageRow) =>
      playUrl(`${m.id}:clone`, async () => {
        const cached = ttsUrlCacheRef.current.get(m.id);
        if (cached) return cached;
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: m.body_translated,
            sourceLanguage: m.source_lang,
            targetLanguage: m.target_lang
          })
        });
        if (!res.ok) throw new Error("tts failed");
        const url = URL.createObjectURL(await res.blob());
        ttsUrlCacheRef.current.set(m.id, url);
        return url;
      }),
    [playUrl]
  );

  // ── Sending ───────────────────────────────────────────────────────────────

  const deliver = useCallback(
    async (tempId: string, doSend: () => Promise<ChatMessageRow>) => {
      try {
        const row = await doSend();
        setPending((p) => p.filter((m) => m.tempId !== tempId));
        setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]));
      } catch (e) {
        setPending((p) => p.map((m) => (m.tempId === tempId ? { ...m, failed: true } : m)));
        setError(e instanceof Error ? e.message : "Could not send.");
      }
    },
    []
  );

  const send = useCallback(async () => {
    const body = draft.trim();
    if (!body || !thread) return;
    setDraft("");
    setError(null);
    const tempId = `tmp-${nextTempIdRef.current++}`;
    setPending((p) => [...p, { tempId, kind: "text", body, failed: false }]);
    await deliver(tempId, () => sendMessage(thread.threadId, body));
  }, [draft, thread, deliver]);

  const retryPending = useCallback(
    async (tempId: string) => {
      const msg = pending.find((m) => m.tempId === tempId);
      if (!msg || !thread) return;
      setPending((p) => p.map((m) => (m.tempId === tempId ? { ...m, failed: false } : m)));
      setError(null);
      await deliver(tempId, () =>
        msg.kind === "voice" && msg.blob
          ? sendVoiceMessage(thread.threadId, msg.blob, msg.mime || "audio/webm")
          : sendMessage(thread.threadId, msg.body)
      );
    },
    [pending, thread, deliver]
  );

  // ── Recording ─────────────────────────────────────────────────────────────

  const cleanupRecording = useCallback(() => {
    if (recTimerRef.current !== null) window.clearInterval(recTimerRef.current);
    recTimerRef.current = null;
    recStreamRef.current?.getTracks().forEach((t) => t.stop());
    recStreamRef.current = null;
    recorderRef.current = null;
    recChunksRef.current = [];
    setRecording(false);
    setRecordSec(0);
  }, []);

  const startRecording = useCallback(async () => {
    if (!thread || recording) return;
    setError(null);
    stopPlayback();
    try {
      if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        throw new Error("Voice recording is not supported in this browser.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickRecordingMime();
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recStreamRef.current = stream;
      recorderRef.current = recorder;
      recChunksRef.current = [];
      recCancelledRef.current = false;

      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) recChunksRef.current.push(ev.data);
      };
      recorder.onstop = () => {
        const chunks = recChunksRef.current;
        const type = recorder.mimeType || mime || "audio/webm";
        const cancelled = recCancelledRef.current;
        cleanupRecording();
        if (cancelled || !chunks.length || !thread) return;
        const blob = new Blob(chunks, { type });
        const tempId = `tmp-${nextTempIdRef.current++}`;
        setPending((p) => [
          ...p,
          { tempId, kind: "voice", body: "🎤 Voice message", blob, mime: type, failed: false }
        ]);
        void deliver(tempId, () => sendVoiceMessage(thread.threadId, blob, type));
      };

      recorder.start(250);
      setRecording(true);
      setRecordSec(0);
      recTimerRef.current = window.setInterval(() => {
        setRecordSec((s) => {
          if (s + 1 >= MAX_RECORD_SEC) recorderRef.current?.stop();
          return s + 1;
        });
      }, 1000);
    } catch (e) {
      cleanupRecording();
      setError(
        e instanceof Error && e.name === "NotAllowedError"
          ? "Microphone access was denied."
          : e instanceof Error
            ? e.message
            : "Could not start recording."
      );
    }
  }, [thread, recording, stopPlayback, cleanupRecording, deliver]);

  const stopAndSendRecording = useCallback(() => {
    recCancelledRef.current = false;
    recorderRef.current?.stop();
  }, []);

  const cancelRecording = useCallback(() => {
    recCancelledRef.current = true;
    recorderRef.current?.stop();
  }, []);

  useEffect(() => cleanupRecording, [cleanupRecording]);

  if (!ready) {
    return (
      <main className="flex min-h-screen items-center justify-center text-amber-100/60">
        Loading…
      </main>
    );
  }
  if (!session) {
    return <SignIn />;
  }

  return (
    <main className="min-h-screen px-4 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] pt-[calc(env(safe-area-inset-top)+1rem)]">
      <div className="mx-auto flex h-[calc(100dvh-1.5rem)] max-w-md flex-col gap-3">
        <header className="flex items-center justify-between gap-2">
          <h1 className="text-lg font-semibold tracking-tight text-amber-200">TAOS·LITE</h1>
          <a
            href="/"
            className="rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-sm text-amber-100/80"
          >
            ← Home
          </a>
        </header>

        <div className="text-xs uppercase tracking-[0.2em] text-amber-100/50">
          Private chat · Chat privado
        </div>

        {threadMissing ? (
          <div className="rounded-2xl border border-amber-300/20 bg-amber-400/10 p-4 text-sm text-amber-100/80">
            This account isn&apos;t part of a chat yet. Sign in with your own Google account (not
            the shared passcode account).
          </div>
        ) : null}

        {/* Messages */}
        <div
          ref={listRef}
          className="flex-1 space-y-2 overflow-y-auto rounded-2xl border border-white/10 bg-white/5 p-3"
        >
          {messages.length === 0 && pending.length === 0 ? (
            <div className="pt-8 text-center text-sm text-amber-100/40">
              No messages yet — say hi · Aún no hay mensajes — saluda
            </div>
          ) : null}
          {messages.map((m, i) => {
            const mine = m.sender_id === thread?.myUserId;
            const primary = mine ? m.body : m.body_translated ?? m.body;
            const secondary = mine ? m.body_translated : m.body_translated ? m.body : null;
            const newDay = i === 0 || dayKey(messages[i - 1].created_at) !== dayKey(m.created_at);
            const canClone = Boolean(m.body_translated && m.source_lang && m.target_lang);
            return (
              <div key={m.id}>
                {newDay ? (
                  <div className="py-1 text-center text-[11px] uppercase tracking-widest text-amber-100/30">
                    {formatDay(m.created_at)}
                  </div>
                ) : null}
                <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[85%] rounded-2xl px-3 py-2 ${
                      mine
                        ? "rounded-br-md bg-amber-400/90 text-stone-950"
                        : "rounded-bl-md border border-white/10 bg-stone-950/60 text-amber-50"
                    }`}
                  >
                    {m.kind === "voice" && m.audio_path ? (
                      <button
                        type="button"
                        onClick={() => void playVoiceNote(m)}
                        className={`mb-1 flex items-center gap-2 rounded-xl px-2 py-1 text-sm font-medium ${
                          mine ? "bg-stone-950/15" : "bg-white/10"
                        }`}
                      >
                        {playingKey === m.id ? "⏸" : "▶"} 🎤 {mine ? "Voice note" : "Nota de voz"}
                      </button>
                    ) : null}
                    <div className="whitespace-pre-wrap break-words text-[15px] leading-snug">
                      {primary}
                    </div>
                    {secondary ? (
                      <div
                        className={`mt-1 whitespace-pre-wrap break-words border-t pt-1 text-xs ${
                          mine
                            ? "border-stone-950/20 text-stone-950/60"
                            : "border-white/10 text-amber-100/50"
                        }`}
                      >
                        {secondary}
                      </div>
                    ) : null}
                    <div
                      className={`mt-1 flex items-center justify-end gap-2 text-[10px] ${
                        mine ? "text-stone-950/50" : "text-amber-100/30"
                      }`}
                    >
                      {canClone ? (
                        <button
                          type="button"
                          onClick={() => void playClonedVoice(m)}
                          title="Hear the translation in the sender's voice"
                          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                            mine ? "bg-stone-950/15" : "bg-white/10"
                          }`}
                        >
                          {playingKey === `${m.id}:clone` ? "⏸" : "🗣️"} clone
                        </button>
                      ) : null}
                      <span>
                        {formatTime(m.created_at)}
                        {mine && m.read_at ? " ✓✓" : ""}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          {pending.map((p) => (
            <div key={p.tempId} className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-md bg-amber-400/50 px-3 py-2 text-stone-950">
                <div className="whitespace-pre-wrap break-words text-[15px] leading-snug">
                  {p.body}
                </div>
                <div className="mt-1 text-right text-[10px] text-stone-950/60">
                  {p.failed ? (
                    <button
                      type="button"
                      onClick={() => void retryPending(p.tempId)}
                      className="font-semibold underline"
                    >
                      failed — tap to retry
                    </button>
                  ) : p.kind === "voice" ? (
                    "transcribing & sending…"
                  ) : (
                    "sending…"
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        {error ? (
          <div className="rounded-2xl border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-200">
            {error}
          </div>
        ) : null}

        {/* Composer */}
        {recording ? (
          <div className="flex items-center gap-2">
            <div className="flex flex-1 items-center gap-3 rounded-2xl border border-red-400/40 bg-red-400/10 px-4 py-2.5">
              <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-red-400" />
              <span className="text-sm text-red-200">
                Recording {formatElapsed(recordSec)} / {formatElapsed(MAX_RECORD_SEC)}
              </span>
            </div>
            <button
              type="button"
              onClick={cancelRecording}
              className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-amber-100/70"
            >
              ✕
            </button>
            <button
              type="button"
              onClick={stopAndSendRecording}
              className="rounded-2xl bg-emerald-400 px-4 py-2.5 text-sm font-semibold text-stone-950"
            >
              Send 🎤
            </button>
          </div>
        ) : (
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={thread?.myLang === "es" ? "Escribe un mensaje…" : "Type a message…"}
              rows={1}
              className="max-h-32 min-h-[2.75rem] flex-1 resize-none rounded-2xl border border-white/10 bg-stone-950/60 px-4 py-2.5 text-[15px] text-amber-50 placeholder:text-amber-100/30"
            />
            {draft.trim() ? (
              <button
                type="button"
                onClick={() => void send()}
                disabled={!thread}
                className="rounded-2xl bg-emerald-400 px-4 py-2.5 text-sm font-semibold text-stone-950 transition disabled:opacity-40"
              >
                Send
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void startRecording()}
                disabled={!thread}
                aria-label="Record a voice message"
                className="rounded-2xl bg-emerald-400 px-4 py-2.5 text-lg leading-none text-stone-950 transition disabled:opacity-40"
              >
                🎤
              </button>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
