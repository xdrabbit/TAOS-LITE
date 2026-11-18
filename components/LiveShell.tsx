"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  startAmbientLive,
  type ActiveAmbientSession,
  type AmbientState
} from "@/lib/live/ambient";
import {
  DEFAULT_LIVE_STYLE,
  LIVE_STYLES,
  readStoredLiveStyle,
  storeLiveStyle,
  type LiveStyle
} from "@/lib/live/style";
import {
  createEchoGuard,
  createLiveEchoGate,
  effectiveLiveStyle,
  readStoredLiveAuto,
  storeLiveAuto,
  type LiveEchoGate,
  type LiveLine
} from "@/lib/live/auto";
import { LIVE_SAVE_UNAVAILABLE, readStoredLiveSave, storeLiveSave, type LiveSaveStatus } from "@/lib/live/saved";
import { createLiveSaver, fetchLiveSaveStatus, type LiveSaver } from "@/lib/live/saveClient";
import { copyFor, fill } from "@/lib/chrome/copy";
import Link from "next/link";
import { keepWake } from "@/lib/wakeLock";
import { isTextOnlyLanguage, requestSpeech, TEXT_ONLY_TITLE } from "@/lib/tts/speech";
import { LanguagePillRow, LanguageSheet } from "./LanguagePicker";
import { JumpToTail, useFollowTail } from "./FollowTail";
import { useLanguagePair } from "@/lib/translate/useLanguagePair";
import { recognitionTag } from "@/lib/languages/recognition";
import { languageNative } from "@/lib/languages/catalog";
import { pairDirection, type PairDirection, type PairLangCode, type PairSide } from "@/lib/translate/pair";
import { onDeviceSttEnabled } from "@/lib/release";
import { jsonAuthHeaders } from "@/lib/authClient";
import { ExitHome } from "./ExitHome";

// ── /live: real-time follow-along ───────────────────────────────────────────
// Use case: Tom & Liz at a dinner, on a call, or watching TV in a language one
// of them doesn't follow. The phone listens and keeps them current with
// ultra-short summaries in the target language — written on screen and spoken
// into an earpiece. Freshness beats completeness: anything stale gets dropped,
// never queued.
//
// Two engines — but only one of them ships in RC1:
//  • "Ambient AI" (default, and the only one on) — continuous WebRTC stream to
//    a GA Realtime session (lib/live/ambient.ts). Hears any language and
//    multiple voices, speaks its summaries natively (no TTS round-trip). This
//    is the mode for dinners, TV, and movies.
//  • "On-device" — the original free path: Web Speech API transcription →
//    POST /api/live-translate per chunk → optional /api/tts readout. One
//    recognition language at a time; best for a single nearby speaker. Gated
//    off behind NEXT_PUBLIC_ENABLE_ONDEVICE_STT (onDeviceSttEnabled() in
//    lib/release.ts): the browser API it stands on isn't there on iOS or in
//    much of PWA standalone, and it has never worked for Tom. Everything
//    below that reads `engine === "device"` is live code kept warm for the
//    post-RC investigation — with the flag off, `engine` never leaves
//    "ambient", so those branches simply don't run.

type Engine = "ambient" | "device";

// Which side of the pair the on-device recognizer is pointed at. This used to
// be an "es-en" | "en-es" string with its own table of labels and BCP-47 tags
// beside it — the last hard-coded language pair in /live. What the toggle
// actually asks has never changed: "who is talking, them or me?" The pair
// (lib/translate/pair.ts) answers which languages that means.
type Side = PairSide;


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

// A backlog of spoken summaries is worse than a gap. Keep only the newest few.
const MAX_SPEECH_QUEUE = 2;
// Cap the on-screen feed so a two-hour dinner doesn't grow the DOM forever.
const MAX_FEED = 200;

interface ConceptEntry {
  id: number;
  concept: string;
  isGuess: boolean;
  at: number;
  /** Not something anyone said: the screen admitting a gap (word-for-word). */
  note?: boolean;
  /**
   * Two-way Auto: the whole line — what was heard, what it became, and the
   * language of each (lib/live/auto.ts). Both people read this one screen, so
   * an Auto entry shows both halves, each under its own language's name.
   */
  line?: LiveLine;
}

interface LiveError {
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
  // RC1: one engine, no toggle (lib/release.ts). Read once at render — the
  // flag is inlined at build time, so this is a constant for the session.
  const onDeviceAllowed = onDeviceSttEnabled();
  // Always "ambient" at mount, flag or no flag: nothing persists the choice,
  // which is what makes turning the flag off safe. If a future change ever
  // does persist it, restore through this initializer so a stored "device"
  // can't outlive the flag.
  const [engine, setEngine] = useState<Engine>("ambient");
  // On-device only: whose speech the recognizer is listening for. Ambient AI
  // hears the room and needs no such toggle.
  const [side, setSide] = useState<Side>("theirs");
  const [supported, setSupported] = useState(true);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [feed, setFeed] = useState<ConceptEntry[]>([]);
  const [error, setError] = useState<LiveError | null>(null);
  // "This is about to stop" — shown BEFORE it stops, so a quiet stretch at
  // dinner is something the listener can head off by saying anything, rather
  // than something they discover from a message after the earpiece went dead.
  const [endingSoon, setEndingSoon] = useState<{ reason: "idle" | "cap"; seconds: number } | null>(
    null
  );
  // Voice defaults ON — the whole point is the earpiece. START is a user
  // gesture, so autoplay is unlocked in both engines.
  const [voiceOn, setVoiceOn] = useState(true);
  const [speakingConcept, setSpeakingConcept] = useState(false);
  // Ambient engine state.
  const [ambientState, setAmbientState] = useState<AmbientState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [draft, setDraft] = useState("");
  const [lastHeard, setLastHeard] = useState("");

  // Summary (what /live has always done, and the default) or word for word.
  // Starts on the default at render and is restored from this device after
  // mount — the server render has no storage, and a stored "verbatim" painted
  // one frame late is better than a hydration mismatch.
  const [style, setStyle] = useState<LiveStyle>(DEFAULT_LIVE_STYLE);
  const styleRef = useRef<LiveStyle>(DEFAULT_LIVE_STYLE);

  // Two-way Auto (Tom and Liz, 11/17): one phone between two people, either
  // language heard and written in the other. OFF unless this device turned it
  // on, restored after mount like the style. See lib/live/auto.ts.
  const [auto, setAuto] = useState(false);
  const autoRef = useRef(false);
  // Auto writes; it only speaks if asked, and it is never asked by default —
  // a phone on the table that is not speaking cannot hear itself. Off again
  // every time Auto is switched on.
  const [autoVoice, setAutoVoice] = useState(false);
  const autoVoiceRef = useRef(false);
  // Shown plainly, never guessed around: lines whose language tag could not
  // be read, and heard segments dropped for being this phone's own readout.
  const [misses, setMisses] = useState(0);
  const [echoes, setEchoes] = useState(0);
  const echoGuardRef = useRef(createEchoGuard());
  const echoGateRef = useRef<LiveEchoGate | null>(null);
  const autoSpeechRef = useRef<{ line: LiveLine; queuedAt: number }[]>([]);
  const autoSpeakingRef = useRef(false);
  // Which session a readout belongs to. Every stop — STOP, the idle and cap
  // auto-stops, a restart, leaving the page — moves this on, and a readout
  // whose /api/tts answer comes back afterwards finds a different number and
  // is dropped: it may not play into a stopped room, and it may not touch the
  // mic of the session that replaced its own.
  const readoutGenRef = useRef(0);

  // "Save this conversation": text only, off by default, and nothing is sent
  // unless it is on at the moment a line is produced. The toggle is not drawn
  // at all until the server says this user may save (lib/live/saveAccess.ts),
  // and is drawn disabled while the tables are not there yet.
  const [saveStatus, setSaveStatus] = useState<LiveSaveStatus>(LIVE_SAVE_UNAVAILABLE);
  const [saveOn, setSaveOn] = useState(false);
  const saveOnRef = useRef(false);
  const [saveFailed, setSaveFailed] = useState(0);
  const saverRef = useRef<LiveSaver | null>(null);

  const engineRef = useRef<Engine>("ambient");
  const ambientRef = useRef<ActiveAmbientSession | null>(null);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const listeningRef = useRef(false);
  // True while the recognizer is actually running (onstart..onend). The
  // watchdog compares this with listeningRef to catch silent deaths.
  const recRunningRef = useRef(false);
  const watchdogRef = useRef<number | null>(null);
  const sideRef = useRef<Side>("theirs");
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

  // Voice readout plumbing (device engine).
  const voiceOnRef = useRef(true);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const speechQueueRef = useRef<{ text: string; languages: PairDirection; queuedAt: number }[]>(
    []
  );
  const playingRef = useRef(false);

  // The pair, the pill row and the sheet — the same ones /translate draws
  // (components/LanguagePicker.tsx). [mine, theirs]: on /live YOU are the
  // listener, so the summaries come out in `mine` and the room speaks
  // `theirs`. That is the opposite direction from /translate and it is why
  // the persisted pair is worth having here: a phone left on [en, it] after
  // ordering dinner is already right for following that same table.
  const { pair, mine, theirs, pills, sheetOpen, setSheetOpen, selectLanguage } = useLanguagePair();

  // Every streaming callback below reads the languages through refs, never
  // through the render closure. That is deliberate: it keeps their identities
  // stable, so changing a language never re-creates the recognizer's handlers
  // or re-arms the flush/watchdog intervals mid-conversation.
  const pairRef = useRef<readonly [PairLangCode, PairLangCode]>(pair);
  useEffect(() => {
    pairRef.current = pair;
  }, [pair]);
  useEffect(() => {
    sideRef.current = side;
  }, [side]);
  useEffect(() => {
    engineRef.current = engine;
  }, [engine]);

  useEffect(() => {
    if (!getRecognitionCtor()) setSupported(false);
  }, []);

  useEffect(() => {
    const restored = readStoredLiveStyle();
    styleRef.current = restored;
    setStyle(restored);
    const restoredAuto = readStoredLiveAuto();
    autoRef.current = restoredAuto;
    setAuto(restoredAuto);
  }, []);

  // Asked once. Until it answers — and on any failure — there is no toggle,
  // and a stored "on" is only honoured once saving is actually possible.
  useEffect(() => {
    let alive = true;
    void fetchLiveSaveStatus().then((status) => {
      if (!alive) return;
      setSaveStatus(status);
      if (status.allowed && status.ready && readStoredLiveSave()) {
        saveOnRef.current = true;
        setSaveOn(true);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const pushFeed = useCallback((concept: string, isGuess: boolean, note = false) => {
    const entry: ConceptEntry = { id: (idRef.current += 1), concept, isGuess, at: Date.now(), note };
    setFeed((prev) => [entry, ...prev].slice(0, MAX_FEED));
  }, []);

  const pushLine = useCallback((line: LiveLine) => {
    const entry: ConceptEntry = {
      id: (idRef.current += 1),
      concept: line.text,
      isGuess: false,
      at: Date.now(),
      line
    };
    setFeed((prev) => [entry, ...prev].slice(0, MAX_FEED));
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

    requestSpeech({ text: next.text, latency: "flash", ...next.languages }, { surface: "live" })
      .then((blob) => {
        // null = text only (lib/tts/speech.ts). The feed already has the
        // concept on screen, which on a tier-2 language IS the whole readout —
        // so drop it and drain the next one without a word.
        if (!blob) return;
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
      const languages = pairDirection(pairRef.current, sideRef.current);
      // Tier 2 (lib/languages/catalog.ts): nothing can say this language, so
      // it never enters the queue — no request, no wait, no error. The screen
      // says "text only" on the voice button so this was never a surprise.
      // The SUMMARY still reached the feed; only the readout stops, which is
      // the whole tier-2 bargain on a streaming screen.
      if (isTextOnlyLanguage(languages.targetLanguage)) return;
      const q = speechQueueRef.current;
      // Snapshot the languages with the text: a queued readout must be spoken
      // in the language it was summarized into, even if the pair moved while
      // it waited its turn.
      q.push({ text, languages, queuedAt: Date.now() });
      while (q.length > MAX_SPEECH_QUEUE) q.shift(); // drop stale, keep newest
      drainSpeechQueue();
    },
    [drainSpeechQueue]
  );

  // ── Voice readout (two-way Auto) ──────────────────────────────────────────
  // An Auto session produces text, so its optional voice is /api/tts — the
  // table's readout, with the voice-follows-speaker rule deciding whose voice.
  // Two fences keep the phone from translating itself (lib/live/auto.ts):
  // the mic is held shut from the first audible sample until 300 ms after the
  // last (echoGateRef), and what was spoken is remembered so that anything
  // that still gets through is dropped by its words (echoGuardRef).
  //
  // And one courtesy: a readout does not START while somebody is mid-sentence.
  // Shutting the mic there would cut their sentence in half, so the line waits
  // for the pause — and if no pause comes inside STALE_SPEECH_MS it is not
  // spoken at all; it has been on the screen the whole time.
  const drainAutoSpeech = useCallback(() => {
    if (autoSpeakingRef.current) return;
    let next = autoSpeechRef.current.shift();
    while (next && Date.now() - next.queuedAt > STALE_SPEECH_MS) next = autoSpeechRef.current.shift();
    if (!next || !autoVoiceRef.current) {
      autoSpeechRef.current = next && autoVoiceRef.current ? autoSpeechRef.current : [];
      setSpeakingConcept(false);
      return;
    }
    const { line, queuedAt } = next;
    autoSpeakingRef.current = true;
    // The session this line came from, and that session's own mic gate.
    const gen = readoutGenRef.current;
    const gate = echoGateRef.current;
    const current = () => gen === readoutGenRef.current && autoVoiceRef.current;
    const quiet = () =>
      new Promise<boolean>((resolve) => {
        const check = () => {
          if (!current() || Date.now() - queuedAt > STALE_SPEECH_MS) return resolve(false);
          // No session is not a quiet room: there is nobody to read to.
          const session = ambientRef.current;
          if (!session) return resolve(false);
          if (!session.speechActive()) return resolve(true);
          window.setTimeout(check, 150);
        };
        check();
      });
    requestSpeech(
      {
        text: line.text,
        latency: "flash",
        sourceLanguage: line.heardLang as PairLangCode,
        targetLanguage: line.textLang as PairLangCode
      },
      { surface: "live" }
    )
      .then(async (blob) => {
        // Stopped, restarted or voice switched off while the audio was in
        // flight (or while waiting for the pause): not played.
        if (!blob || !current() || !(await quiet()) || !current()) return;
        const a = ensureAudioEl();
        if (!a) return;
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
        const url = URL.createObjectURL(blob);
        objectUrlRef.current = url;
        a.src = url;
        setSpeakingConcept(true);
        // Shut the mic BEFORE the first sample…
        gate?.speakStart();
        let started = false;
        try {
          await new Promise<void>((resolve) => {
            a.onended = () => resolve();
            a.onpause = () => resolve();
            a.onerror = () => resolve();
            a.play().then(
              () => {
                // …but remember the words only once they are really audible.
                // A play() the browser refused made no sound, and an entry for
                // it would drop somebody genuinely saying that sentence.
                started = true;
                echoGuardRef.current.spoke(line.text, Date.now());
              },
              () => resolve()
            );
          });
          if (started) echoGuardRef.current.finished(line.text, Date.now());
        } finally {
          // Whatever happened to the playback, the mic comes back.
          gate?.speakEnd();
        }
      })
      .catch(() => {
        // Voice is a bonus layer — a failed readout never interrupts the feed.
      })
      .finally(() => {
        autoSpeakingRef.current = false;
        drainAutoSpeech();
      });
  }, [ensureAudioEl]);

  const enqueueAutoSpeech = useCallback(
    (line: LiveLine) => {
      // A miss has no direction, so there is no voice to pick: not spoken.
      if (!autoVoiceRef.current || !line.heardLang || !line.textLang) return;
      if (isTextOnlyLanguage(line.textLang as PairLangCode)) return;
      const q = autoSpeechRef.current;
      q.push({ line, queuedAt: Date.now() });
      while (q.length > MAX_SPEECH_QUEUE) q.shift();
      drainAutoSpeech();
    },
    [drainAutoSpeech]
  );

  const silenceAutoVoice = useCallback(() => {
    autoSpeechRef.current = [];
    setSpeakingConcept(false);
    const a = audioRef.current;
    if (a) {
      try {
        a.pause();
      } catch {
        /* ignore */
      }
    }
    echoGateRef.current?.speakEnd();
  }, []);

  const toggleVoice = useCallback(() => {
    // Auto is ambient-only, so its voice switch is too: a remembered Auto on
    // the on-device engine must not capture the button that engine draws.
    if (autoRef.current && engineRef.current === "ambient") {
      // Auto has its own voice switch (default off); the earpiece voice of
      // one-direction /live is left exactly as it was set.
      const on = !autoVoiceRef.current;
      autoVoiceRef.current = on;
      setAutoVoice(on);
      if (on) blessAudio();
      else silenceAutoVoice();
      return;
    }
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
  }, [blessAudio, silenceAutoVoice]);

  // ── Concept lookup (device engine) ────────────────────────────────────────

  // Fire-and-render with freshness guards: results render as they return, but
  // anything slower than a newer utterance — or older than 30s — is discarded.
  const lookup = useCallback(
    (chunk: string) => {
      const text = chunk.trim();
      if (!text) return;
      const languages = pairDirection(pairRef.current, sideRef.current);
      const context = contextRef.current.slice(-MAX_CONTEXT);
      const seq = (utterSeqRef.current += 1);
      const startedAt = Date.now();

      jsonAuthHeaders()
        .then((headers) =>
          fetch("/api/live-translate", {
            method: "POST",
            headers,
            body: JSON.stringify({ text, ...languages, context })
          })
        )
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
    // The browser wants BCP-47, the app speaks Whisper's codes
    // (lib/languages/recognition.ts bridges the two).
    rec.lang = recognitionTag(pairDirection(pairRef.current, sideRef.current).sourceLanguage);
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
    setEndingSoon(null);
    // Any readout still on its way belongs to the session being stopped.
    readoutGenRef.current += 1;
    silenceAutoVoice();
    echoGateRef.current?.dispose();
    if (session) await session.stop("user");
  }, [silenceAutoVoice]);

  // startAmbient restarts itself (below) when Auto changed under it, so it
  // reaches both through refs rather than naming itself in its own closure.
  const stopAmbientRef = useRef<() => Promise<void>>(async () => {});
  stopAmbientRef.current = stopAmbient;
  const startAmbientRef = useRef<() => Promise<void>>(async () => {});

  const startAmbient = useCallback(async () => {
    setError(null);
    setEndingSoon(null);
    setDraft("");
    setLastHeard("");
    // Auto is a property of the SESSION (it is minted that way), so it is
    // read once here and every callback below uses this value, not the chip.
    const sessionAuto = autoRef.current;
    readoutGenRef.current += 1;
    echoGuardRef.current.clear();
    echoGateRef.current?.dispose();
    echoGateRef.current = createLiveEchoGate({
      setMicHeld: (held) => ambientRef.current?.setMicHeld(held)
    });
    // One saver per START. It makes no id and no request until it is handed
    // a line, and it is only handed lines while the toggle is on.
    saverRef.current = createLiveSaver(
      {
        mine: pairRef.current[0],
        theirs: pairRef.current[1],
        style: effectiveLiveStyle(styleRef.current, sessionAuto),
        auto: sessionAuto
      },
      () => setSaveFailed((n) => n + 1)
    );
    try {
      const session = await startAmbientLive(
        // Read out of the ref, not the closure: startAmbient is a useCallback
        // and this keeps it from being rebuilt on every language change.
        {
          target: pairRef.current[0],
          source: pairRef.current[1],
          style: styleRef.current,
          auto: sessionAuto,
          isEcho: (heard) => echoGuardRef.current.isEcho(heard, Date.now()),
          muted: !voiceOnRef.current
        },
        {
          onState: setAmbientState,
          onError: (msg) => setError({ message: msg, fatal: false }),
          onHeard: (t) => setLastHeard(t),
          onSummaryDelta: (d) => setDraft((prev) => prev + d),
          onSummaryDone: (t) => {
            setDraft("");
            // An Auto line reaches the feed whole, from onLine below.
            if (!sessionAuto) pushFeed(t, false);
          },
          onLine: (line) => {
            if (sessionAuto) {
              pushLine(line);
              if (line.detect === "miss") setMisses((n) => n + 1);
              enqueueAutoSpeech(line);
            }
            // Read at the moment the line exists: nothing is written unless
            // the toggle is on right now.
            if (saveOnRef.current) saverRef.current?.line(line);
          },
          onEchoDropped: () => setEchoes((n) => n + 1),
          // Word for word fell too far behind and left something out rather
          // than guess at it. Say so, in the feed, where the gap is.
          onSkipped: () => pushFeed(copyFor(pairRef.current[0]).liveSkippedAhead, false, true),
          onTick: setElapsed,
          onEndingSoon: (reason, seconds) => setEndingSoon({ reason, seconds }),
          onWarningCleared: () => setEndingSoon(null),
          onStopped: (reason) => {
            ambientRef.current = null;
            // The idle and cap stops end the readouts too, exactly as STOP does.
            readoutGenRef.current += 1;
            silenceAutoVoice();
            echoGateRef.current?.dispose();
            setDraft("");
            setElapsed(0);
            setEndingSoon(null);
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
      // The chip may have been tapped while this was connecting, when there
      // was no session to tell. A no-op when they already agree.
      session.setStyle(styleRef.current);
      // Auto cannot be told to a session — it is minted in. If the chip was
      // tapped while this one was connecting, the screen now says one thing
      // and the session does another: bounce, exactly as a tap while live does.
      if (autoRef.current !== sessionAuto) {
        await stopAmbientRef.current();
        await startAmbientRef.current();
      }
    } catch {
      /* onError already surfaced the message */
    }
  }, [enqueueAutoSpeech, pushFeed, pushLine, silenceAutoVoice]);
  startAmbientRef.current = startAmbient;

  const ambientActive = ambientState !== "idle" && ambientState !== "error";

  // ── Shared controls ───────────────────────────────────────────────────────

  const running = engine === "ambient" ? ambientActive : listening;

  // Hold a screen wake lock while running (either engine) — and only then.
  // keepWake refreshes on a heartbeat, so a session that is genuinely live
  // outlives the idle cap while a stopped one does not (lib/wakeLock.ts).
  useEffect(() => {
    if (!running) return;
    return keepWake("live-session");
  }, [running]);

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
      // The toggle is unrendered when the flag is off, so nothing should be
      // calling this with "device" — but the guard is here rather than only in
      // the JSX so that the mode stays unreachable if some other code path
      // (a deep link, a restored preference, a later refactor) tries.
      if (next === "device" && !onDeviceAllowed) return;
      if (next === engineRef.current) return;
      // Switching engines stops everything; the user re-taps START.
      stopListening();
      void stopAmbient();
      setEngine(next);
      setError(null);
    },
    [onDeviceAllowed, stopAmbient, stopListening]
  );

  // No restart: an open session is re-pointed over its data channel and the
  // next thing anyone says comes out in the new style (lib/live/ambient.ts,
  // setStyle). Not running, it is simply what the next START mints.
  const changeStyle = useCallback((next: LiveStyle) => {
    if (next === styleRef.current) return;
    styleRef.current = next;
    setStyle(next);
    storeLiveStyle(next);
    ambientRef.current?.setStyle(next);
  }, []);

  // Auto is minted into the session (text out, tagged prompt), so flipping it
  // while live is the same bounce a language change does — a second or two —
  // rather than a patch. Voice goes back to off: see autoVoice above.
  const changeAuto = useCallback(
    (next: boolean) => {
      if (next === autoRef.current) return;
      autoRef.current = next;
      setAuto(next);
      storeLiveAuto(next);
      autoVoiceRef.current = false;
      setAutoVoice(false);
      if (ambientRef.current) void stopAmbient().then(() => startAmbient());
    },
    [startAmbient, stopAmbient]
  );

  const changeSave = useCallback((next: boolean) => {
    saveOnRef.current = next;
    setSaveOn(next);
    storeLiveSave(next);
  }, []);

  const changeSide = useCallback(
    (next: Side) => {
      if (next === sideRef.current) return;
      sideRef.current = next;
      setSide(next);
      if (listeningRef.current) {
        stopListening();
        window.setTimeout(() => startListening(), 60);
      }
    },
    [startListening, stopListening]
  );

  // A language change means both engines are pointed at the wrong one: the
  // ambient session bakes its instructions in at mint time, and the recognizer
  // bakes its BCP-47 tag in at construction. Bounce whichever is running —
  // the same bounce changing the target/direction has always done, now on one
  // path instead of two. Nothing running (including the restore at mount) is
  // a no-op: both branches check before they act.
  const pairKey = `${pair[0]}:${pair[1]}`;
  const lastPairKeyRef = useRef(pairKey);
  useEffect(() => {
    if (lastPairKeyRef.current === pairKey) return;
    lastPairKeyRef.current = pairKey;
    if (engineRef.current === "ambient") {
      if (ambientRef.current) void stopAmbient().then(() => startAmbient());
    } else if (listeningRef.current) {
      stopListening();
      window.setTimeout(() => startListening(), 60);
    }
  }, [pairKey, startAmbient, stopAmbient, startListening, stopListening]);

  const clearAll = useCallback(() => {
    setFeed([]);
    contextRef.current = [];
    setInterim("");
    setDraft("");
    setLastHeard("");
    setError(null);
    setMisses(0);
    setEchoes(0);
    setSaveFailed(0);
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
      readoutGenRef.current += 1;
      echoGateRef.current?.dispose();
      autoVoiceRef.current = false;
      autoSpeechRef.current = [];
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

  // The device engine reads its summaries out through /api/tts, so a tier-2
  // target (lib/languages/catalog.ts) has no voice to offer and the button
  // should say that rather than sit there claiming "Voice on" over silence.
  // Ambient AI speaks inside the realtime session and never asks /api/tts, so
  // it is not subject to this.
  const spoken = pairDirection(pair, side);
  const readoutTextOnly = engine === "device" && isTextOnlyLanguage(spoken.targetLanguage);
  // What the screen is doing right now, as a pair of language names. Ambient
  // AI always runs room → you; the on-device engine follows the side toggle.
  const heardLanguage = engine === "ambient" ? theirs : spoken.sourceLanguage;
  // The draft only ever exists while a summary streams; it is cleared the
  // moment the summary lands in the feed.
  const draftTail = useFollowTail(!!draft, draft);
  const readLanguage = engine === "ambient" ? mine : spoken.targetLanguage;
  // The style toggle's words follow the phone's owner, like the rest of the
  // chrome that has been moved to lib/chrome/copy.ts.
  const t = copyFor(mine);
  // Auto is ambient-only (the on-device engine has no session to tag).
  const autoOn = engine === "ambient" && auto;
  const shownStyle = effectiveLiveStyle(style, autoOn);
  const voiceShown = autoOn ? autoVoice : voiceOn;
  const saveUsable = saveStatus.allowed && saveStatus.ready;
  // The way to what was saved is not the right to save more: someone whose
  // access was narrowed still has to be able to reach, export and delete it.
  const savedReachable = saveUsable || saveStatus.hasSaved;

  return (
    <main className="min-h-screen px-4 pt-[calc(env(safe-area-inset-top)+1rem)]">
      <div className="mx-auto flex min-h-[calc(100vh-1rem)] max-w-md flex-col gap-4">
        <header className="flex items-center gap-3">
          <ExitHome lang={mine} />
          <h1 className="text-lg font-semibold tracking-tight text-amber-200">TAOS·LITE</h1>
        </header>

        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-amber-100/50">Live follow-along</div>
          <p className="mt-1 text-sm text-amber-50/70">
            {autoOn
              ? fill(t.liveAutoHint, { a: languageNative(mine), b: languageNative(theirs) })
              : engine === "ambient"
                ? "Point the phone at the conversation — dinner, TV, a call. Short summaries in your language, on screen and in your ear."
                : "Phone-call mode: pick who's speaking. Short concept summaries, not word-for-word."}
          </p>
        </div>

        {/* Engine toggle. Off for RC1 (lib/release.ts) — a two-button row with
            one button is worse than no row: it asks a question the screen has
            already answered. Ambient AI is simply what /live is. */}
        {onDeviceAllowed ? (
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
        ) : null}

        {/* The languages. Same row and same sheet as /translate, pointed the
            other way round: here the solid pill is what you are LISTENING to
            and your own outlined pill is what you read. Tap your own to swap
            sides. The line underneath spells the direction out so nobody has
            to infer it from which pill is filled in. */}
        <LanguagePillRow
          pills={pills}
          selected={theirs}
          paired={mine}
          caption="Around you · A tu alrededor"
          sheetOpen={sheetOpen}
          onSelect={selectLanguage}
          onOpenSheet={() => setSheetOpen(true)}
        />
        <p className="-mt-2 text-xs text-amber-100/50">
          {languageNative(heardLanguage)} {autoOn ? "⇄" : "→"} {languageNative(readLanguage)}
          {readoutTextOnly ? " · text only · solo texto" : ""}
        </p>

        {/* Style: Summary (the default — what /live has always done) or word
            for word. Its own row, in the Voice chip's style, and it WRAPS: the
            Spanish labels are wider, and a row that overflows a 375 makes the
            page pannable, which is how taps got eaten in #53. Ambient only —
            the on-device engine has one prompt and no session to re-point.
            Deliberately up here and not in the pinned Stop/Clear bar. */}
        {engine === "ambient" ? (
          <div data-live-style="" className="-mt-1 flex flex-col gap-1.5">
            <div
              role="group"
              aria-label={t.liveStyleLabel}
              className="flex flex-wrap items-center gap-2"
            >
              {LIVE_STYLES.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => changeStyle(key)}
                  aria-pressed={shownStyle === key}
                  // Auto is word for word only (lib/live/auto.ts). The chips
                  // show that, and the stored style waits for Auto to go off.
                  disabled={autoOn}
                  className={`rounded-full border px-3 py-1 text-[11px] transition disabled:opacity-60 ${
                    shownStyle === key
                      ? "border-emerald-300/40 bg-emerald-400/15 text-emerald-100"
                      : "border-white/10 bg-white/5 text-amber-100/70"
                  }`}
                >
                  {key === "verbatim" ? t.liveStyleVerbatim : t.liveStyleSummary}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-amber-100/50">
              {autoOn
                ? t.liveAutoVerbatimOnly
                : style === "verbatim"
                  ? t.liveStyleVerbatimHint
                  : t.liveStyleSummaryHint}
            </p>
          </div>
        ) : null}

        {/* Two-way Auto and "Save this conversation" — a second row of the
            same chips, wrapping for the same reason the style row does. Auto
            is OFF unless this device turned it on, so anyone who ignores this
            row has the /live they had. The Save chip is not drawn at all until
            the server says this user may save, and is drawn disabled (with
            the reason) while the tables are not there yet. The link to what
            was saved follows a different rule: it is there for anyone who can
            save OR already has something saved. */}
        {engine === "ambient" ? (
          <div data-live-auto="" className="-mt-1 flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-live-auto-chip=""
                onClick={() => changeAuto(!auto)}
                aria-pressed={auto}
                className={`rounded-full border px-3 py-1 text-[11px] transition ${
                  auto
                    ? "border-emerald-300/40 bg-emerald-400/15 text-emerald-100"
                    : "border-white/10 bg-white/5 text-amber-100/70"
                }`}
              >
                ⇄ {t.liveAutoChip}
              </button>
              {saveStatus.allowed ? (
                <button
                  type="button"
                  data-live-save-chip=""
                  onClick={() => changeSave(!saveOn)}
                  aria-pressed={saveUsable && saveOn}
                  disabled={!saveUsable}
                  className={`rounded-full border px-3 py-1 text-[11px] transition disabled:opacity-60 ${
                    saveUsable && saveOn
                      ? "border-emerald-300/40 bg-emerald-400/15 text-emerald-100"
                      : "border-white/10 bg-white/5 text-amber-100/70"
                  }`}
                >
                  {t.liveSaveToggle}
                </button>
              ) : null}
              {savedReachable ? (
                <Link data-live-saved-link="" href="/live/saved" className="text-[11px] text-amber-100/60 underline underline-offset-2">
                  {t.liveSavedLink}
                </Link>
              ) : null}
            </div>
            {/* Only before START: once it is running the feed needs the room. */}
            {autoOn && !running ? <p className="text-[11px] text-amber-100/50">{t.liveAutoVoiceHint}</p> : null}
            {saveStatus.allowed && !saveStatus.ready ? (
              <p data-live-save-hint="" className="text-[11px] text-amber-100/50">
                {t.liveSaveNotReady}
              </p>
            ) : saveUsable && saveOn ? (
              <p data-live-save-hint="" className="text-[11px] text-emerald-100/60">
                {t.liveSaveOnHint}
              </p>
            ) : null}
            {saveFailed > 0 ? (
              <p role="status" className="text-[11px] text-amber-200/80">
                {fill(t.liveSaveFailed, { count: saveFailed })}
              </p>
            ) : null}
            {/* Said plainly, never guessed around. */}
            {autoOn && (misses > 0 || echoes > 0) ? (
              <p data-live-auto-counts="" role="status" className="text-[11px] text-amber-200/80">
                {[
                  misses > 0 ? fill(t.liveAutoMisses, { count: misses }) : "",
                  echoes > 0 ? fill(t.liveAutoEchoes, { count: echoes }) : ""
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            ) : null}
          </div>
        ) : null}

        {/* On-device only: who is talking. Ambient AI hears the whole room. */}
        {engine === "device" ? (
          <div className="grid grid-cols-2 gap-2 rounded-2xl border border-white/10 bg-white/5 p-1">
            {(
              [
                ["theirs", `Them · Ellos (${theirs.toUpperCase()} → ${mine.toUpperCase()})`],
                ["mine", `Me · Yo (${mine.toUpperCase()} → ${theirs.toUpperCase()})`]
              ] as [Side, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => changeSide(key)}
                className={`rounded-xl px-3 py-2 text-sm font-medium transition ${
                  side === key ? "bg-amber-400 text-stone-950" : "text-amber-100/70"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}

        {/* Unsupported-browser notice (device engine only) */}
        {engine === "device" && !supported ? (
          <p className="rounded-2xl border border-amber-300/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
            On-device speech recognition isn&apos;t available in this browser — switch to Ambient AI,
            or use Chrome on desktop/Android.
          </p>
        ) : null}

        {/* Error banner */}
        {endingSoon ? (
          <p
            role="status"
            aria-live="polite"
            className="rounded-2xl border border-amber-300/40 bg-amber-300/10 px-4 py-3 text-sm text-amber-200"
          >
            {endingSoon.reason === "idle"
              ? `Quiet for a while — listening stops in about ${endingSoon.seconds}s to save money. Say anything to keep it going.`
              : `This session hits its 2-hour limit in about ${Math.round(endingSoon.seconds / 60)} min. Tap START again for a fresh one.`}
          </p>
        ) : null}

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
                aria-pressed={voiceShown && !readoutTextOnly}
                disabled={readoutTextOnly}
                title={readoutTextOnly ? TEXT_ONLY_TITLE : undefined}
                className={`rounded-full border px-3 py-1 text-[11px] normal-case tracking-normal transition ${
                  voiceShown && !readoutTextOnly
                    ? "border-emerald-300/40 bg-emerald-400/15 text-emerald-100"
                    : "border-white/10 bg-white/5 text-amber-100/70"
                }`}
              >
                {readoutTextOnly
                  ? "🔇 Text only"
                  : voiceShown
                    ? speakingConcept
                      ? "🔊 Voice · speaking"
                      : "🔊 Voice on"
                    : "🔇 Voice off"}
              </button>
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
            {/* Bounded and following its own tail (components/FollowTail.tsx),
                so a long summary keeps its live words in view while the page
                itself stays put. */}
            {draft ? (
              <div className="relative">
                <div
                  ref={draftTail.ref}
                  className="max-h-[40dvh] overflow-y-auto overscroll-contain rounded-3xl border border-emerald-300/30 bg-emerald-400/[0.06] p-5 [overflow-anchor:none]"
                >
                  <p className="text-pretty text-[clamp(1.5rem,6vw,2.2rem)] font-semibold leading-tight tracking-tight text-emerald-50">
                    {draft}
                    <span className="animate-pulse">▍</span>
                  </p>
                </div>
                <JumpToTail show={draftTail.detached} onJump={draftTail.jumpToTail} />
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
                {feed.map((entry) =>
                  entry.line ? (
                    // Two-way Auto: one card per line, both halves, each under
                    // the name of the language it is in — heard first, then
                    // what it became. The rendering is the large one (it is
                    // what the OTHER person reads); the heard half is big
                    // enough for the speaker to check they were heard right.
                    // A miss keeps its words and says the language is unknown.
                    <li
                      key={entry.id}
                      data-live-line=""
                      data-detect={entry.line.detect ?? ""}
                      className={`rounded-3xl border p-4 ${
                        entry.line.detect === "miss"
                          ? "border-dashed border-amber-300/40 bg-amber-400/[0.04]"
                          : "border-white/10 bg-[rgba(18,44,36,0.7)]"
                      }`}
                    >
                      <div className="mb-2 text-[10px] tracking-wider text-white/25">{formatTime(entry.at)}</div>
                      {entry.line.heard ? (
                        <div data-live-heard="" className="mb-3">
                          <span className="rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-wider text-amber-100/70">
                            {entry.line.heardLang ? languageNative(entry.line.heardLang as PairLangCode) : "?"}
                          </span>
                          <p
                            lang={entry.line.heardLang ?? undefined}
                            className="mt-1 text-pretty text-lg leading-snug text-amber-50/80"
                          >
                            {entry.line.heard}
                          </p>
                        </div>
                      ) : null}
                      <div data-live-rendered="">
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider ${
                            entry.line.textLang
                              ? "border-emerald-300/30 bg-emerald-400/10 text-emerald-100/80"
                              : "border-amber-300/40 bg-amber-400/10 text-amber-200"
                          }`}
                        >
                          {entry.line.textLang
                            ? languageNative(entry.line.textLang as PairLangCode)
                            : `? · ${t.liveAutoMissTag}`}
                        </span>
                        <p
                          lang={entry.line.textLang ?? undefined}
                          className="mt-1 text-pretty text-[clamp(1.35rem,5.5vw,2rem)] font-semibold leading-tight tracking-tight text-white"
                        >
                          {entry.line.text}
                        </p>
                      </div>
                    </li>
                  ) : entry.note ? (
                    <li
                      key={entry.id}
                      data-live-note=""
                      className="rounded-2xl border border-dashed border-amber-300/25 px-4 py-2 text-sm text-amber-100/60"
                    >
                      {entry.concept}
                    </li>
                  ) : (
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
                  )
                )}
              </ol>
            )}
          </div>
        </section>

        {/* Primary controls — pinned (Tom, 11/04). With a long feed, STOP and
            Clear used to live wherever the page ended, a full scroll away. The
            bar is `sticky bottom-0` and the LAST child of the scrolling column,
            so it rides the bottom edge of the viewport while the feed scrolls
            underneath it, and — being in flow, not `fixed` — it reserves its
            own height at the end of the page: nothing can end up hidden under
            it, whatever the bar's height is at the time (the idle caption
            comes and goes). It carries the safe-area inset itself so it sits
            flush on the home indicator, not over it. The green exit pill stays
            in the header. Reading order and the draft card's follow-the-tail
            (components/FollowTail.tsx) are untouched. */}
        <section
          data-live-controls=""
          className="sticky bottom-0 z-10 -mx-4 mt-auto bg-[#100d0b]/95 px-4 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-2 backdrop-blur-sm"
        >
          <div className="flex flex-col gap-3 rounded-3xl border border-white/10 bg-[rgba(20,16,14,0.86)] p-4">
            <div className="flex items-stretch gap-2">
              <button
                type="button"
                onClick={handlePrimary}
                disabled={engine === "device" && !supported}
                className={`flex h-20 flex-1 items-center justify-center gap-3 rounded-2xl text-xl font-semibold transition active:scale-[0.99] disabled:opacity-50 ${
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
              {feed.length > 0 ? (
                <button
                  type="button"
                  onClick={clearAll}
                  className="shrink-0 rounded-2xl border border-white/10 bg-white/5 px-4 text-sm text-amber-100/70"
                >
                  Clear
                </button>
              ) : null}
            </div>
            {engine === "ambient" && !running ? (
              <p className="text-center text-[11px] text-amber-100/40">
                Ambient AI streams audio to OpenAI while live — hears any language, any number of
                voices. Auto-stops after 5 quiet minutes.
              </p>
            ) : null}
          </div>
        </section>
      </div>

      <LanguageSheet
        open={sheetOpen}
        selected={theirs}
        paired={mine}
        caption="Around you · A tu alrededor"
        onSelect={selectLanguage}
        onClose={() => setSheetOpen(false)}
      />
    </main>
  );
}
