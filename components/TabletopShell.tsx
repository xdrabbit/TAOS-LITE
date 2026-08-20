"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { startTabletopLive, type ActiveTabletopLive } from "@/lib/tabletop/live";
import type { TabletopDirection } from "@/lib/tabletop/instructions";
import { fetchWithRetry } from "@/lib/net";
import { createWakeLockHold, type WakeLockHold } from "@/lib/wakeLock";
import { isTextOnlyLanguage, requestSpeech, TEXT_ONLY_TITLE } from "@/lib/tts/speech";
import { LanguagePillRow, LanguageSheet } from "./LanguagePicker";
import { TextOnlyNote } from "./TextOnly";
import { useLanguagePair } from "@/lib/translate/useLanguagePair";
import { languageNative } from "@/lib/languages/catalog";
// Two people, two languages: what one says is always spoken to the other,
// so a turn's target is the OTHER side of the pair — which is also the code
// the tier check reads before asking /api/tts for a voice.
import { otherInPair, type PairLangCode } from "@/lib/translate/pair";
import { authHeaders } from "@/lib/authClient";

// ── /tabletop: the phone lies flat between two people ───────────────────────
// Party mode. One phone on the table: the TOP half renders rotated 180° so it
// reads right-side-up for the person across the table; the BOTTOM half faces
// the phone's owner. Each end is one side of the shared language pair, and
// either end can be any of the hundred (swappable, and re-pickable from the
// pill row in the middle bar).
// Turn-taking is explicit, chess-style: TAP to start talking, TAP again when
// done. Two engines:
//  • "live" (default) — a persistent GA Realtime session translates the turn
//    AS THE PERSON SPEAKS: text streams onto the listener's pane phrase by
//    phrase (lib/tabletop/live.ts), and the whole turn is spoken aloud via
//    /api/tts when the turn ends.
//  • "classic" — the proven batch path: record the turn, then one
//    /api/translate round-trip. Fallback for flaky rooms.

// The table's two ends are the shared pair (lib/translate/pair.ts): `mine` is
// the phone's owner, at the bottom, and `theirs` is whoever is across the
// table, at the rotated top. Before 8/18 this was a two-value union and the
// far end could only ever be a Spanish speaker — on the one screen whose
// whole purpose is handing your phone to a stranger.
type Lang = PairLangCode;
type Engine = "live" | "classic";
type TurnState =
  | { kind: "idle" }
  | { kind: "connecting"; side: Lang }
  | { kind: "recording"; side: Lang }
  | { kind: "processing"; side: Lang };


interface Exchange {
  /** Language the speaker used. */
  from: Lang;
  original: string;
  translation: string;
  at: number;
}

const MAX_TURN_SEC_CLASSIC = 60;
const MAX_TURN_SEC_LIVE = 120;

// Button and status copy for the panes. Two entries, not a hundred: a
// language without one gets English chrome and a faithful translation in its
// own language, which is the same trade /translate makes (see the note in
// ENHANCEMENTS.md) and the only reason the catalog could grow past six. The
// pane's HEADING is not in here — that is the language's own name, from the
// catalog, for all hundred of them.
const L: Record<
  string,
  {
    tapToTalk: string;
    tapDone: string;
    listening: string;
    translating: string;
    connecting: string;
    theySaid: string;
    youSaid: string;
    idleHint: string;
  }
> = {
  en: {
    tapToTalk: "TAP TO TALK",
    tapDone: "TAP WHEN DONE",
    listening: "Listening to the other side…",
    translating: "Translating…",
    connecting: "Connecting…",
    theySaid: "They said",
    youSaid: "You said",
    idleHint: "Lay the phone flat between you"
  },
  es: {
    tapToTalk: "TOCA PARA HABLAR",
    tapDone: "TOCA AL TERMINAR",
    listening: "Escuchando al otro lado…",
    translating: "Traduciendo…",
    connecting: "Conectando…",
    theySaid: "Dijo",
    youSaid: "Dijiste",
    idleHint: "Pon el teléfono entre ustedes"
  }
};

function copyFor(code: Lang): (typeof L)[string] {
  return L[code] ?? L.en;
}

function pickRecordingMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

export function TabletopShell(): JSX.Element {
  // The pair IS the table (lib/translate/useLanguagePair.ts): `theirs` faces
  // the rotated TOP end, `mine` faces the phone's owner at the bottom. It is
  // the same pair /translate and /live hold, so a phone already set to
  // EN⇄Italian is a working tabletop the moment it is laid down.
  const {
    pair,
    mine,
    theirs,
    pills,
    sheetOpen,
    setSheetOpen,
    selectLanguage: selectTableLanguage
  } = useLanguagePair({
    // Whatever was streaming was in a language that just left the table —
    // clear it. The realtime SESSION is kept: beginTurn sends the direction
    // through session.update on every single turn anyway, so the connection
    // is still good and dropping it would cost the next tapper a reconnect
    // in the middle of a party.
    onPairChange: () => {
      setLiveHeard("");
      setLiveTranslation("");
    }
  });
  const topLang = theirs;
  const bottomLang = mine;
  const [engine, setEngine] = useState<Engine>("live");
  const [turn, setTurn] = useState<TurnState>({ kind: "idle" });
  const [voiceOn, setVoiceOn] = useState(true);
  const [recordSec, setRecordSec] = useState(0);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  // Live-engine streaming text for the CURRENT turn.
  const [liveHeard, setLiveHeard] = useState("");
  const [liveTranslation, setLiveTranslation] = useState("");
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);
  const playerRef = useRef<HTMLAudioElement | null>(null);
  const wakeHoldRef = useRef<WakeLockHold | null>(null);
  const voiceOnRef = useRef(true);
  const liveRef = useRef<ActiveTabletopLive | null>(null);
  const turnRef = useRef<TurnState>({ kind: "idle" });

  useEffect(() => {
    turnRef.current = turn;
  }, [turn]);

  useEffect(() => {
    voiceOnRef.current = voiceOn;
    if (!voiceOn) {
      playerRef.current?.pause();
      playerRef.current = null;
    }
  }, [voiceOn]);

  // Wake lock while the page is open — a tabletop session dies if the screen
  // sleeps. Shared holder (lib/wakeLock.ts) re-acquires on the sentinel's
  // "release" event too: iOS drops the lock WITHOUT a visibilitychange under
  // Low Power Mode / pressure (8/2 field report on /translate; same pattern
  // here). Each turn tap re-asserts it inside the gesture.
  useEffect(() => {
    const hold = createWakeLockHold(() => true);
    wakeHoldRef.current = hold;
    hold.ensure();
    return () => {
      wakeHoldRef.current = null;
      hold.stop();
    };
  }, []);

  // Same guard the "swap ends" button carries: the pair decides what the
  // open turn is being translated INTO, so moving it mid-turn would land the
  // words on the wrong end of the table. Between turns it is free.
  const selectLanguage = useCallback(
    (code: PairLangCode) => {
      if (turnRef.current.kind !== "idle") return;
      selectTableLanguage(code);
    },
    [selectTableLanguage]
  );

  const startTimer = useCallback((capSec: number) => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    setRecordSec(0);
    timerRef.current = window.setInterval(() => {
      setRecordSec((s) => s + 1);
    }, 1000);
    void capSec; // cap handled by the effect below so it sees fresh state
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    setRecordSec(0);
  }, []);

  const cleanupRecording = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
    stopTimer();
  }, [stopTimer]);

  useEffect(() => {
    return () => {
      cleanupRecording();
      liveRef.current?.stop();
      liveRef.current = null;
    };
  }, [cleanupRecording]);

  const speak = useCallback(async (ex: Exchange, pairNow: readonly [Lang, Lang]) => {
    if (!voiceOnRef.current || !ex.translation) return;
    try {
      // requestSpeech asks the catalog first: a tier-2 target never reaches
      // /api/tts, and a null here (either tier gate) means the translation on
      // the table is the whole answer. The turn is already on screen and the
      // streaming path above is untouched — only the readout stops.
      const blob = await requestSpeech(
        {
          text: ex.translation,
          sourceLanguage: ex.from,
          targetLanguage: otherInPair(pairNow, ex.from)
          // No voice override: the shared /api/tts voice-follows-speaker rule
          // applies (Liz's Spanish -> English in Liz's clone, Tom's English ->
          // Spanish in Tom's clone) — identical on every screen.
        },
        { fetch: (input, init) => fetchWithRetry(input, init, { retries: 1, timeoutMs: 30000 }) }
      );
      if (!blob) return;
      const url = URL.createObjectURL(blob);
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

  // The pair the turn was TAKEN in travels with it: the readout must be
  // spoken in the language the table was set to when the words were said,
  // even if someone taps a pill while the audio is being fetched.
  const pushExchange = useCallback(
    (ex: Exchange, pairNow: readonly [Lang, Lang]) => {
      setExchanges((prev) => [...prev.slice(-19), ex]);
      void speak(ex, pairNow);
    },
    [speak]
  );

  // ── Live engine ───────────────────────────────────────────────────────────

  const startLiveTurn = useCallback(
    async (side: Lang) => {
      setError(null);
      playerRef.current?.pause();
      playerRef.current = null;
      setLiveHeard("");
      setLiveTranslation("");
      // Whoever tapped is the source; the other end of the table is the
      // target. Both are catalog codes — the direction string that used to
      // live here could only spell two of them.
      const direction: TabletopDirection = { source: side, target: otherInPair(pair, side) };
      try {
        if (!liveRef.current) {
          setTurn({ kind: "connecting", side });
          liveRef.current = await startTabletopLive(
            {
              onError: (msg) => setError(msg),
              onState: (s) => {
                // The session auto-disconnects after long idle; reflect nothing
                // in the UI unless a turn is active (next tap reconnects).
                if (s === "idle") liveRef.current = null;
              },
              onHeard: (text) => setLiveHeard(text),
              onTranslationDelta: (d) => setLiveTranslation((t) => t + d)
            },
            direction
          );
        }
        if (!liveRef.current.beginTurn(direction)) {
          // Session went stale (e.g. idle disconnect raced us) — drop it so
          // the next tap reconnects fresh.
          liveRef.current.stop();
          liveRef.current = null;
          setTurn({ kind: "idle" });
          return;
        }
        setTurn({ kind: "recording", side });
        startTimer(MAX_TURN_SEC_LIVE);
      } catch {
        liveRef.current = null;
        setTurn({ kind: "idle" });
        stopTimer();
        setError((prev) => prev ?? "Live mode failed — try classic mode.");
      }
    },
    [pair, startTimer, stopTimer]
  );

  const endLiveTurn = useCallback(
    async (side: Lang) => {
      const session = liveRef.current;
      if (!session) {
        setTurn({ kind: "idle" });
        return;
      }
      setTurn({ kind: "processing", side });
      stopTimer();
      try {
        const result = await session.endTurn();
        if (result.translation || result.heard) {
          pushExchange(
            {
              from: side,
              original: result.heard,
              translation: result.translation,
              at: Date.now()
            },
            pair
          );
        }
      } finally {
        setLiveHeard("");
        setLiveTranslation("");
        setTurn({ kind: "idle" });
      }
    },
    [pair, stopTimer, pushExchange]
  );

  // ── Classic engine (batch /api/translate) ─────────────────────────────────

  const finishClassicTurn = useCallback(
    async (side: Lang, blob: Blob) => {
      setTurn({ kind: "processing", side });
      try {
        const form = new FormData();
        form.append("audio", new File([blob], "turn", { type: blob.type || "audio/webm" }));
        form.append("sourceLanguage", side);
        form.append("targetLanguage", otherInPair(pair, side));
        form.append("tone", "casual");
        const res = await fetch("/api/translate", {
          method: "POST",
          headers: await authHeaders(),
          body: form
        });
        const payload = (await res.json().catch(() => ({}))) as {
          original?: string;
          translation?: string;
          error?: string;
        };
        if (!res.ok || !payload.translation) {
          throw new Error(payload.error || "Translation failed. Try again.");
        }
        setError(null);
        pushExchange(
          {
            from: side,
            original: payload.original ?? "",
            translation: payload.translation,
            at: Date.now()
          },
          pair
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "Translation failed. Try again.");
      } finally {
        setTurn({ kind: "idle" });
      }
    },
    [pair, pushExchange]
  );

  const startClassicTurn = useCallback(
    async (side: Lang) => {
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
        const startedAt = performance.now();

        recorder.ondataavailable = (ev) => {
          if (ev.data.size > 0) chunksRef.current.push(ev.data);
        };
        // iOS Safari ends the mic track SILENTLY on audio-session interruption
        // (incoming call, Siri, another app). Route both failure paths through
        // the normal stop so the turn finishes with what was captured instead
        // of dying with the pane lit (same fix as TranslatorShell, 7/27).
        recorder.onerror = () => {
          if (recorder.state !== "inactive") recorder.stop();
        };
        for (const track of stream.getAudioTracks()) {
          track.onended = () => {
            if (recorder.state !== "inactive") recorder.stop();
          };
        }
        recorder.onstop = () => {
          const chunks = chunksRef.current;
          const type = recorder.mimeType || mime || "audio/webm";
          const cancelled = cancelledRef.current;
          cleanupRecording();
          // A sub-second turn is an accidental double-tap: the clip has no
          // usable speech (the shortest ones get rejected upstream as
          // corrupted), so drop it quietly instead of erroring at the party.
          if (cancelled || !chunks.length || performance.now() - startedAt < 600) {
            setTurn({ kind: "idle" });
            return;
          }
          void finishClassicTurn(side, new Blob(chunks, { type }));
        };

        recorder.start(250);
        setTurn({ kind: "recording", side });
        startTimer(MAX_TURN_SEC_CLASSIC);
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
    [cleanupRecording, finishClassicTurn, startTimer]
  );

  // Turn caps, engine-appropriate.
  useEffect(() => {
    if (turn.kind !== "recording") return;
    const cap = engine === "live" ? MAX_TURN_SEC_LIVE : MAX_TURN_SEC_CLASSIC;
    if (recordSec < cap) return;
    if (engine === "live") void endLiveTurn(turn.side);
    else recorderRef.current?.stop();
  }, [recordSec, turn, engine, endLiveTurn]);

  const tap = useCallback(
    (side: Lang) => {
      // Re-assert the wake lock inside the tap gesture (see the mount effect).
      wakeHoldRef.current?.ensure();
      const t = turnRef.current;
      if (t.kind === "idle") {
        if (engine === "live") void startLiveTurn(side);
        else void startClassicTurn(side);
      } else if (t.kind === "recording" && t.side === side) {
        if (engine === "live") void endLiveTurn(side);
        else {
          cancelledRef.current = false;
          recorderRef.current?.stop();
        }
      }
    },
    [engine, startLiveTurn, startClassicTurn, endLiveTurn]
  );

  const switchEngine = useCallback(() => {
    if (turnRef.current.kind !== "idle") return;
    setEngine((e) => {
      if (e === "live") {
        liveRef.current?.stop();
        liveRef.current = null;
        return "classic";
      }
      return "live";
    });
  }, []);

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
    const t = copyFor(lang);
    // This pane READS the other end's turns, so it is this pane's own
    // language that /api/tts would be asked for. Tier 2 (catalog) means the
    // words still cross the table — they just arrive silently, and the pane
    // says so instead of leaving someone waiting on audio.
    const paneTextOnly = isTextOnlyLanguage(lang);
    const { theirs, mine } = paneLines(lang);
    const isConnecting = turn.kind === "connecting" && turn.side === lang;
    const isRecording = turn.kind === "recording" && turn.side === lang;
    const isProcessing = turn.kind === "processing" && turn.side === lang;
    const otherBusy = turn.kind !== "idle" && turn.side !== lang;
    // Live streaming: while the OTHER side talks, this pane streams the
    // translation as it is generated.
    const streamingIn = engine === "live" && otherBusy && liveTranslation;
    const cap = engine === "live" ? MAX_TURN_SEC_LIVE : MAX_TURN_SEC_CLASSIC;

    return (
      <section
        className={`flex flex-1 flex-col gap-2 overflow-hidden p-4 ${rotated ? "rotate-180" : ""}`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs uppercase tracking-[0.25em] text-amber-100/50">
            {languageNative(lang)}
          </span>
          {paneTextOnly && !isRecording ? (
            <TextOnlyNote className="border border-white/10 bg-white/5 px-2 py-0.5 text-amber-100/60" />
          ) : null}
          {isRecording ? (
            <span className="flex items-center gap-2 text-xs text-red-300">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-400" />
              {recordSec}s / {cap}s
            </span>
          ) : null}
        </div>

        {/* What the other person said (or is saying), in MY language. */}
        <div className="flex-1 overflow-y-auto">
          {streamingIn ? (
            <>
              <div className="text-[11px] uppercase tracking-widest text-emerald-300/70">
                {t.theySaid} · live
              </div>
              <div className="mt-1 text-2xl font-medium leading-snug text-amber-50">
                {liveTranslation}
                <span className="animate-pulse text-emerald-300">▍</span>
              </div>
            </>
          ) : theirs ? (
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
          {isRecording && engine === "live" && liveHeard ? (
            <div className="mt-3 border-t border-white/10 pt-2">
              <div className="text-[11px] uppercase tracking-widest text-amber-100/30">
                {t.youSaid}
              </div>
              <div className="text-sm text-amber-100/60">{liveHeard}</div>
            </div>
          ) : !streamingIn && mine ? (
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
          disabled={otherBusy || isProcessing || isConnecting}
          className={`rounded-2xl px-4 py-5 text-lg font-bold tracking-wide transition ${
            isRecording
              ? "animate-pulse bg-red-500 text-stone-50"
              : isProcessing || isConnecting
                ? "bg-white/10 text-amber-100/60"
                : otherBusy
                  ? "bg-white/5 text-amber-100/30"
                  : "bg-emerald-400 text-stone-950"
          }`}
        >
          {isConnecting
            ? t.connecting
            : isRecording
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

  // Neither end of the table can be read out — both are tier 2
  // (lib/languages/catalog.ts). The turns still cross the table as text; the
  // voice toggle just stops offering something there is no voice for. When
  // only ONE end is tier 2 the toggle stays live and that pane carries its own
  // "text only" mark, because half the table still gets a voice.
  const tableTextOnly = isTextOnlyLanguage(topLang) && isTextOnlyLanguage(bottomLang);

  return (
    <main className="flex h-[100dvh] flex-col overflow-hidden">
      {renderPane(topLang, true)}

      {/* Middle bar — readable from the bottom end (the phone owner), which
          is also whose taps it takes. The pill row is the same one /translate
          and /live draw (components/LanguagePicker.tsx): the solid pill is the
          FAR end of the table, the outlined one is this end, and tapping your
          own swaps which way round the two of you are sitting. */}
      <div className="flex flex-col gap-1.5 border-y border-white/10 bg-white/5 px-3 py-1.5">
        <LanguagePillRow
          pills={pills}
          selected={theirs}
          paired={mine}
          sheetOpen={sheetOpen}
          onSelect={selectLanguage}
          onOpenSheet={() => setSheetOpen(true)}
        />
        <div className="flex items-center justify-center gap-2">
        <a href="/" className="rounded-full px-2 py-1 text-xs text-amber-100/50">
          ← TAOS
        </a>
        <button
          type="button"
          onClick={() => selectLanguage(mine)}
          disabled={turn.kind !== "idle"}
          title="Swap which end of the table is which"
          className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-amber-100/70 disabled:opacity-40"
        >
          ⇅ swap ends
        </button>
        <button
          type="button"
          onClick={switchEngine}
          disabled={turn.kind !== "idle"}
          className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-amber-100/70 disabled:opacity-40"
        >
          {engine === "live" ? "⚡ live" : "📼 classic"}
        </button>
        <button
          type="button"
          onClick={() => setVoiceOn((v) => !v)}
          disabled={tableTextOnly}
          title={tableTextOnly ? TEXT_ONLY_TITLE : undefined}
          className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-amber-100/70 disabled:opacity-40"
        >
          {tableTextOnly ? "🔇 text only" : voiceOn ? "🔊 voice on" : "🔇 voice off"}
        </button>
        {error ? <span className="max-w-[40%] truncate text-xs text-red-300">{error}</span> : null}
        </div>
      </div>

      {renderPane(bottomLang, false)}

      <LanguageSheet
        open={sheetOpen}
        selected={theirs}
        paired={mine}
        pairedLabel="Your end"
        caption="The far end of the table · El otro lado"
        onSelect={selectLanguage}
        onClose={() => setSheetOpen(false)}
      />
    </main>
  );
}
