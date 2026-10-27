"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TabletopLiveState } from "@/lib/tabletop/live";
import {
  autoBrain,
  BRAIN_STORAGE_KEY,
  resolveBrain,
  TABLETOP_BRAINS,
  type ActiveTabletopBrain,
  type StartTabletopBrain,
  type TabletopBrainKind
} from "@/lib/tabletop/brain";
import { startOpenAIBrain } from "@/lib/tabletop/openaiBrain";
import { startGeminiBrain } from "@/lib/tabletop/geminiBrain";
import { ensureTabletopAudioContext } from "@/lib/tabletop/audio";
import {
  addSegment,
  emptyTally,
  summarize,
  type TabletopSessionSummary,
  type TabletopSessionTally
} from "@/lib/tabletop/metrics";
import { isFounder, tabletopAutoVisibleTo } from "@/lib/release";
import { createTagStream, type TagVerdict } from "@/lib/tabletop/autoDetect";
import { supabase } from "@/lib/supabase";
import type { TabletopDirection } from "@/lib/tabletop/instructions";
import { fetchWithRetry } from "@/lib/net";
import { holdWake, keepWake } from "@/lib/wakeLock";
import { isTextOnlyLanguage, requestSpeech, TEXT_ONLY_TITLE } from "@/lib/tts/speech";
import { LanguagePillRow, LanguageSheet } from "./LanguagePicker";
import { TextOnlyNote } from "./TextOnly";
import { useLanguagePair } from "@/lib/translate/useLanguagePair";
import { languageNative } from "@/lib/languages/catalog";
// Two people, two languages: what one says is always spoken to the other,
// so a turn's target is the OTHER side of the pair — which is also the code
// the tier check reads before asking /api/tts for a voice.
import { otherInPair, type PairLangCode } from "@/lib/translate/pair";
import { authHeaders, jsonAuthHeaders } from "@/lib/authClient";
import { copyFor } from "@/lib/chrome/copy";
import { JumpToTail, useFollowTail, type FollowTail } from "./FollowTail";
import { ExitHome } from "./ExitHome";

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
// `auto`: an auto-detect turn (founders, TAOS_TABLETOP_AUTO_ENABLED). Its
// `side` is not who tapped — nobody did — but who the last phrase's language
// tag says is speaking, so it moves as the two people take turns and every
// pane rule below that reads `turn.side` follows it for free.
type TurnState =
  | { kind: "idle" }
  | { kind: "connecting"; side: Lang; auto?: boolean }
  | { kind: "recording"; side: Lang; auto?: boolean }
  | { kind: "processing"; side: Lang; auto?: boolean };

interface Exchange {
  /** Language the speaker used. */
  from: Lang;
  original: string;
  translation: string;
  at: number;
  /** Auto-detect only: the language it was translated INTO, per the tag. */
  to?: Lang;
  /**
   * Auto-detect only. "miss" = at least one phrase in it came back without a
   * usable language tag, so its direction is the last one known, not a
   * detected one (lib/tabletop/autoDetect.ts).
   */
  detect?: "hit" | "miss";
}

/** One open auto-detect turn: the tag reader and the run being written. */
interface AutoTurn {
  pair: readonly [Lang, Lang];
  /** This response's tag reader; null between responses. */
  stream: ReturnType<typeof createTagStream> | null;
  /** True until this response has written its first visible character. */
  segFresh: boolean;
  /** Consecutive phrases from the same speaker — one exchange when it ends. */
  run: { source: Lang; text: string; miss: boolean } | null;
  /** The turn's running "heard" transcript, and how much of it is used up. */
  heardAll: string;
  heardUsed: number;
  /** Exchanges this turn has closed, in order — read out at turn end. */
  closed: Exchange[];
}

const MAX_TURN_SEC_CLASSIC = 60;
const MAX_TURN_SEC_LIVE = 120;

// Button and status copy for the panes lives in lib/chrome/copy.ts now,
// shared with the home screen and /call. It used to be a two-language table
// right here — a cut-down twin of the home screen's, which is how the two
// drifted. Two entries or a hundred, the rule is the same: a language without
// one gets English chrome and a faithful translation in its own language,
// which is the same trade /translate makes (see the note in ENHANCEMENTS.md)
// and the only reason the catalog could grow past six.
//
// The pane's HEADING is not in that table either — that is the language's own
// name, from the catalog, for all hundred of them.
//
// `tableListening` is the one key with a name of its own: this pane's
// listening line names the OTHER SIDE ("Listening to the other side…"), which
// the home screen's plain "Listening…" would get wrong.

// ── The brain A/B (Tom, 2026-10-21), founders only ─────────────────────────
// Which realtime brain the live engine runs on (lib/tabletop/brain.ts). A
// founder sees two chips and a one-line card with the last session's numbers;
// everyone else sees nothing new and is locked to openai.
const BRAIN_STARTERS: Record<TabletopBrainKind, StartTabletopBrain> = {
  openai: startOpenAIBrain,
  gemini: startGeminiBrain
};
const BRAIN_LABEL: Record<TabletopBrainKind, string> = { openai: "OpenAI", gemini: "Gemini" };
const LAST_SESSION_KEY = "taos.tabletop.lastSession";

function readLastSession(): TabletopSessionSummary | null {
  try {
    const raw = window.localStorage.getItem(LAST_SESSION_KEY);
    return raw ? (JSON.parse(raw) as TabletopSessionSummary) : null;
  } catch {
    return null;
  }
}

/** One brain session's numbers, collected until the brain goes idle. */
interface MeteredSession {
  tally: TabletopSessionTally;
  finished: boolean;
}

function pickRecordingMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

export function TabletopShell({
  defaultBrain = "openai",
  autoEnabled = false
}: {
  /** TAOS_TABLETOP_BRAIN, read on the server. Founders only; see brain.ts. */
  defaultBrain?: TabletopBrainKind;
  /**
   * TAOS_TABLETOP_AUTO_ENABLED, read on the server. The auto-detect toggle
   * shows only when this is true AND the user is a founder (lib/release.ts).
   */
  autoEnabled?: boolean;
} = {}): JSX.Element {
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
  const voiceOnRef = useRef(true);
  const liveRef = useRef<ActiveTabletopBrain | null>(null);
  // ── Brain A/B state (founders only) ──
  const [founder, setFounder] = useState(false);
  const [brain, setBrain] = useState<TabletopBrainKind>("openai");
  const [brainLive, setBrainLive] = useState(false);
  const [lastSession, setLastSession] = useState<TabletopSessionSummary | null>(null);
  const meteredRef = useRef<MeteredSession | null>(null);
  const turnRef = useRef<TurnState>({ kind: "idle" });
  // ── Auto-detect state (founders + TAOS_TABLETOP_AUTO_ENABLED) ──
  const [autoAllowed, setAutoAllowed] = useState(false);
  // ON by default whenever it is visible at all — the point is not tapping.
  const [autoOn, setAutoOn] = useState(true);
  const autoRef = useRef<AutoTurn | null>(null);
  // Who spoke last, per the last tag that hit. A miss lands on this side's
  // direction rather than a guess. Starts on the phone's owner.
  const lastSourceRef = useRef<Lang | null>(null);
  // Bumped by every new turn so an old turn's readout queue stops cleanly.
  const speakGenRef = useRef(0);
  const autoActive = autoAllowed && autoOn && engine === "live";
  // Auto-detect always runs on openai — see autoBrain in lib/tabletop/brain.ts.
  const { brain: runBrain, autoFellBack } = autoBrain(brain, autoActive);

  useEffect(() => {
    turnRef.current = turn;
  }, [turn]);

  // Who is holding the phone decides whether the brain is a choice at all.
  // A non-founder never leaves "openai" — resolveBrain refuses them anything
  // else — and never gets the chips or the card.
  useEffect(() => {
    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      const isF = isFounder(data.session?.user?.email);
      setFounder(isF);
      let stored: string | null = null;
      try {
        stored = window.localStorage.getItem(BRAIN_STORAGE_KEY);
      } catch {
        /* private mode */
      }
      setBrain(resolveBrain({ founder: isF, stored, envDefault: defaultBrain }));
      setAutoAllowed(tabletopAutoVisibleTo(data.session?.user?.email, autoEnabled));
      if (isF) setLastSession(readLastSession());
    });
    return () => {
      active = false;
    };
  }, [defaultBrain, autoEnabled]);

  // A brain session ended (idle, cap, failure, the end chip, leaving): its
  // numbers become the card, and — founders only — one [taos-tabletop] line
  // in the Vercel log. Numbers only; no transcript goes anywhere.
  const finishMetered = useCallback(
    (m: MeteredSession) => {
      if (m.finished) return;
      m.finished = true;
      if (meteredRef.current === m) meteredRef.current = null;
      setBrainLive(false);
      if (!founder) return;
      const summary = summarize(m.tally, Date.now());
      setLastSession(summary);
      try {
        window.localStorage.setItem(LAST_SESSION_KEY, JSON.stringify(summary));
      } catch {
        /* the log line still goes */
      }
      void jsonAuthHeaders()
        .then((headers) =>
          fetch("/api/tabletop/metrics", {
            method: "POST",
            headers,
            body: JSON.stringify(summary),
            keepalive: true
          })
        )
        .catch(() => {
          /* the card has it */
        });
    },
    [founder]
  );

  useEffect(() => {
    voiceOnRef.current = voiceOn;
    if (!voiceOn) {
      playerRef.current?.pause();
      playerRef.current = null;
    }
  }, [voiceOn]);

  // Wake lock for the duration of a TURN, not of the page. It used to be taken
  // at mount and wanted forever, which is how a tabletop left open overnight
  // held a phone awake (9/6). lib/wakeLock.ts keeps it through a 60s grace, so
  // the gap between one person finishing and the other tapping is covered.
  useEffect(() => {
    if (turn.kind === "idle") return;
    return keepWake("tabletop-turn");
  }, [turn.kind]);

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

  const speak = useCallback(async (ex: Exchange, pairNow: readonly [Lang, Lang], untilEnded = false) => {
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
          targetLanguage: ex.to ?? otherInPair(pairNow, ex.from)
          // No voice override: the shared /api/tts voice-follows-speaker rule
          // applies (Liz's Spanish -> English in Liz's clone, Tom's English ->
          // Spanish in Tom's clone) — identical on every screen.
        },
        {
          fetch: (input, init) => fetchWithRetry(input, init, { retries: 1, timeoutMs: 30000 }),
          surface: "tabletop"
        }
      );
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      playerRef.current?.pause();
      const el = new Audio(url);
      playerRef.current = el;
      const ended = new Promise<void>((resolve) => {
        el.onended = () => {
          URL.revokeObjectURL(url);
          if (playerRef.current === el) playerRef.current = null;
          resolve();
        };
        // A new turn, the voice toggle, or the next readout pauses it.
        el.onpause = () => resolve();
      });
      await el.play();
      if (untilEnded) await ended;
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

  // An auto turn can close several exchanges — Liz, then Tom, then Liz — and
  // each is read in its own speaker's clone, one after the other. Only at
  // turn end, with the mic muted, exactly like a tapped turn: a readout while
  // the mic is open would be heard and translated back.
  const speakInOrder = useCallback(
    async (list: Exchange[], pairNow: readonly [Lang, Lang]) => {
      const gen = speakGenRef.current;
      for (const ex of list) {
        if (speakGenRef.current !== gen) return;
        await speak(ex, pairNow, true);
      }
    },
    [speak]
  );

  // ── Auto-detect: tags → panes ─────────────────────────────────────────────
  // All of this runs from brain events bound when the session was minted, so
  // it reads the open turn from autoRef, never from render state.

  /** Close the run being written as one exchange (on screen now, spoken later). */
  const closeAutoRun = useCallback((a: AutoTurn) => {
    const run = a.run;
    a.run = null;
    setLiveTranslation("");
    if (!run || !run.text.trim()) return;
    const ex: Exchange = {
      from: run.source,
      to: otherInPair(a.pair, run.source),
      original: a.heardAll.slice(a.heardUsed).trim(),
      translation: run.text.trim(),
      at: Date.now(),
      detect: run.miss ? "miss" : "hit"
    };
    a.heardUsed = a.heardAll.length;
    setLiveHeard("");
    a.closed.push(ex);
    setExchanges((prev) => [...prev.slice(-19), ex]);
  }, []);

  const applyAutoText = useCallback(
    (text: string, verdict: TagVerdict | undefined) => {
      const a = autoRef.current;
      if (!a) return;
      if (verdict) {
        let source: Lang;
        if (verdict.kind === "hit") {
          // The tag names what was WRITTEN; the speaker is the other end.
          source = otherInPair(a.pair, verdict.code as Lang);
          lastSourceRef.current = source;
        } else {
          // Don't guess. Last known direction, marked, counted.
          const last = lastSourceRef.current;
          source = last && a.pair.includes(last) ? last : a.pair[0];
          const m = meteredRef.current;
          if (m) m.tally = { ...m.tally, detectMiss: m.tally.detectMiss + 1 };
        }
        if (a.run && a.run.source !== source) closeAutoRun(a);
        if (!a.run) a.run = { source, text: "", miss: false };
        if (verdict.kind === "miss") a.run.miss = true;
        setTurn((t) => (t.kind !== "idle" && t.auto && t.side !== source ? { ...t, side: source } : t));
      }
      if (!text || !a.run) return;
      let piece = text;
      if (a.segFresh) {
        piece = piece.replace(/^\s+/, "");
        if (!piece) return;
        // Phrases arrive back to back; keep the run readable.
        if (a.run.text) piece = ` ${piece}`;
        a.segFresh = false;
      }
      a.run.text += piece;
      setLiveTranslation(a.run.text);
    },
    [closeAutoRun]
  );


  // ── Live engine ───────────────────────────────────────────────────────────

  const startLiveTurn = useCallback(
    async (side: Lang, auto = false) => {
      setError(null);
      speakGenRef.current += 1;
      playerRef.current?.pause();
      playerRef.current = null;
      setLiveHeard("");
      setLiveTranslation("");
      // Whoever tapped is the source; the other end of the table is the
      // target. Both are catalog codes — the direction string that used to
      // live here could only spell two of them. (An auto turn passes the last
      // known speaker; its prompt names both languages and ignores this.)
      const direction: TabletopDirection = { source: side, target: otherInPair(pair, side) };
      autoRef.current = auto
        ? { pair, stream: null, segFresh: true, run: null, heardAll: "", heardUsed: 0, closed: [] }
        : null;
      try {
        // Auto-detect moved the table onto a different brain than the open
        // session's (a founder on Gemini) — close it so this turn mints one.
        if (liveRef.current && liveRef.current.kind !== runBrain) {
          liveRef.current.stop();
          liveRef.current = null;
        }
        if (!liveRef.current) {
          setTurn({ kind: "connecting", side, auto });
          if (autoFellBack) {
            console.info(
              `[taos-tabletop] auto-detect: brain ${brain} -> openai ` +
                "(Gemini Live Translate takes one locked target language and cannot tag its output)"
            );
          }
          const m: MeteredSession = { tally: emptyTally(runBrain, Date.now()), finished: false };
          meteredRef.current = m;
          setBrainLive(true);
          liveRef.current = await BRAIN_STARTERS[runBrain](
            {
              onError: (msg) => {
                m.tally = { ...m.tally, errors: m.tally.errors + 1 };
                setError(msg);
              },
              onState: (s: TabletopLiveState) => {
                // The session auto-disconnects after long idle; reflect nothing
                // in the UI unless a turn is active (next tap reconnects).
                if (s === "idle") {
                  liveRef.current = null;
                  finishMetered(m);
                }
              },
              onHeard: (text) => {
                const a = autoRef.current;
                if (!a) {
                  setLiveHeard(text);
                  return;
                }
                a.heardAll = text;
                setLiveHeard(text.slice(a.heardUsed).trim());
              },
              onPartial: (d) => {
                const a = autoRef.current;
                if (!a) {
                  setLiveTranslation((t) => t + d);
                  return;
                }
                a.stream ??= createTagStream(a.pair);
                const r = a.stream.push(d);
                applyAutoText(r.text, r.verdict);
              },
              onSegmentStart: () => {
                const a = autoRef.current;
                if (!a) return;
                a.stream = createTagStream(a.pair);
                a.segFresh = true;
              },
              onSegmentEnd: () => {
                const a = autoRef.current;
                if (!a?.stream) return;
                const r = a.stream.end();
                a.stream = null;
                applyAutoText(r.text, r.verdict);
              },
              onSegmentDone: (_text, meta) => {
                if (meta) m.tally = addSegment(m.tally, meta);
              },
              onReconnect: () => {
                m.tally = { ...m.tally, reconnects: m.tally.reconnects + 1 };
              },
              onSpend: (usd) => {
                m.tally = { ...m.tally, estUsd: usd };
              }
            },
            direction,
            { auto: autoActive }
          );
        }
        if (auto && meteredRef.current && !meteredRef.current.tally.auto) {
          meteredRef.current.tally = { ...meteredRef.current.tally, auto: true };
        }
        if (!liveRef.current.beginTurn(direction, auto ? { a: pair[0], b: pair[1] } : undefined)) {
          // Session went stale (e.g. idle disconnect raced us) — drop it so
          // the next tap reconnects fresh.
          liveRef.current.stop();
          liveRef.current = null;
          autoRef.current = null;
          setTurn({ kind: "idle" });
          return;
        }
        setTurn({ kind: "recording", side, auto });
        startTimer(MAX_TURN_SEC_LIVE);
      } catch {
        liveRef.current = null;
        autoRef.current = null;
        setTurn({ kind: "idle" });
        stopTimer();
        setError((prev) => prev ?? "Live mode failed — try classic mode.");
      }
    },
    [pair, brain, runBrain, autoFellBack, autoActive, applyAutoText, finishMetered, startTimer, stopTimer]
  );

  const endLiveTurn = useCallback(
    async (side: Lang) => {
      const session = liveRef.current;
      if (!session) {
        setTurn({ kind: "idle" });
        return;
      }
      const a = autoRef.current;
      setTurn({ kind: "processing", side, auto: !!a });
      stopTimer();
      try {
        const result = await session.endTurn();
        if (a) {
          // Whatever the drain left open (a response cut off by the timeout)
          // ends here, then the last run closes and every exchange the turn
          // closed is read out, in order, each in its own speaker's voice.
          if (a.stream) {
            const r = a.stream.end();
            a.stream = null;
            applyAutoText(r.text, r.verdict);
          }
          a.heardAll = result.heard || a.heardAll;
          closeAutoRun(a);
          autoRef.current = null;
          void speakInOrder(a.closed, a.pair);
        } else if (result.translation || result.heard) {
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
        autoRef.current = null;
        setLiveHeard("");
        setLiveTranslation("");
        setTurn({ kind: "idle" });
      }
    },
    [pair, stopTimer, pushExchange, applyAutoText, closeAutoRun, speakInOrder]
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
      // Take it inside the tap gesture — the best context to ask in if a
      // prior request was denied. The effect above refreshes and releases it;
      // a tap that never opens a turn is dropped by the idle cap.
      holdWake("tabletop-turn");
      // The Gemini brain reads the mic through WebAudio, and iOS only lets a
      // context start inside a gesture — this one (lib/tabletop/audio.ts).
      if (engine === "live" && runBrain === "gemini") ensureTabletopAudioContext();
      const t = turnRef.current;
      if (t.kind === "idle") {
        // With auto-detect on, a side tap is the escape hatch: THIS turn is
        // forced to that direction (today's tapped turn, on the auto session),
        // and the next ◉ Auto-detect tap is auto again.
        if (engine === "live") void startLiveTurn(side);
        else void startClassicTurn(side);
      } else if (t.kind === "recording" && t.auto) {
        // Either lit button ends an auto turn — the side it is on is only
        // whoever spoke last.
        void endLiveTurn(t.side);
      } else if (t.kind === "recording" && t.side === side) {
        if (engine === "live") void endLiveTurn(side);
        else {
          cancelledRef.current = false;
          recorderRef.current?.stop();
        }
      }
    },
    [engine, runBrain, startLiveTurn, startClassicTurn, endLiveTurn]
  );

  // The auto-detect start/stop in the middle bar. No side: the turn opens on
  // the last speaker the tags found (or the phone's owner) and the tags take
  // it from there.
  const tapAuto = useCallback(() => {
    holdWake("tabletop-turn");
    const t = turnRef.current;
    if (t.kind === "idle") {
      const last = lastSourceRef.current;
      void startLiveTurn(last && pair.includes(last) ? last : mine, true);
    } else if (t.kind === "recording" && t.auto) {
      void endLiveTurn(t.side);
    }
  }, [pair, mine, startLiveTurn, endLiveTurn]);

  // Flipping auto-detect can move the table between brains (a founder on
  // Gemini), so a session on the wrong one is closed — numbers logged.
  const toggleAuto = useCallback(
    (on: boolean) => {
      if (turnRef.current.kind !== "idle") return;
      const next = autoBrain(brain, autoAllowed && on && engine === "live").brain;
      if (liveRef.current && liveRef.current.kind !== next) {
        liveRef.current.stop();
        liveRef.current = null;
      }
      setAutoOn(on);
    },
    [brain, autoAllowed, engine]
  );

  // Founder chips: a new brain is a new session, so the old one is closed
  // (and its numbers logged) before the next tap mints the other.
  const chooseBrain = useCallback(
    (next: TabletopBrainKind) => {
      if (!founder || turnRef.current.kind !== "idle") return;
      try {
        window.localStorage.setItem(BRAIN_STORAGE_KEY, next);
      } catch {
        /* this tap still counts */
      }
      // With auto-detect on, both chips run openai; only a real change of
      // brain costs the open session.
      if (autoBrain(next, autoActive).brain !== runBrain) {
        liveRef.current?.stop();
        liveRef.current = null;
      }
      setBrain(next);
    },
    [founder, autoActive, runBrain]
  );

  const endBrainSession = useCallback(() => {
    if (turnRef.current.kind !== "idle") return;
    liveRef.current?.stop();
    liveRef.current = null;
  }, []);

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

  // Each pane follows the tail of whatever is being written into it right
  // now (components/FollowTail.tsx): the far side's translation while it
  // streams in, or this side's own "you said" line while it is heard.
  const paneStreaming = (lang: Lang): { on: boolean; text: string } => {
    if (engine !== "live" || turn.kind === "idle") return { on: false, text: "" };
    if (turn.side !== lang) return { on: !!liveTranslation, text: liveTranslation };
    const hearing = turn.kind === "recording" && !!liveHeard;
    return { on: hearing, text: hearing ? liveHeard : "" };
  };
  const topStream = paneStreaming(topLang);
  const bottomStream = paneStreaming(bottomLang);
  const topTail = useFollowTail(topStream.on, topStream.text);
  const bottomTail = useFollowTail(bottomStream.on, bottomStream.text);

  const renderPane = (
    lang: Lang,
    rotated: boolean,
    tail: FollowTail<HTMLDivElement>
  ): JSX.Element => {
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
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div ref={tail.ref} className="flex-1 overflow-y-auto [overflow-anchor:none]">
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
          <JumpToTail show={tail.detached} onJump={tail.jumpToTail} />
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
                  ? t.tableListening
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
      {renderPane(topLang, true, topTail)}

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
        <div data-tabletop-controls="" className="flex flex-wrap items-center justify-center gap-2">
        <ExitHome lang={mine} />
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
        {autoAllowed && engine === "live" ? (
          <AutoBar
            on={autoOn}
            turn={turn}
            words={copyFor(mine)}
            onToggle={toggleAuto}
            onTap={tapAuto}
          />
        ) : null}
        {founder && engine === "live" ? (
          <BrainBar
            brain={brain}
            disabled={turn.kind !== "idle"}
            live={brainLive}
            last={lastSession}
            autoFellBack={autoFellBack}
            onChoose={chooseBrain}
            onEnd={endBrainSession}
          />
        ) : null}
      </div>

      {renderPane(bottomLang, false, bottomTail)}

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

// Auto-detect's row in the middle bar (founders, TAOS_TABLETOP_AUTO_ENABLED):
// the home screen's own "Auto-detect language" checkbox, same copy key, and
// the one button that opens a turn without picking a side. Every word is an
// existing lib/chrome/copy.ts key in the phone owner's language — nothing new
// to translate. The side buttons in the panes stay the escape hatch.
function AutoBar({
  on,
  turn,
  words,
  onToggle,
  onTap
}: {
  on: boolean;
  turn: TurnState;
  words: ReturnType<typeof copyFor>;
  onToggle: (on: boolean) => void;
  onTap: () => void;
}): JSX.Element {
  const autoTurn = turn.kind !== "idle" && turn.auto === true;
  const otherTurn = turn.kind !== "idle" && !autoTurn;
  const recording = autoTurn && turn.kind === "recording";
  return (
    <div data-tabletop-auto="" className="flex items-center justify-center gap-3">
      <label className="flex items-center gap-2 text-xs text-amber-100/70">
        <input
          type="checkbox"
          checked={on}
          disabled={turn.kind !== "idle"}
          onChange={(e) => onToggle(e.target.checked)}
          className="h-4 w-4 accent-amber-400"
        />
        {words.autoDetectLanguage}
      </label>
      {on ? (
        <button
          type="button"
          onClick={onTap}
          disabled={otherTurn || (autoTurn && !recording)}
          aria-pressed={recording}
          className={`rounded-full px-4 py-1.5 text-xs font-bold disabled:opacity-40 ${
            recording ? "animate-pulse bg-red-500 text-stone-50" : "bg-emerald-400 text-stone-950"
          }`}
        >
          {recording
            ? words.tapDone
            : autoTurn && turn.kind === "connecting"
              ? words.connecting
              : autoTurn
                ? words.translating
                : `◉ ${words.autoDetect}`}
        </button>
      ) : null}
    </div>
  );
}

// The founder-only strip under the middle bar: the two brain chips, an end
// button (a session's numbers are only final once it ends), and the last
// session's numbers in one line, readable right after a run.
function BrainBar({
  brain,
  disabled,
  live,
  last,
  autoFellBack,
  onChoose,
  onEnd
}: {
  brain: TabletopBrainKind;
  disabled: boolean;
  live: boolean;
  last: TabletopSessionSummary | null;
  /** Gemini is chosen but auto-detect is on, so the table runs on OpenAI. */
  autoFellBack: boolean;
  onChoose: (b: TabletopBrainKind) => void;
  onEnd: () => void;
}): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="flex items-center justify-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-amber-100/40">brain</span>
        {TABLETOP_BRAINS.map((b) => (
          <button
            key={b}
            type="button"
            onClick={() => onChoose(b)}
            disabled={disabled}
            aria-pressed={brain === b}
            className={`rounded-full px-3 py-0.5 text-xs disabled:opacity-40 ${
              brain === b
                ? "bg-emerald-400 text-stone-950"
                : "border border-white/10 bg-white/5 text-amber-100/70"
            }`}
          >
            {BRAIN_LABEL[b]}
          </button>
        ))}
        {live ? (
          <button
            type="button"
            onClick={onEnd}
            disabled={disabled}
            className="rounded-full border border-white/10 bg-white/5 px-3 py-0.5 text-xs text-amber-100/70 disabled:opacity-40"
          >
            ⏹ end session
          </button>
        ) : null}
      </div>
      {autoFellBack ? (
        <div className="text-center text-[10px] leading-tight text-amber-100/50">
          auto-detect runs on OpenAI — Gemini takes one fixed target language
        </div>
      ) : null}
      {last ? (
        <div className="text-center font-mono text-[10px] leading-tight text-amber-100/50">
          last: {BRAIN_LABEL[last.brain]} · {last.seconds}s · {last.segments} seg · first{" "}
          {last.first_partial_ms_p50}/{last.first_partial_ms_p95}ms · done {last.segment_done_ms_p50}/
          {last.segment_done_ms_p95}ms · err {last.errors} · rc {last.reconnects} · $
          {last.est_usd.toFixed(4)}
          {last.auto ? ` · auto · miss ${last.detect_miss ?? 0}` : ""}
        </div>
      ) : null}
    </div>
  );
}
