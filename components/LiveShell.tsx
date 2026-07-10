"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  startAmbientLive,
  type ActiveAmbientSession,
  type AmbientState,
  type AmbientTarget
} from "@/lib/live/ambient";

// ── /live: real-time follow-along ───────────────────────────────────────────
// Use case: Tom & Liz at a dinner, on a call, or watching TV in a language one
// of them doesn't follow. The phone listens and keeps them current with
// ultra-short summaries in the target language — written on screen and spoken
// into an earpiece. Freshness beats completeness: anything stale gets dropped,
// never queued.
//
// Two engines:
//  • "Ambient AI" (default) — continuous WebRTC stream to a GA Realtime
//    session (lib/live/ambient.ts). Hears any language and multiple voices,
//    speaks its summaries natively (no TTS round-trip). This is the mode for
//    dinners, TV, and movies.
//  • "On-device" — the original free path: Web Speech API transcription →
//    POST /api/live-translate per chunk → optional /api/tts readout. One
//    recognition language at a time; best for a single nearby speaker.

type Engine = "ambient" | "device";

// Endpoint direction values for the on-device engine (see
// app/api/live-translate/route.ts).
type Direction = "es-en" | "en-es";

interface DirectionMeta {
  label: string;
  recognitionLang: string;
}

const DIRECTIONS: Record<Direction, DirectionMeta> = {
  "es-en": { label: "Liz (ES → EN)", recognitionLang: "es-ES" },
  "en-es": { label: "Me (EN → ES)", recognitionLang: "en-US" }
};

const TARGETS: Record<AmbientTarget, string> = {
  en: "→ English",
  es: "→ Español"
};

// Rolling context sent to /api/live-translate so its guesses improve.
const MAX_CONTEXT = 10;

// Freshness rules (device engine). A lookup result older than this on arrival
// is four-week-old milk: throw it out.
const STALE_LOOKUP_MS = 30_000;
// A queued spoken concept older than this at play time gets skipped — the
// screen already showed it and the conversation has moved on.
const STALE_SPEECH_MS = 15_000;
// If the recognizer sits on interim text this long without finalizing, send
// the interim to the API anyway ("interim flush") so summaries keep flowing.
const INTERIM_FLUSH_MS = 3_000;
const INTERIM_FLUSH_MIN_WORDS = 3;

// Voice readout language mapping for /api/tts (device engine).
const TTS_LANGS: Record<Direction, { sourceLanguage: "es" | "en"; targetLanguage: "es" | "en" }> = {
  "es-en": { sourceLanguage: "es", targetLanguage: "en" },
  "en-es": { sourceLanguage: "en", targetLanguage: "es" }
};

// A backlog of spoken summaries is worse than a gap. Keep only the newest few.
const MAX_SPEECH_QUEUE = 2;
// Cap the on-screen feed so a two-hour dinner doesn't grow the DOM forever.
const MAX_FEED = 200;

interface ConceptEntry {
  id: number;
  concept: string;
  isGuess: boolean;
  at: number;
}

interface LiveError {
  message: string;
  fatal: boolean;
}

function getRecognitionCtor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

// Minimal Screen Wake Lock typing — self-contained so the build doesn't depend
// on the DOM lib version shipping these (iOS Safari 16.4+ supports the API).
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

function formatTime(at: number): string {
  try {
    return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Loose text normalization for interim-flush dedupe: we only need "same words,
// roughly" — recognition revises punctuation and casing constantly.
function normWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean);
}

export function LiveShell(): JSX.Element {
  const [engine, setEngine] = useState<Engine>("ambient");
  const [target, setTarget] = useState<AmbientTarget>("en");
  const [direction, setDirection] = useState<Direction>("es-en");
  const [supported, setSupported] = useState(true);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [feed, setFeed] = useState<ConceptEntry[]>([]);
  const [error, setError] = useState<LiveError | null>(null);
  // Voice defaults ON — the whole point is the earpiece. START is a user
  // gesture, so autoplay is unlocked in both engines.
  const [voiceOn, setVoiceOn] = useState(true);
  const [speakingConcept, setSpeakingConcept] = useState(false);
  // Ambient engine state.
  const [ambientState, setAmbientState] = useState<AmbientState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [draft, setDraft] = useState("");
  const [lastHeard, setLastHeard] = useState("");

  const engineRef = useRef<Engine>("ambient");
  const targetRef = useRef<AmbientTarget>("en");
  const ambientRef = useRef<ActiveAmbientSession | null>(null);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const listeningRef = useRef(false);
  // True while the recognizer is actually running (onstart..onend). The
  // watchdog compares this with listeningRef to catch silent deaths.
  const recRunningRef = useRef(false);
  const watchdogRef = useRef<number | null>(null);
  const directionRef = useRef<Direction>("es-en");
  const contextRef = useRef<string[]>([]);
  const idRef = useRef(0);
  // Monotonic utterance sequence + newest rendered seq: a slow lookup that
  // finishes after a newer one already rendered is old news — drop it.
  const utterSeqRef = useRef(0);
  const newestSeqRef = useRef(0);
  // Interim-flush bookkeeping.
  const interimRef = useRef("");
  const interimChangedAtRef = useRef(0);
  const flushedRef = useRef<string | null>(null);
  const flushTimerRef = useRef<number | null>(null);

  // Screen wake lock: while live mode runs the phone must not sleep — the user
  // is reading the feed, and on iOS a locked screen suspends the page and
  // kills the session entirely.
  const wakeLockRef = useRef<ScreenWakeSentinel | null>(null);

  // Voice readout plumbing (device engine).
  const voiceOnRef = useRef(true);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const speechQueueRef = useRef<{ text: string; direction: Direction; queuedAt: number }[]>([]);
  const playingRef = useRef(false);

  useEffect(() => {
    directionRef.current = direction;
  }, [direction]);
  useEffect(() => {
    targetRef.current = target;
  }, [target]);
  useEffect(() => {
    engineRef.current = engine;
  }, [engine]);

  useEffect(() => {
    if (!getRecognitionCtor()) setSupported(false);
  }, []);

  const pushFeed = useCallback((concept: string, isGuess: boolean) => {
    setFeed((prev) =>
      [{ id: (idRef.current += 1), concept, isGuess, at: Date.now() }, ...prev].slice(0, MAX_FEED)
    );
  }, []);

  // ── Voice readout (device engine) ─────────────────────────────────────────

  const ensureAudioEl = useCallback((): HTMLAudioElement | null => {
    if (!audioRef.current) {
      audioRef.current = typeof Audio !== "undefined" ? new Audio() : null;
    }
    return audioRef.current;
  }, []);

  // Calling play() inside a user gesture "blesses" the element so later
  // programmatic play() (after async TTS fetch) is allowed on iOS Safari.
  const blessAudio = useCallback(() => {
    const a = ensureAudioEl();
    if (!a) return;
    a.play().catch(() => {});
    a.pause();
  }, [ensureAudioEl]);

  const drainSpeechQueue = useCallback(() => {
    if (playingRef.current) return;
    // Skip anything that went stale while waiting its turn.
    let next = speechQueueRef.current.shift();
    while (next && Date.now() - next.queuedAt > STALE_SPEECH_MS) {
      next = speechQueueRef.current.shift();
    }
    if (!next) {
      setSpeakingConcept(false);
      return;
    }
    playingRef.current = true;
    setSpeakingConcept(true);

    fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: next.text, latency: "flash", ...TTS_LANGS[next.direction] })
    })
      .then(async (res) => {
        if (!res.ok) {
          const p = (await res.json().catch(() => ({}))) as { error?: string; details?: string };
          throw new Error(p.details || p.error || "Voice playback failed.");
        }
        return res.blob();
      })
      .then((blob) => {
        if (!voiceOnRef.current) return; // toggled off while the audio was in flight
        const a = ensureAudioEl();
        if (!a) return;
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
        const url = URL.createObjectURL(blob);
        objectUrlRef.current = url;
        a.src = url;
        return new Promise<void>((resolve) => {
          a.onended = () => resolve();
          a.onpause = () => resolve();
          a.onerror = () => resolve();
          a.play().catch(() => resolve());
        });
      })
      .catch((e) => {
        // Voice is a bonus layer — a failed readout never interrupts the feed.
        setError({
          message: e instanceof Error ? e.message : "Voice playback failed.",
          fatal: false
        });
      })
      .finally(() => {
        playingRef.current = false;
        drainSpeechQueue();
      });
  }, [ensureAudioEl]);

  const enqueueSpeech = useCallback(
    (text: string) => {
      if (!voiceOnRef.current) return;
      const q = speechQueueRef.current;
      q.push({ text, direction: directionRef.current, queuedAt: Date.now() });
      while (q.length > MAX_SPEECH_QUEUE) q.shift(); // drop stale, keep newest
      drainSpeechQueue();
    },
    [drainSpeechQueue]
  );

  const toggleVoice = useCallback(() => {
    const next = !voiceOnRef.current;
    voiceOnRef.current = next;
    setVoiceOn(next);
    // Ambient: voice on/off is just muting the live stream — text keeps going.
    ambientRef.current?.setMuted(!next);
    if (next) {
      blessAudio(); // we're inside the tap — unlock iOS playback now
    } else {
      speechQueueRef.current = [];
      playingRef.current = false;
      setSpeakingConcept(false);
      const a = audioRef.current;
      if (a) {
        try {
          a.pause();
        } catch {
          /* ignore */
        }
      }
    }
  }, [blessAudio]);

  // ── Concept lookup (device engine) ────────────────────────────────────────

  // Fire-and-render with freshness guards: results render as they return, but
  // anything slower than a newer utterance — or older than 30s — is discarded.
  const lookup = useCallback(
    (chunk: string) => {
      const text = chunk.trim();
      if (!text) return;
      const dir = directionRef.current;
      const context = contextRef.current.slice(-MAX_CONTEXT);
      const seq = (utterSeqRef.current += 1);
      const startedAt = Date.now();

      fetch("/api/live-translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, direction: dir, context })
      })
        .then(async (res) => {
          const payload = (await res.json().catch(() => ({}))) as {
            concept?: string;
            isGuess?: boolean;
            error?: string;
            details?: string;
          };
          if (!res.ok) {
            throw new Error(payload.details || payload.error || "Concept lookup failed.");
          }
          // Freshness: stale milk goes out, no matter how good it smells.
          if (Date.now() - startedAt > STALE_LOOKUP_MS) return;
          if (seq < newestSeqRef.current) return; // a newer summary already rendered

          const raw = typeof payload.concept === "string" ? payload.concept.trim() : "";
          const concept = raw.replace(/^~\s*/, "").trim();
          if (!concept) return;

          newestSeqRef.current = seq;
          contextRef.current = [...contextRef.current, concept].slice(-MAX_CONTEXT);
          pushFeed(concept, Boolean(payload.isGuess));
          enqueueSpeech(concept);
        })
        .catch((e) => {
          setError({
            message: e instanceof Error ? e.message : "Concept lookup failed.",
            fatal: false
          });
        });
    },
    [enqueueSpeech, pushFeed]
  );

  // A final arrived. If we already flushed this utterance's interim text, only
  // send what the flush didn't cover (dedupe is fuzzy — micro-summaries
  // tolerate an occasional overlap far better than a gap).
  const handleFinal = useCallback(
    (finalText: string) => {
      const flushed = flushedRef.current;
      flushedRef.current = null;
      if (!flushed) {
        lookup(finalText);
        return;
      }
      const fw = normWords(finalText);
      const xw = normWords(flushed);
      const overlap = fw.slice(0, xw.length).join(" ") === xw.join(" ");
      if (overlap) {
        const remainder = finalText.trim().split(/\s+/).slice(xw.length).join(" ");
        if (normWords(remainder).length >= 2) lookup(remainder);
        return; // covered by the flush (plus remainder if meaningful)
      }
      if (fw.length <= xw.length && xw.slice(0, fw.length).join(" ") === fw.join(" ")) {
        return; // final is a prefix of what we already flushed — skip
      }
      lookup(finalText);
    },
    [lookup]
  );

  // ── Recognition lifecycle (device engine) ─────────────────────────────────

  const clearDeviceTimers = useCallback(() => {
    if (watchdogRef.current !== null) window.clearInterval(watchdogRef.current);
    if (flushTimerRef.current !== null) window.clearInterval(flushTimerRef.current);
    watchdogRef.current = null;
    flushTimerRef.current = null;
  }, []);

  const stopListening = useCallback(() => {
    listeningRef.current = false;
    setListening(false);
    setInterim("");
    interimRef.current = "";
    flushedRef.current = null;
    clearDeviceTimers();
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    if (rec) {
      rec.onend = null;
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    }
  }, [clearDeviceTimers]);

  // Build and start one recognition instance. Extracted so the watchdog can
  // recreate a silently-dead recognizer without touching UI state.
  const spinUpRecognition = useCallback((): boolean => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setSupported(false);
      return false;
    }
    if (recognitionRef.current) {
      recognitionRef.current.onend = null;
      try {
        recognitionRef.current.stop();
      } catch {
        /* ignore */
      }
      recognitionRef.current = null;
    }

    const rec = new Ctor();
    rec.lang = DIRECTIONS[directionRef.current].recognitionLang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      recRunningRef.current = true;
    };

    rec.onresult = (event) => {
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) {
          handleFinal(transcript);
        } else {
          interimText += transcript;
        }
      }
      if (interimText !== interimRef.current) {
        interimRef.current = interimText;
        interimChangedAtRef.current = Date.now();
      }
      setInterim(interimText);
    };

    rec.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") {
        return; // transient — onend/watchdog will restart if we're still live
      }
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setError({
          message:
            "Microphone access was blocked. Allow mic permission for this site and tap START again.",
          fatal: true
        });
        stopListening();
        return;
      }
      if (event.error === "audio-capture") {
        setError({ message: "No microphone was found. Check your device and try again.", fatal: true });
        stopListening();
        return;
      }
      setError({
        message: `Speech recognition error: ${event.error || "unknown"}.`,
        fatal: false
      });
    };

    // The Web Speech API ends sessions on its own after silence, even with
    // `continuous = true`. Restart shortly after; if start() throws (too soon,
    // engine wedged), the watchdog below recreates the instance within 4s —
    // listening never silently dies.
    rec.onend = () => {
      recRunningRef.current = false;
      if (!listeningRef.current) return;
      window.setTimeout(() => {
        if (!listeningRef.current || recRunningRef.current) return;
        try {
          rec.start();
        } catch {
          /* watchdog recovers */
        }
      }, 250);
    };

    try {
      rec.start();
    } catch {
      return false;
    }
    recognitionRef.current = rec;
    return true;
  }, [handleFinal, stopListening]);

  const startListening = useCallback(() => {
    setError(null);
    blessAudio(); // START is a tap — unlock iOS audio for the voice readout
    if (!spinUpRecognition()) {
      if (getRecognitionCtor()) {
        setError({ message: "Could not start listening. Try again.", fatal: true });
      }
      return;
    }
    listeningRef.current = true;
    setListening(true);

    // Watchdog: if the recognizer died and its own restart failed, rebuild it.
    watchdogRef.current = window.setInterval(() => {
      if (listeningRef.current && !recRunningRef.current) {
        spinUpRecognition();
      }
    }, 4000);

    // Interim flush: finals can lag many seconds behind speech (especially on
    // Android). If interim text has sat unchanged for a beat, summarize it now
    // rather than waiting; handleFinal dedupes when the real final lands.
    flushTimerRef.current = window.setInterval(() => {
      if (!listeningRef.current || flushedRef.current !== null) return;
      const text = interimRef.current.trim();
      if (!text) return;
      if (normWords(text).length < INTERIM_FLUSH_MIN_WORDS) return;
      if (Date.now() - interimChangedAtRef.current < INTERIM_FLUSH_MS) return;
      flushedRef.current = text;
      lookup(text);
    }, 1000);
  }, [blessAudio, lookup, spinUpRecognition]);

  // ── Ambient engine lifecycle ──────────────────────────────────────────────

  const stopAmbient = useCallback(async () => {
    const session = ambientRef.current;
    ambientRef.current = null;
    setDraft("");
    if (session) await session.stop("user");
  }, []);

  const startAmbient = useCallback(async () => {
    setError(null);
    setDraft("");
    setLastHeard("");
    try {
      const session = await startAmbientLive(
        { target: targetRef.current, muted: !voiceOnRef.current },
        {
          onState: setAmbientState,
          onError: (msg) => setError({ message: msg, fatal: false }),
          onHeard: (t) => setLastHeard(t),
          onSummaryDelta: (d) => setDraft((prev) => prev + d),
          onSummaryDone: (t) => {
            setDraft("");
            pushFeed(t, false);
          },
          onTick: setElapsed,
          onStopped: (reason) => {
            ambientRef.current = null;
            setDraft("");
            setElapsed(0);
            if (reason === "idle") {
              setError({
                message: "Stopped after a long quiet stretch. Tap START to keep going.",
                fatal: false
              });
            } else if (reason === "cap") {
              setError({
                message: "Session hit the 2-hour cap. Tap START for a fresh one.",
                fatal: false
              });
            }
          }
        }
      );
      ambientRef.current = session;
    } catch {
      /* onError already surfaced the message */
    }
  }, [pushFeed]);

  const ambientActive = ambientState !== "idle" && ambientState !== "error";

  // ── Shared controls ───────────────────────────────────────────────────────

  const running = engine === "ambient" ? ambientActive : listening;

  // Hold a screen wake lock while running (either engine). The OS releases the
  // lock whenever the page is hidden, so re-acquire on return if still live.
  const runningRef = useRef(false);
  useEffect(() => {
    runningRef.current = running;
    if (running) {
      getWakeLock()
        ?.request("screen")
        .then((sentinel) => {
          if (runningRef.current) wakeLockRef.current = sentinel;
          else void sentinel.release().catch(() => {});
        })
        .catch(() => {
          /* unsupported or denied (e.g. low battery) — nothing to do */
        });
    } else {
      void wakeLockRef.current?.release().catch(() => {});
      wakeLockRef.current = null;
    }
  }, [running]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible" || !runningRef.current) return;
      getWakeLock()
        ?.request("screen")
        .then((sentinel) => {
          if (runningRef.current) wakeLockRef.current = sentinel;
          else void sentinel.release().catch(() => {});
        })
        .catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      void wakeLockRef.current?.release().catch(() => {});
      wakeLockRef.current = null;
    };
  }, []);

  const handlePrimary = useCallback(() => {
    if (engineRef.current === "ambient") {
      if (ambientRef.current) void stopAmbient();
      else void startAmbient();
    } else {
      if (listeningRef.current) stopListening();
      else startListening();
    }
  }, [startAmbient, startListening, stopAmbient, stopListening]);

  const changeEngine = useCallback(
    (next: Engine) => {
      if (next === engineRef.current) return;
      // Switching engines stops everything; the user re-taps START.
      stopListening();
      void stopAmbient();
      setEngine(next);
      setError(null);
    },
    [stopAmbient, stopListening]
  );

  const changeTarget = useCallback(
    (next: AmbientTarget) => {
      if (next === targetRef.current) return;
      targetRef.current = next;
      setTarget(next);
      // Instructions are baked into the session — bounce it for the new target.
      if (ambientRef.current) {
        void stopAmbient().then(() => startAmbient());
      }
    },
    [startAmbient, stopAmbient]
  );

  const changeDirection = useCallback(
    (next: Direction) => {
      if (next === directionRef.current) return;
      directionRef.current = next;
      setDirection(next);
      if (listeningRef.current) {
        stopListening();
        window.setTimeout(() => startListening(), 60);
      }
    },
    [startListening, stopListening]
  );

  const clearAll = useCallback(() => {
    setFeed([]);
    contextRef.current = [];
    setInterim("");
    setDraft("");
    setLastHeard("");
    setError(null);
  }, []);

  // Clean up on unmount.
  useEffect(() => {
    return () => {
      listeningRef.current = false;
      if (watchdogRef.current !== null) window.clearInterval(watchdogRef.current);
      if (flushTimerRef.current !== null) window.clearInterval(flushTimerRef.current);
      const rec = recognitionRef.current;
      if (rec) {
        rec.onend = null;
        try {
          rec.abort();
        } catch {
          /* ignore */
        }
      }
      void ambientRef.current?.stop("user");
      ambientRef.current = null;
      voiceOnRef.current = false;
      speechQueueRef.current = [];
      const a = audioRef.current;
      if (a) {
        try {
          a.pause();
        } catch {
          /* ignore */
        }
      }
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  const ambientStatus =
    ambientState === "connected"
      ? `live · ${formatElapsed(elapsed)}`
      : ambientState === "requesting_mic"
        ? "mic…"
        : ambientState === "minting" || ambientState === "connecting"
          ? "connecting…"
          : ambientState === "stopping"
            ? "stopping…"
            : "";

  return (
    <main className="min-h-screen px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-[calc(env(safe-area-inset-top)+1rem)]">
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-md flex-col gap-4">
        <header className="flex items-center justify-between gap-2">
          <h1 className="text-lg font-semibold tracking-tight text-amber-200">TAOS·LITE</h1>
          <a
            href="/"
            className="rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-sm text-amber-100/80"
          >
            ← Home
          </a>
        </header>

        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-amber-100/50">Live follow-along</div>
          <p className="mt-1 text-sm text-amber-50/70">
            {engine === "ambient"
              ? "Point the phone at the conversation — dinner, TV, a call. Short summaries in your language, on screen and in your ear."
              : "Phone-call mode: pick who's speaking. Short concept summaries, not word-for-word."}
          </p>
        </div>

        {/* Engine toggle */}
        <div className="grid grid-cols-2 gap-2 rounded-2xl border border-white/10 bg-white/5 p-1">
          {(
            [
              ["ambient", "✨ Ambient AI"],
              ["device", "On-device"]
            ] as [Engine, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => changeEngine(key)}
              className={`rounded-xl px-3 py-2 text-sm font-medium transition ${
                engine === key ? "bg-amber-400 text-stone-950" : "text-amber-100/70"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Ambient: target language · Device: direction */}
        {engine === "ambient" ? (
          <div className="grid grid-cols-2 gap-2 rounded-2xl border border-white/10 bg-white/5 p-1">
            {(Object.keys(TARGETS) as AmbientTarget[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => changeTarget(t)}
                className={`rounded-xl px-3 py-2 text-sm font-medium transition ${
                  target === t ? "bg-emerald-400 text-stone-950" : "text-amber-100/70"
                }`}
              >
                {TARGETS[t]}
              </button>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 rounded-2xl border border-white/10 bg-white/5 p-1">
            {(Object.keys(DIRECTIONS) as Direction[]).map((dir) => (
              <button
                key={dir}
                type="button"
                onClick={() => changeDirection(dir)}
                className={`rounded-xl px-3 py-2 text-sm font-medium transition ${
                  direction === dir ? "bg-amber-400 text-stone-950" : "text-amber-100/70"
                }`}
              >
                {DIRECTIONS[dir].label}
              </button>
            ))}
          </div>
        )}

        {/* Unsupported-browser notice (device engine only) */}
        {engine === "device" && !supported ? (
          <p className="rounded-2xl border border-amber-300/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
            On-device speech recognition isn&apos;t available in this browser — switch to Ambient AI,
            or use Chrome on desktop/Android.
          </p>
        ) : null}

        {/* Error banner */}
        {error ? (
          <p
            role="status"
            aria-live="polite"
            className={`rounded-2xl border px-4 py-3 text-sm ${
              error.fatal
                ? "border-rose-400/30 bg-rose-500/10 text-rose-200"
                : "border-amber-300/25 bg-amber-400/5 text-amber-100/80"
            }`}
          >
            {error.message}
          </p>
        ) : null}

        {/* Concept feed — the star of the screen */}
        <section className="flex flex-1 flex-col gap-2">
          <div className="flex items-center justify-between text-xs uppercase tracking-[0.18em] text-emerald-100/50">
            <span>Concepts</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={toggleVoice}
                aria-pressed={voiceOn}
                className={`rounded-full border px-3 py-1 text-[11px] normal-case tracking-normal transition ${
                  voiceOn
                    ? "border-emerald-300/40 bg-emerald-400/15 text-emerald-100"
                    : "border-white/10 bg-white/5 text-amber-100/70"
                }`}
              >
                {voiceOn ? (speakingConcept ? "🔊 Voice · speaking" : "🔊 Voice on") : "🔇 Voice off"}
              </button>
              {feed.length > 0 ? (
                <button
                  type="button"
                  onClick={clearAll}
                  className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] normal-case tracking-normal text-amber-100/70"
                >
                  Clear
                </button>
              ) : null}
            </div>
          </div>

          <div className="flex min-h-[38vh] flex-1 flex-col gap-2">
            {/* Live status card */}
            {running ? (
              <div className="flex items-center gap-2 rounded-2xl border border-emerald-300/20 bg-emerald-400/5 px-4 py-3">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/70" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-emerald-100/70">
                  {engine === "ambient"
                    ? lastHeard
                      ? `heard: ${lastHeard}`
                      : ambientStatus || "listening…"
                    : interim || "listening…"}
                </span>
                {engine === "ambient" && ambientStatus ? (
                  <span className="shrink-0 text-[11px] text-emerald-100/50">{ambientStatus}</span>
                ) : null}
              </div>
            ) : null}

            {/* Streaming summary (ambient) renders as a draft card up top */}
            {draft ? (
              <div className="rounded-3xl border border-emerald-300/30 bg-emerald-400/[0.06] p-5">
                <p className="text-pretty text-[clamp(1.5rem,6vw,2.2rem)] font-semibold leading-tight tracking-tight text-emerald-50">
                  {draft}
                  <span className="animate-pulse">▍</span>
                </p>
              </div>
            ) : null}

            {feed.length === 0 && !draft ? (
              <div className="flex flex-1 items-center justify-center rounded-3xl border border-dashed border-white/10 px-5 py-10 text-center text-amber-100/40">
                {running
                  ? "Waiting for speech…"
                  : "Tap START, then let it listen — summaries will appear here."}
              </div>
            ) : (
              <ol className="flex flex-col gap-2">
                {feed.map((entry) => (
                  <li
                    key={entry.id}
                    className={`rounded-3xl border p-5 ${
                      entry.isGuess
                        ? "border-amber-300/20 bg-amber-400/[0.04]"
                        : "border-white/10 bg-[rgba(18,44,36,0.7)]"
                    }`}
                  >
                    <div className="mb-1.5 flex items-center gap-2">
                      {entry.isGuess ? (
                        <span className="rounded-full border border-amber-300/30 bg-amber-400/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-amber-200/80">
                          guess
                        </span>
                      ) : null}
                      <span className="text-[10px] tracking-wider text-white/25">
                        {formatTime(entry.at)}
                      </span>
                    </div>
                    <p
                      className={`text-pretty text-[clamp(1.5rem,6vw,2.2rem)] font-semibold leading-tight tracking-tight ${
                        entry.isGuess ? "italic text-amber-100/70" : "text-white"
                      }`}
                    >
                      {entry.isGuess ? "~ " : ""}
                      {entry.concept}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>

        {/* Primary control */}
        <section className="flex flex-col gap-3 rounded-3xl border border-white/10 bg-[rgba(20,16,14,0.86)] p-4">
          <button
            type="button"
            onClick={handlePrimary}
            disabled={engine === "device" && !supported}
            className={`flex h-20 items-center justify-center gap-3 rounded-2xl text-xl font-semibold transition active:scale-[0.99] disabled:opacity-50 ${
              running
                ? "animate-pulse bg-amber-400 text-stone-950 shadow-[0_0_34px_rgba(251,191,36,0.6)]"
                : "border border-amber-300/30 bg-stone-50 text-stone-900 hover:bg-white"
            }`}
          >
            <span
              className={`inline-block rounded-[6px] ${
                running ? "h-5 w-5 bg-stone-900/85" : "h-6 w-6 bg-amber-500"
              }`}
            />
            {running ? "STOP" : "START LISTENING"}
          </button>
          {engine === "ambient" && !running ? (
            <p className="text-center text-[11px] text-amber-100/40">
              Ambient AI streams audio to OpenAI while live — hears any language, any number of
              voices. Auto-stops after 5 quiet minutes.
            </p>
          ) : null}
        </section>
      </div>
    </main>
  );
}
