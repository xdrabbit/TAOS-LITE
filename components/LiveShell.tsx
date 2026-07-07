"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ── /live: real-time phone-call follow-along ────────────────────────────────
// Tom holds his phone while Liz talks (on speakerphone, in Spanish) to family.
// We run on-device speech-to-text via the Web Speech API and, on each finalized
// chunk, ask POST /api/live-translate for a short English CONCEPT summary — not
// a word-for-word translation. Concepts stream into a glanceable feed, newest
// on top. An optional Voice toggle reads each concept aloud through the
// existing /api/tts (ElevenLabs clones — Liz's voice reads EN concepts of her
// Spanish). No new server deps, no new API keys, no mic upload leaves the
// device except the recognized text.

// Endpoint direction values (see app/api/live-translate/route.ts).
type Direction = "es-en" | "en-es";

interface DirectionMeta {
  // Who is speaking (source side of the toggle) and the BCP-47 lang the Web
  // Speech API should recognize for them.
  label: string;
  recognitionLang: string;
}

const DIRECTIONS: Record<Direction, DirectionMeta> = {
  "es-en": { label: "Liz (ES → EN)", recognitionLang: "es-ES" },
  "en-es": { label: "Me (EN → ES)", recognitionLang: "en-US" }
};

// Rolling context sent to the endpoint so its guesses improve as the call goes
// on. Keep the last N summaries; the endpoint also caps this server-side.
const MAX_CONTEXT = 10;

// Voice readout: map the endpoint direction to /api/tts language fields so the
// existing voice-follows-speaker logic picks the right clone (Liz's voice reads
// EN concepts of her Spanish, Tom's reads ES concepts of his English).
const TTS_LANGS: Record<Direction, { sourceLanguage: "es" | "en"; targetLanguage: "es" | "en" }> = {
  "es-en": { sourceLanguage: "es", targetLanguage: "en" },
  "en-es": { sourceLanguage: "en", targetLanguage: "es" }
};

// In a live conversation a backlog of spoken summaries is worse than a gap —
// the screen already shows everything. Keep only the newest few pending.
const MAX_SPEECH_QUEUE = 2;

interface ConceptEntry {
  id: number;
  concept: string;
  isGuess: boolean;
  at: number; // ms epoch, for the faint timestamp
}

interface LiveError {
  // `fatal` errors mean listening has stopped (permission/unsupported); a
  // non-fatal one (e.g. a transient no-speech) is just informational.
  message: string;
  fatal: boolean;
}

function getRecognitionCtor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

function formatTime(at: number): string {
  try {
    return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function LiveShell(): JSX.Element {
  const [supported, setSupported] = useState(true);
  const [listening, setListening] = useState(false);
  const [direction, setDirection] = useState<Direction>("es-en");
  const [interim, setInterim] = useState("");
  const [feed, setFeed] = useState<ConceptEntry[]>([]);
  const [error, setError] = useState<LiveError | null>(null);
  const [voiceOn, setVoiceOn] = useState(false);
  const [speakingConcept, setSpeakingConcept] = useState(false);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  // Mirror of `listening` for use inside recognition callbacks (which close over
  // stale state). Drives the auto-restart-on-`onend` behavior.
  const listeningRef = useRef(false);
  // Latest direction for callbacks and for tagging in-flight requests.
  const directionRef = useRef<Direction>("es-en");
  // Rolling summaries, oldest-first — sent to the endpoint as `context`.
  const contextRef = useRef<string[]>([]);
  // Monotonic id source for feed entries (StrictMode-safe, no collisions).
  const idRef = useRef(0);
  // Voice readout plumbing. `voiceOnRef` mirrors `voiceOn` for use inside async
  // chains; the queue holds concepts waiting for TTS, newest-capped.
  const voiceOnRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const speechQueueRef = useRef<{ text: string; direction: Direction }[]>([]);
  const playingRef = useRef(false);

  useEffect(() => {
    directionRef.current = direction;
  }, [direction]);

  useEffect(() => {
    if (!getRecognitionCtor()) setSupported(false);
  }, []);

  const ensureAudioEl = useCallback((): HTMLAudioElement | null => {
    if (!audioRef.current) {
      audioRef.current = typeof Audio !== "undefined" ? new Audio() : null;
    }
    return audioRef.current;
  }, []);

  // Calling play() inside the user gesture "blesses" the element so later
  // programmatic play() (after async TTS fetch) is allowed on iOS Safari.
  const blessAudio = useCallback(() => {
    const a = ensureAudioEl();
    if (!a) return;
    a.play().catch(() => {});
    a.pause();
  }, [ensureAudioEl]);

  // Pull the next queued concept through /api/tts and play it. Strictly one at
  // a time; each finished (or failed) playback drains the next.
  const drainSpeechQueue = useCallback(() => {
    if (playingRef.current) return;
    const next = speechQueueRef.current.shift();
    if (!next) {
      setSpeakingConcept(false);
      return;
    }
    playingRef.current = true;
    setSpeakingConcept(true);

    fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: next.text, ...TTS_LANGS[next.direction] })
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
          // `pause` also fires at natural end and on toggle-off, so it alone
          // would suffice — `ended`/`error` are belt-and-braces.
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
      q.push({ text, direction: directionRef.current });
      while (q.length > MAX_SPEECH_QUEUE) q.shift(); // drop stale, keep newest
      drainSpeechQueue();
    },
    [drainSpeechQueue]
  );

  const toggleVoice = useCallback(() => {
    const next = !voiceOnRef.current;
    voiceOnRef.current = next;
    setVoiceOn(next);
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

  // Fire a single concept lookup for one finalized chunk. Fire-and-render: we
  // do NOT queue or await in order — results are prepended as they return, so a
  // slow response never blocks a newer one.
  const lookup = useCallback((chunk: string) => {
    const text = chunk.trim();
    if (!text) return;
    const dir = directionRef.current;
    const context = contextRef.current.slice(-MAX_CONTEXT);

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
        const raw = typeof payload.concept === "string" ? payload.concept.trim() : "";
        // Defensively strip a leading "~" in case the endpoint left one in the
        // concept text; `isGuess` already carries that signal.
        const concept = raw.replace(/^~\s*/, "").trim();
        if (!concept) return;

        // Feed the summary back into the rolling context window (oldest-first).
        contextRef.current = [...contextRef.current, concept].slice(-MAX_CONTEXT);

        setFeed((prev) => [
          { id: (idRef.current += 1), concept, isGuess: Boolean(payload.isGuess), at: Date.now() },
          ...prev
        ]);
        enqueueSpeech(concept);
      })
      .catch((e) => {
        // A single failed lookup shouldn't stop the call — surface it quietly.
        setError({
          message: e instanceof Error ? e.message : "Concept lookup failed.",
          fatal: false
        });
      });
  }, [enqueueSpeech]);

  const stopListening = useCallback(() => {
    listeningRef.current = false;
    setListening(false);
    setInterim("");
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    if (rec) {
      rec.onend = null; // prevent the auto-restart handler from firing
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    }
  }, []);

  const startListening = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setSupported(false);
      return;
    }
    // Tear down any prior instance before starting a fresh one.
    if (recognitionRef.current) {
      recognitionRef.current.onend = null;
      try {
        recognitionRef.current.stop();
      } catch {
        /* ignore */
      }
      recognitionRef.current = null;
    }

    setError(null);
    const rec = new Ctor();
    rec.lang = DIRECTIONS[directionRef.current].recognitionLang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (event) => {
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) {
          // Only FINAL chunks hit the API; interim text is display-only.
          lookup(transcript);
        } else {
          interimText += transcript;
        }
      }
      setInterim(interimText);
    };

    rec.onerror = (event) => {
      // Map the common recoverable/fatal cases to clear UI copy.
      if (event.error === "no-speech" || event.error === "aborted") {
        return; // transient — onend will restart if we're still live
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

    // The Web Speech API ends a session on its own after silence even with
    // `continuous = true`. Auto-restart while the user still wants to listen.
    rec.onend = () => {
      if (!listeningRef.current) return;
      try {
        rec.start();
      } catch {
        /* start can throw if called too soon; ignore and rely on user retry */
      }
    };

    try {
      rec.start();
    } catch {
      setError({ message: "Could not start listening. Try again.", fatal: true });
      return;
    }

    recognitionRef.current = rec;
    listeningRef.current = true;
    setListening(true);
  }, [lookup, stopListening]);

  // Restart recognition with the new source language when the direction toggle
  // flips mid-call.
  const changeDirection = useCallback(
    (next: Direction) => {
      if (next === directionRef.current) return;
      directionRef.current = next;
      setDirection(next);
      if (listeningRef.current) {
        // Bounce recognition so the new `lang` takes effect.
        const wasListening = listeningRef.current;
        stopListening();
        if (wasListening) {
          // Restart on the next tick so the prior instance fully releases.
          window.setTimeout(() => startListening(), 60);
        }
      }
    },
    [startListening, stopListening]
  );

  const clearAll = useCallback(() => {
    setFeed([]);
    contextRef.current = [];
    setInterim("");
    setError(null);
  }, []);

  // Clean up on unmount.
  useEffect(() => {
    return () => {
      listeningRef.current = false;
      const rec = recognitionRef.current;
      if (rec) {
        rec.onend = null;
        try {
          rec.abort();
        } catch {
          /* ignore */
        }
      }
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
            Put the call on speakerphone. You&apos;ll see short English concepts, not word-for-word —
            enough to follow along.
          </p>
        </div>

        {/* Direction toggle */}
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

        {/* Unsupported-browser notice */}
        {!supported ? (
          <p className="rounded-2xl border border-amber-300/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
            Live speech recognition isn&apos;t available in this browser. Use Chrome on desktop or
            Android; iOS Safari support is limited.
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

          {voiceOn ? (
            <p className="rounded-2xl border border-emerald-300/15 bg-emerald-400/5 px-4 py-2 text-xs text-emerald-100/60">
              Concepts are read aloud as they arrive. Headphones or an earpiece work best so the mic
              doesn&apos;t pick the voice back up.
            </p>
          ) : null}

          <div className="flex min-h-[38vh] flex-1 flex-col gap-2">
            {/* Live listening affordance sits at the top so it's near new concepts */}
            {listening ? (
              <div className="flex items-center gap-2 rounded-2xl border border-emerald-300/20 bg-emerald-400/5 px-4 py-3">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/70" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-emerald-100/70">
                  {interim ? interim : "listening…"}
                </span>
              </div>
            ) : null}

            {feed.length === 0 ? (
              <div className="flex flex-1 items-center justify-center rounded-3xl border border-dashed border-white/10 px-5 py-10 text-center text-amber-100/40">
                {listening
                  ? "Waiting for speech…"
                  : "Tap START, then play or speak — concepts will appear here."}
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
            onClick={listening ? stopListening : startListening}
            disabled={!supported}
            className={`flex h-20 items-center justify-center gap-3 rounded-2xl text-xl font-semibold transition active:scale-[0.99] disabled:opacity-50 ${
              listening
                ? "animate-pulse bg-amber-400 text-stone-950 shadow-[0_0_34px_rgba(251,191,36,0.6)]"
                : "border border-amber-300/30 bg-stone-50 text-stone-900 hover:bg-white"
            }`}
          >
            <span
              className={`inline-block rounded-[6px] ${
                listening ? "h-5 w-5 bg-stone-900/85" : "h-6 w-6 bg-amber-500"
              }`}
            />
            {listening ? "STOP" : "START LISTENING"}
          </button>
        </section>
      </div>
    </main>
  );
}
