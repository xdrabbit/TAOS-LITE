"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ── /tabletop: the phone lies flat between two people ───────────────────────
// Party mode. One phone on the table: the TOP half renders rotated 180° so it
// reads right-side-up for the person across the table; the BOTTOM half faces
// the phone's owner. One end is English, the other Spanish (swappable).
// Turn-taking is explicit, chess-style: TAP to start talking, TAP again when
// done — then the recording is transcribed + translated (/api/translate) and
// the other end sees (and hears) it in their language. No hold-to-talk, no
// VAD guessing: in a loud party room, the button IS the turn.

type Lang = "en" | "es";
type TurnState =
  | { kind: "idle" }
  | { kind: "recording"; side: Lang }
  | { kind: "processing"; side: Lang };

interface Exchange {
  /** Language the speaker used. */
  from: Lang;
  original: string;
  translation: string;
  at: number;
}

const MAX_TURN_SEC = 60;

const L: Record<
  Lang,
  {
    label: string;
    tapToTalk: string;
    tapDone: string;
    listening: string;
    translating: string;
    theySaid: string;
    youSaid: string;
    idleHint: string;
  }
> = {
  en: {
    label: "English",
    tapToTalk: "TAP TO TALK",
    tapDone: "TAP WHEN DONE",
    listening: "Listening to the other side…",
    translating: "Translating…",
    theySaid: "They said",
    youSaid: "You said",
    idleHint: "Lay the phone flat between you"
  },
  es: {
    label: "Español",
    tapToTalk: "TOCA PARA HABLAR",
    tapDone: "TOCA AL TERMINAR",
    listening: "Escuchando al otro lado…",
    translating: "Traduciendo…",
    theySaid: "Dijo",
    youSaid: "Dijiste",
    idleHint: "Pon el teléfono entre ustedes"
  }
};

function pickRecordingMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

interface ScreenWakeSentinel {
  release(): Promise<void>;
}
function getWakeLock(): { request(type: "screen"): Promise<ScreenWakeSentinel> } | null {
  if (typeof navigator === "undefined") return null;
  const nav = navigator as Navigator & {
    wakeLock?: { request(type: "screen"): Promise<ScreenWakeSentinel> };
  };
  return nav.wakeLock ?? null;
}

export function TabletopShell(): JSX.Element {
  // Which language faces the TOP (rotated) end; the bottom end is the other.
  const [topLang, setTopLang] = useState<Lang>("es");
  const [turn, setTurn] = useState<TurnState>({ kind: "idle" });
  const [voiceOn, setVoiceOn] = useState(true);
  const [recordSec, setRecordSec] = useState(0);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);
  const playerRef = useRef<HTMLAudioElement | null>(null);
  const wakeLockRef = useRef<ScreenWakeSentinel | null>(null);
  const voiceOnRef = useRef(true);

  useEffect(() => {
    voiceOnRef.current = voiceOn;
    if (!voiceOn) {
      playerRef.current?.pause();
      playerRef.current = null;
    }
  }, [voiceOn]);

  // Wake lock while the page is open — a tabletop session dies if the screen
  // sleeps. Re-acquired when the tab becomes visible again (same as /live).
  useEffect(() => {
    const acquire = () => {
      getWakeLock()
        ?.request("screen")
        .then((s) => {
          wakeLockRef.current = s;
        })
        .catch(() => {});
    };
    acquire();
    const onVisible = () => {
      if (document.visibilityState === "visible") acquire();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      void wakeLockRef.current?.release().catch(() => {});
      wakeLockRef.current = null;
    };
  }, []);

  const cleanupRecording = useCallback(() => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
    setRecordSec(0);
  }, []);

  useEffect(() => cleanupRecording, [cleanupRecording]);

  const speak = useCallback(async (ex: Exchange) => {
    if (!voiceOnRef.current) return;
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: ex.translation,
          sourceLanguage: ex.from,
          targetLanguage: ex.from === "en" ? "es" : "en"
        })
      });
      if (!res.ok) return;
      const url = URL.createObjectURL(await res.blob());
      playerRef.current?.pause();
      const el = new Audio(url);
      playerRef.current = el;
      el.onended = () => {
        URL.revokeObjectURL(url);
        if (playerRef.current === el) playerRef.current = null;
      };
      await el.play();
    } catch {
      /* voice is best-effort; the text is already on screen */
    }
  }, []);

  const finishTurn = useCallback(
    async (side: Lang, blob: Blob) => {
      setTurn({ kind: "processing", side });
      try {
        const form = new FormData();
        form.append("audio", new File([blob], "turn", { type: blob.type || "audio/webm" }));
        form.append("sourceLanguage", side);
        form.append("targetLanguage", side === "en" ? "es" : "en");
        form.append("tone", "casual");
        const res = await fetch("/api/translate", { method: "POST", body: form });
        const payload = (await res.json().catch(() => ({}))) as {
          original?: string;
          translation?: string;
          error?: string;
        };
        if (!res.ok || !payload.translation) {
          throw new Error(payload.error || "Translation failed. Try again.");
        }
        const ex: Exchange = {
          from: side,
          original: payload.original ?? "",
          translation: payload.translation,
          at: Date.now()
        };
        setExchanges((prev) => [...prev.slice(-19), ex]);
        setError(null);
        void speak(ex);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Translation failed. Try again.");
      } finally {
        setTurn({ kind: "idle" });
      }
    },
    [speak]
  );

  const startTurn = useCallback(
    async (side: Lang) => {
      if (turn.kind !== "idle") return;
      setError(null);
      playerRef.current?.pause();
      playerRef.current = null;
      try {
        if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
          throw new Error("Recording is not supported in this browser.");
        }
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mime = pickRecordingMime();
        const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        streamRef.current = stream;
        recorderRef.current = recorder;
        chunksRef.current = [];
        cancelledRef.current = false;

        recorder.ondataavailable = (ev) => {
          if (ev.data.size > 0) chunksRef.current.push(ev.data);
        };
        recorder.onstop = () => {
          const chunks = chunksRef.current;
          const type = recorder.mimeType || mime || "audio/webm";
          const cancelled = cancelledRef.current;
          cleanupRecording();
          if (cancelled || !chunks.length) {
            setTurn({ kind: "idle" });
            return;
          }
          void finishTurn(side, new Blob(chunks, { type }));
        };

        recorder.start(250);
        setTurn({ kind: "recording", side });
        setRecordSec(0);
        timerRef.current = window.setInterval(() => {
          setRecordSec((s) => {
            if (s + 1 >= MAX_TURN_SEC) recorderRef.current?.stop();
            return s + 1;
          });
        }, 1000);
      } catch (e) {
        cleanupRecording();
        setTurn({ kind: "idle" });
        setError(
          e instanceof Error && e.name === "NotAllowedError"
            ? "Microphone access was denied."
            : e instanceof Error
              ? e.message
              : "Could not start recording."
        );
      }
    },
    [turn.kind, cleanupRecording, finishTurn]
  );

  const stopTurn = useCallback(() => {
    cancelledRef.current = false;
    recorderRef.current?.stop();
  }, []);

  const tap = useCallback(
    (side: Lang) => {
      if (turn.kind === "idle") void startTurn(side);
      else if (turn.kind === "recording" && turn.side === side) stopTurn();
    },
    [turn, startTurn, stopTurn]
  );

  // Latest lines relevant to a pane, in ITS language.
  const paneLines = useCallback(
    (lang: Lang): { theirs: Exchange | null; mine: Exchange | null } => {
      const theirs = [...exchanges].reverse().find((e) => e.from !== lang) ?? null;
      const mine = [...exchanges].reverse().find((e) => e.from === lang) ?? null;
      return { theirs, mine };
    },
    [exchanges]
  );

  const renderPane = (lang: Lang, rotated: boolean): JSX.Element => {
    const t = L[lang];
    const { theirs, mine } = paneLines(lang);
    const isRecording = turn.kind === "recording" && turn.side === lang;
    const isProcessing = turn.kind === "processing" && turn.side === lang;
    const otherBusy =
      (turn.kind === "recording" || turn.kind === "processing") && turn.side !== lang;

    return (
      <section
        className={`flex flex-1 flex-col gap-2 overflow-hidden p-4 ${rotated ? "rotate-180" : ""}`}
      >
        <div className="flex items-center justify-between">
          <span className="text-xs uppercase tracking-[0.25em] text-amber-100/50">{t.label}</span>
          {isRecording ? (
            <span className="flex items-center gap-2 text-xs text-red-300">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-400" />
              {recordSec}s / {MAX_TURN_SEC}s
            </span>
          ) : null}
        </div>

        {/* What the other person said, in MY language — the main read. */}
        <div className="flex-1 overflow-y-auto">
          {theirs ? (
            <>
              <div className="text-[11px] uppercase tracking-widest text-amber-100/40">
                {t.theySaid}
              </div>
              <div className="mt-1 text-2xl font-medium leading-snug text-amber-50">
                {theirs.translation}
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center text-center text-sm text-amber-100/30">
              {t.idleHint}
            </div>
          )}
          {mine ? (
            <div className="mt-3 border-t border-white/10 pt-2">
              <div className="text-[11px] uppercase tracking-widest text-amber-100/30">
                {t.youSaid}
              </div>
              <div className="text-sm text-amber-100/60">{mine.original}</div>
            </div>
          ) : null}
        </div>

        <button
          type="button"
          onClick={() => tap(lang)}
          disabled={otherBusy || isProcessing}
          className={`rounded-2xl px-4 py-5 text-lg font-bold tracking-wide transition ${
            isRecording
              ? "animate-pulse bg-red-500 text-stone-50"
              : isProcessing
                ? "bg-white/10 text-amber-100/60"
                : otherBusy
                  ? "bg-white/5 text-amber-100/30"
                  : "bg-emerald-400 text-stone-950"
          }`}
        >
          {isRecording
            ? t.tapDone
            : isProcessing
              ? t.translating
              : otherBusy
                ? t.listening
                : t.tapToTalk}
        </button>
      </section>
    );
  };

  const bottomLang: Lang = topLang === "en" ? "es" : "en";

  return (
    <main className="flex h-[100dvh] flex-col overflow-hidden">
      {renderPane(topLang, true)}

      {/* Middle bar — readable from the bottom end (the phone owner). */}
      <div className="flex items-center justify-center gap-2 border-y border-white/10 bg-white/5 px-3 py-1.5">
        <a href="/" className="rounded-full px-2 py-1 text-xs text-amber-100/50">
          ← TAOS
        </a>
        <button
          type="button"
          onClick={() => setTopLang((l) => (l === "en" ? "es" : "en"))}
          disabled={turn.kind !== "idle"}
          className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-amber-100/70 disabled:opacity-40"
        >
          ⇅ swap ends
        </button>
        <button
          type="button"
          onClick={() => setVoiceOn((v) => !v)}
          className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-amber-100/70"
        >
          {voiceOn ? "🔊 voice on" : "🔇 voice off"}
        </button>
        {error ? <span className="max-w-[40%] truncate text-xs text-red-300">{error}</span> : null}
      </div>

      {renderPane(bottomLang, false)}
    </main>
  );
}
