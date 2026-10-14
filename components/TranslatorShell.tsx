"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import {
  getMonthlyUsage,
  getTier,
  isSubscriber,
  saveTranslation,
  translationsLeft,
  type MonthlyUsage,
  type Profile
} from "@/lib/supabase";
import { HistoryDrawer } from "./HistoryDrawer";
import { InstallPrompt } from "./InstallPrompt";
import { Paywall } from "./Paywall";
import { QrShareModal } from "./QrShareModal";
import { PersonalVoiceModal, useSecretTaps } from "./PersonalVoiceUnlock";
import { TextOnlyNote } from "./TextOnly";
import { LanguagePillRow, LanguageSheet } from "./LanguagePicker";
import { requestSpeech } from "@/lib/tts/speech";
import { SUBSCRIBER_DEFAULT_ENGINE, type TtsEngine } from "@/lib/tts/engine";
import { fetchWithRetry, isConnectionError } from "@/lib/net";
import { type PairLangCode } from "@/lib/translate/pair";
import { useLanguagePair } from "@/lib/translate/useLanguagePair";
import { continueSession, type ConversationSession } from "@/lib/translate/session";
import { canSpeak, languageNative } from "@/lib/languages/catalog";
import { callVisibleTo, fastVisibleTo, isFounder, studyEnabled, tutorEnabled } from "@/lib/release";
import { keepWake } from "@/lib/wakeLock";
import { BUILD_LABEL } from "@/lib/version";
import { authHeaders } from "@/lib/authClient";
import { copyFor, fill } from "@/lib/chrome/copy";

// The pair's languages, its storage, and the tap rule all live in
// lib/translate/pair.ts — /vision reads the same saved pair to decide what
// language a photo comes back in.
type LangCode = PairLangCode;
type Engine = TtsEngine;

// Brand names, so not in lib/chrome/copy.ts: they read the same in every language.
const ENGINE_LABEL: Record<Engine, string> = {
  fishaudio: "Fish Audio",
  elevenlabs: "ElevenLabs",
  openai: "OpenAI"
};
type Status = "idle" | "recording" | "processing" | "done" | "error";

interface Speaker {
  code: LangCode;
  label: string; // language name in its own language
}

// A speaker is identified by their LANGUAGE, never by name. There used to be a
// household table here (the app began as a two-person app) that put a first
// name in front of the language for subscribers. The app is handed to
// strangers now — a QR code at a table — and a stranger who subscribes should
// never read someone else's name on their own phone. The language's name in
// its OWN language is what the person across the table recognizes anyway,
// which is what the beta tier has shown all along.
//
// This was a hand-written table of six, and it is the reason a seventh
// language was never a one-line change: a code without a row here crashed the
// shell. The label comes from the catalog now, for all hundred of them.
function speakerFor(code: LangCode): Speaker {
  return { code, label: languageNative(code) };
}

// ── Conversation languages ─────────────────────────────────────────────────
// The picker is a row of LANGUAGE pills (Tom, 8/17, for the Bosnia + Italy
// trip). A tap answers one question — "what should come out?" — instead of
// asking someone to find the right A⇄B pair. The old picker listed one button
// per pair, which is why it had already been folded into EN⇄ES + "Other"
// (8/15): pairs grow as the square of the languages, pills grow one per
// language.
//
// Underneath, a turn is still scoped to a PAIR, and that is deliberate:
// /api/translate's auto-detect decides between exactly TWO languages because
// detecting among all fourteen gets flaky, while between two it stays sharp.
// So the pills express the pair as [yours, theirs]:
//   - tap a new language  -> it becomes THEIRS (the output); your side stays
//   - tap your own side   -> the two flip (you become the one being translated
//                            INTO, e.g. so Liz can run ES⇄IT where Tom runs
//                            EN⇄IT)
// Only these taps change the pair. Auto-detect still decides, per turn, which
// of the two languages was actually spoken (that is `source`), so the pill row
// never shifts under a live conversation.
//
// WHICH languages get a pill is no longer written here. It was two hard-coded
// rows — the trip four, plus zh/yue behind an "Other · Otros" disclosure — and
// the app knows a hundred languages as of 8/17, which that shape cannot hold
// at any width. lib/translate/pinned.ts answers it instead: the pair, plus
// what this phone has reached for lately, capped at five. The rest live in the
// search sheet, one tap deep, which is where the old disclosure's job went.

// The build marker moved to lib/version.ts when /about started showing it too.

// Speaker-facing copy flips to whoever is talking (Tom = en, Liz = es) so each
// person reads the controls they act on in their own language.
//
// The table itself is lib/chrome/copy.ts now, shared with /tabletop and
// /call. It used to live here, which is how /tabletop ended up with a
// two-language copy of half of it and /call with none at all. The rule it
// carries has not changed: a language with no entry falls back to English,
// key by key, rather than being held out of the app — a Thai speaker gets
// English buttons and a faithful Thai translation, and the translation is
// what they came for.

// In auto-detect the record button greets BOTH sides at once ("Speak ·
// Hablar") so neither person has to wait their turn to read it. That only
// works while the two have different copy — and since 8/17 a pair can hold two
// languages that both fall back to English, which would render "Speak ·
// Speak". A repeat collapses to one.
function speakPrompt(pair: readonly [LangCode, LangCode]): string {
  const mine = copyFor(pair[0]).speak;
  const theirs = copyFor(pair[1]).speak;
  return mine === theirs ? mine : `${mine} · ${theirs}`;
}

// Liz's call (8/9, in her words): the Casual/Detallado toggle kept getting
// forgotten before long turns and casual summarized too much — so /translate
// always sends "detailed". Talk as long as you want; nothing is trimmed. The
// server still accepts both tones (tabletop's short party turns stay casual).
const TONE = "detailed" as const;

// ── Per-turn safety cap ──────────────────────────────────────────────────
// Hard limit on a single recording. On reaching it we auto-stop and run the
// normal transcribe → translate → speak flow on whatever audio was captured
// (the audio is NEVER discarded). Keep this <= the /api/translate route's
// `maxDuration` (300s) — a longer turn can't be transcribed + paraphrased in
// time and the turn fails silently. Change to 150000 for a 2.5-minute cap.
const MAX_TURN_DURATION_MS = 300000; // 5 minutes

// A stop within this window is an accidental rapid double-tap, not a turn.
// Sub-second clips carry no usable speech, and the really short ones don't
// even have complete container headers — OpenAI rejects those as "corrupted
// or unsupported". Catch them before they leave the phone.
const MIN_TURN_DURATION_MS = 600;

// Visual "wrap up" ramp on the record button. NO audio cues — the mic and
// speaker are both live during a turn, so the only safe signal is visual.
const RAMP_EARLY_MS = 30000; // T-30s remaining: gentle "breathing" glow begins
const RAMP_FAST_MS = 10000; // T-10s remaining: pulse starts accelerating
const PULSE_SLOW_MS = 600; // pulse period at the start of the fast ramp (T-10s)
const PULSE_FAST_MS = 150; // pulse period as it reaches T-0 (fastest)

// Keep the upload well under Vercel's ~4.5 MB request-body limit even on a
// full-length turn: cap MediaRecorder at a voice-friendly bitrate
// (32 kbps ≈ 1.2 MB for 5 min) so the audio buffer can't grow unbounded.
const AUDIO_BITS_PER_SECOND = 32000;

function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac"];
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return "";
}

function fileNameFor(mime: string): string {
  if (mime.includes("webm")) return "audio.webm";
  if (mime.includes("mp4") || mime.includes("aac")) return "audio.mp4";
  return "audio.webm";
}

/**
 * One 24x24 line icon for the launcher grid, in the stroke style every other
 * icon in this app already uses (see components/fast/FastMicDock.tsx and the
 * Share button below): fill none, currentColor, 2px round caps. Decorative —
 * every tile carries its own aria-label from lib/chrome/copy.ts, so these are
 * aria-hidden and never the thing a screen reader announces.
 *
 * One component rather than eleven inline SVGs so the sizing cannot drift tile to
 * tile, which is the only way a grid of icons stops reading as a grid.
 */
function NavIcon({ name }: { name: NavIconName }): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5 shrink-0"
    >
      {NAV_ICON_PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

type NavIconName = keyof typeof NAV_ICON_PATHS;

const NAV_ICON_PATHS = {
  // The record button this screen is built around.
  speak: ["M12 2a3 3 0 00-3 3v6a3 3 0 006 0V5a3 3 0 00-3-3z", "M5 10v1a7 7 0 0014 0v-1M12 19v3M8.5 22h7"],
  // /translate is the TYPING screen — a keyboard, not a microphone. The two
  // are the pair a reader is likeliest to confuse (tests/guide-page.test.ts
  // has a whole case about it), so they get the two most different glyphs.
  translate: ["M3 7a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7z", "M7 9h.01M11 9h.01M15 9h.01M17 9h.01M7 13h.01M17 13h.01M9.5 16h5"],
  // Listening, not talking: a speaker with a wave coming off it.
  live: ["M11 5L6 9H3v6h3l5 4V5z", "M15.5 9.5a3.5 3.5 0 010 5M18.5 6.5a7.5 7.5 0 010 11"],
  // The phone laid flat between two people, split down the middle.
  table: ["M4 3h16a1 1 0 011 1v16a1 1 0 01-1 1H4a1 1 0 01-1-1V4a1 1 0 011-1z", "M3 12h18"],
  chat: ["M21 11.5a8.4 8.4 0 01-9.1 8.4L4 21l1.1-3.9A8.4 8.4 0 1121 11.5z"],
  call: ["M21.5 16.9v2.8a2 2 0 01-2.2 2 19.6 19.6 0 01-8.5-3 19.3 19.3 0 01-6-6 19.6 19.6 0 01-3-8.6A2 2 0 013.8 2h2.8a2 2 0 012 1.7c.1 1 .4 1.9.7 2.8a2 2 0 01-.5 2.1L7.6 9.9a16 16 0 006 6l1.3-1.2a2 2 0 012.1-.5c.9.3 1.8.6 2.8.7a2 2 0 011.7 2z"],
  // /fast is the quickie box: a bolt.
  fast: ["M13 2L4 14h7l-1 8 9-12h-7l1-8z"],
  photo: ["M3 8.5A2 2 0 015 6.5h2.2L8.5 4.5h7l1.3 2H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2v-9z", "M15.5 13a3.5 3.5 0 11-7 0 3.5 3.5 0 017 0z"],
  video: ["M3 7a2 2 0 012-2h8a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7z", "M15 10.5l6-3.5v10l-6-3.5"],
  tutor: ["M12 3L2 8l10 5 10-5-10-5z", "M6 10.5V16c0 1.7 2.7 3 6 3s6-1.3 6-3v-5.5"],
  // /study: an open book — your own conversations, read back as lessons.
  study: ["M2 5a1 1 0 011-1h6a3 3 0 013 3v13a2 2 0 00-2-2H3a1 1 0 01-1-1V5z", "M22 5a1 1 0 00-1-1h-6a3 3 0 00-3 3v13a2 2 0 012-2h6a1 1 0 001-1V5z"]
} as const;

export function TranslatorShell({
  email,
  profile,
  onSignOut
}: {
  email: string;
  profile: Profile | null;
  onSignOut: () => void;
}): JSX.Element {
  const subscriber = isSubscriber(profile);
  const [usage, setUsage] = useState<MonthlyUsage | null>(null);
  const [showPaywall, setShowPaywall] = useState(false);
  const transLeft = translationsLeft(profile, usage);
  const trialBlocked = !subscriber && transLeft <= 0;

  const [source, setSource] = useState<LangCode>("es"); // who is speaking right now
  // Beta (7/27): ElevenLabs cloned voices are for subscribers (Tom, Liz);
  // free-tier beta testers get OpenAI only — ElevenLabs is priced per
  // character and a fleet of testers would run up real cost. Default is
  // openai so a free user never touches ElevenLabs even during the
  // profile-load window; a subscriber's default upgrades once the profile
  // resolves (unless they already tapped the toggle themselves). That upgrade
  // is SUBSCRIBER_DEFAULT_ENGINE — ElevenLabs. It was Fish Audio for one day
  // (10/06, #85) until the phone heard it; Fish stays on the picker to test.
  const [engine, setEngine] = useState<Engine>("openai");
  const engineTouchedRef = useRef(false);
  // The conversation the next saved turn belongs to; see lib/translate/session.ts.
  const sessionRef = useRef<ConversationSession | null>(null);
  useEffect(() => {
    if (subscriber && !engineTouchedRef.current) setEngine(SUBSCRIBER_DEFAULT_ENGINE);
  }, [subscriber]);
  const [autoPlay, setAutoPlay] = useState(true);
  const [autoDetect, setAutoDetect] = useState(true);

  const [status, setStatus] = useState<Status>("idle");
  const [original, setOriginal] = useState("");
  const [translation, setTranslation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [wrappingUp, setWrappingUp] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Two menus, and the names say which is which now: the nine-dot GRID is the
  // app launcher, the ACCOUNT menu hangs off the avatar. They used to be
  // "account" (which held four screens) and "together" (which held two more).
  const [gridMenuOpen, setGridMenuOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [personalVoiceOpen, setPersonalVoiceOpen] = useState(false);
  const personalVoiceTap = useSecretTaps(() => setPersonalVoiceOpen(true));

  const gridMenuRef = useRef<HTMLDivElement | null>(null);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef<string>("");
  const lastBlobRef = useRef<Blob | null>(null);
  const lastMimeRef = useRef<string>("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const wakeStopRef = useRef<(() => void) | null>(null);
  const maxStopTimerRef = useRef<number | null>(null);
  // Visual ramp state (drives the record button directly, no re-render per frame).
  const recordBtnRef = useRef<HTMLButtonElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const recordStartRef = useRef<number>(0);
  const pulsePhaseRef = useRef<number>(0);
  const lastTickRef = useRef<number>(0);

  // v1 release gate: Call and Video links only render for founders
  // (lib/release.ts — the pages themselves are wrapped in FounderGate too).
  const founder = isFounder(email);
  // /call asks its own question rather than reusing `founder`: it is founders
  // OR everyone, once NEXT_PUBLIC_ENABLE_CALL ships it, and the nav must not
  // be the surface that forgets the second half.
  const callVisible = callVisibleTo(email);
  // Same shape as callVisible, and for the same reason: /fast is founders OR
  // everyone once NEXT_PUBLIC_ENABLE_FAST ships it.
  const fastVisible = fastVisibleTo(email);

  // Which tile in the launcher is the screen you are already on. The header
  // only renders on "/" today, so this is "/" every time — it is read from the
  // router rather than assumed because the whole point of the grid is that it
  // is a catalog of screens, and a catalog that has to be edited when it moves
  // to a second screen is the kind of thing that quietly stops being true.
  const pathname = usePathname();

  // The avatar's letter. First alphanumeric of the signed-in email, or null —
  // in which case the chip draws a person glyph instead, because "?" or a blank
  // circle both read as an error.
  //
  // #45 removed exactly this arithmetic from the NINE-DOT TRIGGER, and that
  // still stands: a disclosure whose glyph is drawn from the account renders as
  // an X on any x@ address, and Liz watched strangers refuse to tap it. The
  // avatar is a different control with a different job — being a function of
  // whose phone it is, is what an avatar IS — and it never swaps to an X.
  const avatarInitial = ((email ?? "").match(/[a-z0-9]/i)?.[0] ?? "").toUpperCase() || null;

  // The pair, the pill row and the sheet, shared with /live and /tabletop
  // (lib/translate/useLanguagePair.ts). pair[0] is YOUR side, pair[1] is
  // theirs — the solid pill, and what /translate translates INTO. Only the
  // picker moves the pair; `source` moves within it turn by turn.
  //
  // A pair change tears the current turn down: the translation on screen is
  // in a language that is no longer selected, and leaving it up would invite
  // someone to tap Play on it. The hook never fires this for a tap that
  // changed nothing, so re-tapping the selected language leaves a turn alone.
  const { pair, mine, theirs: output, pills, sheetOpen, setSheetOpen, selectLanguage } =
    useLanguagePair({
      onPairChange: (next) => {
        // pair[0] is the side that speaks next by default; after a flip that
        // is the language that was just the output.
        setSource(next[0]);
        setOriginal("");
        setTranslation("");
        setError(null);
        if (status !== "recording") setStatus("idle");
      }
    });

  const target: LangCode = source === pair[0] ? pair[1] : pair[0];
  const speaker = speakerFor(source);
  const listener = speakerFor(target);
  // The screen is the phone OWNER's, not the speaker's: it must not change
  // language every time auto-detect hands the turn across. `mine` is the side
  // this phone keeps as its own — the same choice /call makes (CallShell).
  // Tom, 2026-10-04: the whole home screen reads this way, not just the
  // header. `source` still decides who is speaking and which way a turn is
  // translated; it no longer decides what language the buttons are in.
  const s = copyFor(mine);
  const nav = copyFor(mine);
  // Tier 2 (lib/languages/catalog.ts): translated, never spoken. The screen has
  // to say so up front — an audio control that silently does nothing reads as a
  // bug, and this is a known limit of the language, not of the app.
  const textOnlyTarget = !canSpeak(target);

  useEffect(() => {
    return () => {
      clearRecordingTimers();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The screen must never sleep mid-dictation — but it must be allowed to
  // sleep between dictations. This used to acquire at mount and want the lock
  // for the life of the page (9/6: an open tab cost Tom a day and a half of
  // iPhone battery). The lock is now taken inside the record gesture and let
  // go when the turn ends; lib/wakeLock.ts holds it through a 60s grace so the
  // pause between two turns does not blink the screen off.
  useEffect(() => {
    if (status === "recording") return;
    wakeStopRef.current?.();
    wakeStopRef.current = null;
  }, [status]);
  useEffect(
    () => () => {
      wakeStopRef.current?.();
      wakeStopRef.current = null;
    },
    []
  );

  // Load this month's usage (skip for subscribers — they're unlimited).
  useEffect(() => {
    if (subscriber) return;
    let active = true;
    getMonthlyUsage()
      .then((u) => active && setUsage(u))
      .catch(() => active && setUsage({ translations: 0, tutorSeconds: 0 }));
    return () => {
      active = false;
    };
  }, [subscriber]);

  // Close the grid menu on outside pointer press or Escape. Only wired while
  // the menu is open so there's no idle global listener.
  //
  // A CONTAINMENT CHECK, not a suppressed event. This is the shape everyone
  // reaches for when a menu appears to eat a tap, and reaching for
  // stopPropagation instead only hides a containment check that is wrong.
  // (The 8/31 "menu eats touches" report turned out to be geometry, not this
  // — see the header — but the fence stays.)
  useEffect(() => {
    if (!gridMenuOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (gridMenuRef.current && !gridMenuRef.current.contains(e.target as Node)) {
        setGridMenuOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setGridMenuOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [gridMenuOpen]);

  // Same close-on-outside/Escape behavior for the avatar's account menu. The
  // two triggers also close each other on press (see the header), so moving
  // between them is one touch rather than close-then-open.
  useEffect(() => {
    if (!accountMenuOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (accountMenuRef.current && !accountMenuRef.current.contains(e.target as Node)) {
        setAccountMenuOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setAccountMenuOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [accountMenuOpen]);

  function ensureAudioEl(): HTMLAudioElement | null {
    if (!audioRef.current) {
      audioRef.current = typeof Audio !== "undefined" ? new Audio() : null;
    }
    return audioRef.current;
  }

  // Calling play() inside the user gesture "blesses" the element so later
  // programmatic play() (after async fetch) is allowed on iOS Safari.
  function blessAudio() {
    const a = ensureAudioEl();
    if (!a) return;
    a.play().catch(() => {});
    a.pause();
  }

  // Reset any inline ramp styling so the button returns to its normal look.
  function resetRecordButtonStyle() {
    const btn = recordBtnRef.current;
    if (btn) {
      btn.style.transform = "";
      btn.style.boxShadow = "";
    }
  }

  // Drives the purely-visual "wrap up" ramp on the record button each frame.
  // T-30s → T-10s: a gentle slow breathing glow (early heads-up).
  // T-10s → T-0:  a pulse that accelerates as the period shrinks 600ms → 150ms.
  // We mutate the button's style directly (via ref) to avoid a re-render per
  // frame, and respect prefers-reduced-motion by using a steady glow instead.
  function tickRamp() {
    const now = performance.now();
    const elapsed = now - recordStartRef.current;
    const remaining = MAX_TURN_DURATION_MS - elapsed;
    const btn = recordBtnRef.current;

    // Surface the textual heads-up once we enter the ramp window.
    setWrappingUp(remaining <= RAMP_EARLY_MS);

    if (btn) {
      const reduceMotion =
        typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

      if (remaining > RAMP_EARLY_MS) {
        resetRecordButtonStyle();
      } else {
        const urgent = remaining <= RAMP_FAST_MS;
        // Pulse period: constant & gentle in the early window, then shrinking
        // (faster and faster) through the final window.
        const period = urgent
          ? PULSE_FAST_MS +
            (PULSE_SLOW_MS - PULSE_FAST_MS) * (Math.max(0, remaining) / RAMP_FAST_MS)
          : 2400;

        let wave: number;
        if (reduceMotion) {
          // No oscillation; steady intensity that steps up when urgent.
          wave = urgent ? 1 : 0.5;
        } else {
          const dt = now - (lastTickRef.current || now);
          pulsePhaseRef.current += (dt / period) * Math.PI * 2;
          wave = (Math.sin(pulsePhaseRef.current) + 1) / 2; // 0..1
        }

        const scaleAmt = urgent ? 0.08 : 0.03;
        const glow = (urgent ? 80 : 36) * wave + 18;
        btn.style.transform = reduceMotion ? "" : `scale(${1 + wave * scaleAmt})`;
        btn.style.boxShadow = `0 0 ${glow}px rgba(251,191,36,${0.4 + wave * 0.5})`;
      }
    }

    lastTickRef.current = now;
    if (remaining <= 0) {
      // Hard cap reached — the maxStopTimer backstop also fires stopRecording().
      stopRecording();
      return;
    }
    rafRef.current = requestAnimationFrame(tickRamp);
  }

  function stopRamp() {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    resetRecordButtonStyle();
  }

  function clearRecordingTimers() {
    if (maxStopTimerRef.current !== null) {
      window.clearTimeout(maxStopTimerRef.current);
      maxStopTimerRef.current = null;
    }
    stopRamp();
  }

  async function speak(text: string, src: LangCode = source, tgt: LangCode = target) {
    if (!text) return;
    // Tier 2 (lib/languages/catalog.ts): nothing in the pipeline can say this
    // language out loud, so don't ask /api/tts and — importantly — don't raise
    // anything. The translated text on screen IS the whole answer here; an
    // error under it would be the app apologizing for working as designed.
    // The screen already says "text only" next to the language, so this is a
    // limit the person met before the turn, not a surprise after it.
    if (!canSpeak(tgt)) return;
    const a = ensureAudioEl();
    if (!a) return;
    try {
      setIsSpeaking(true);
      const blob = await requestSpeech(
        { text, engine, sourceLanguage: src, targetLanguage: tgt },
        {
          fetch: (input, init) => fetchWithRetry(input, init, { retries: 2, timeoutMs: 60000 }),
          failureMessage: s.ttsFailed,
          surface: "home"
        }
      );
      // null = text only. The guard above already caught the languages the
      // catalog knows about; this is the same answer arriving from the server.
      if (!blob) {
        setIsSpeaking(false);
        return;
      }
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      a.src = url;
      a.onended = () => setIsSpeaking(false);
      await a.play();
    } catch (e) {
      console.error("[tts] playback failed", e);
      setIsSpeaking(false);
      // A dead connection surfaces as Safari's bare "Load failed" — swap in a
      // message that actually tells the person what to do.
      setError(isConnectionError(e) ? s.connectionLost : e instanceof Error ? e.message : s.ttsFailed);
    }
  }

  async function startRecording() {
    setError(null);
    if (trialBlocked) return; // free translations used up — show upgrade instead
    blessAudio();
    // Take the wake lock inside the tap gesture — the moment that matters,
    // and the best context to ask in if a prior request was denied (Low Power
    // Mode). The effect above lets it go when status leaves "recording".
    wakeStopRef.current?.();
    wakeStopRef.current = keepWake("home-mic");

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setStatus("error");
      setError(s.micUnavailable);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = pickMimeType();
      mimeRef.current = mime;
      // Constrain the bitrate so even a full-length turn stays a small upload
      // (see AUDIO_BITS_PER_SECOND) — guards against unbounded buffer growth
      // and Vercel's ~4.5 MB request-body limit.
      const opts: MediaRecorderOptions = { audioBitsPerSecond: AUDIO_BITS_PER_SECOND };
      if (mime) opts.mimeType = mime;
      const recorder = new MediaRecorder(stream, opts);
      chunksRef.current = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      recorder.onstop = () => void handleRecordingStopped();
      // iOS Safari ends the mic track SILENTLY when the audio session is
      // interrupted (incoming call, Siri, another app taking the mic, some
      // screen-lock states). Without these handlers the turn dies with the
      // button still lit and the captured audio is lost (Liz, 7/27: "a veces
      // simplemente deja de transmitirse… y se apaga"). Route both through the
      // normal stop path so whatever was heard before the interruption still
      // gets translated.
      recorder.onerror = (ev) => {
        console.error("[translate] recorder error — finishing the turn early", ev);
        stopRecording();
      };
      for (const track of stream.getAudioTracks()) {
        track.onended = () => {
          console.warn("[translate] mic track ended mid-turn — finishing the turn early");
          stopRecording();
        };
      }
      // Flush audio into chunks every second so a long turn is never held in one
      // fragile buffer that could be lost if the page is suspended.
      recorder.start(1000);
      recorderRef.current = recorder;
      setStatus("recording");
      setWrappingUp(false);

      // Start the per-turn cap: a setTimeout is the authoritative hard stop
      // (fires even if the rAF ramp is throttled in a background tab); the
      // rAF loop drives the visual wrap-up ramp.
      clearRecordingTimers();
      recordStartRef.current = performance.now();
      pulsePhaseRef.current = 0;
      lastTickRef.current = 0;
      maxStopTimerRef.current = window.setTimeout(stopRecording, MAX_TURN_DURATION_MS);
      rafRef.current = requestAnimationFrame(tickRamp);
    } catch {
      setStatus("error");
      setError(s.micDenied);
    }
  }

  function stopRecording() {
    clearRecordingTimers();
    setWrappingUp(false);
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      setStatus("processing");
      recorder.stop();
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  async function handleRecordingStopped() {
    const mime = mimeRef.current || "audio/webm";
    const blob = new Blob(chunksRef.current, { type: mime });
    recorderRef.current = null;
    chunksRef.current = [];
    const turnMs = performance.now() - recordStartRef.current;
    if (turnMs < MIN_TURN_DURATION_MS) {
      setStatus("error");
      setError(s.tooShort);
      return;
    }
    if (blob.size === 0) {
      // Previously this returned to idle silently — a long turn that lost its
      // audio (e.g. the page was suspended) produced no translation and no
      // error. Surface it instead so the turn never fails invisibly.
      console.error("[translate] no audio captured (empty recording blob)");
      setStatus("error");
      setError(s.noAudio);
      return;
    }
    // Keep the clip so "Flip" can re-run it the other way without re-recording.
    lastBlobRef.current = blob;
    lastMimeRef.current = mime;
    await translateBlob(blob, mime, autoDetect ? "auto" : source, autoDetect ? "auto" : target);
  }

  // Shared translate routine — used by a normal turn and by Flip (same audio,
  // opposite direction).
  async function translateBlob(blob: Blob, mime: string, src: string, tgt: string) {
    setOriginal("");
    setTranslation("");
    setStatus("processing");
    try {
      const form = new FormData();
      form.append("audio", blob, fileNameFor(mime));
      form.append("sourceLanguage", src);
      form.append("targetLanguage", tgt);
      form.append("tone", TONE);
      if (src === "auto") {
        // Auto-detect is scoped to the active pair — the server decides which
        // of THESE two languages was spoken, never guessing beyond them.
        form.append("pairA", pair[0]);
        form.append("pairB", pair[1]);
      }

      // Retry + a client-side timeout: a mid-flight connection drop (Safari's
      // "Load failed") gets one silent re-send before anyone sees an error.
      // One retry only — each attempt re-runs the whole transcribe+translate
      // pipeline. The timeout comfortably exceeds the server's upstream caps.
      const res = await fetchWithRetry(
        "/api/translate",
        { method: "POST", headers: await authHeaders(), body: form },
        { retries: 1, timeoutMs: 210000 }
      );
      const payload = (await res.json().catch(() => ({}))) as {
        original?: string;
        translation?: string;
        sourceLanguage?: string;
        targetLanguage?: string;
        error?: string;
        details?: string;
      };
      if (!res.ok) {
        throw new Error(payload.details || payload.error || s.translateFailed);
      }
      // In auto mode the server resolves the real direction; use it for voice,
      // the on-screen direction, and history. Only accept a language that is
      // actually one of the active pair's two sides.
      const resolvedSrc: LangCode =
        payload.sourceLanguage === pair[0] || payload.sourceLanguage === pair[1]
          ? (payload.sourceLanguage as LangCode)
          : src === "auto"
            ? pair[0]
            : (src as LangCode);
      const resolvedTgt: LangCode = resolvedSrc === pair[0] ? pair[1] : pair[0];
      if (src === "auto") setSource(resolvedSrc);

      setOriginal(typeof payload.original === "string" ? payload.original : "");
      setTranslation(typeof payload.translation === "string" ? payload.translation : "");
      setStatus("done");
      if (payload.translation) {
        // Stamp the turn with its conversation: the same id while the turns
        // keep coming, a fresh one after ten minutes of silence. Only turns
        // that actually save can define a session — they are the only ones
        // the table will ever contain.
        const session = continueSession(sessionRef.current, Date.now());
        sessionRef.current = session;
        void saveTranslation({
          session_id: session.id,
          source_lang: resolvedSrc,
          target_lang: resolvedTgt,
          tone: TONE,
          original_text: payload.original ?? "",
          translation_text: payload.translation,
          engine
        }).catch(() => {});
        // Count this translation toward the free-trial allowance.
        if (!subscriber) {
          setUsage((u) => ({
            translations: (u?.translations ?? 0) + 1,
            tutorSeconds: u?.tutorSeconds ?? 0
          }));
        }
      }
      if (autoPlay && payload.translation) {
        void speak(payload.translation, resolvedSrc, resolvedTgt);
      }
    } catch (e) {
      console.error("[translate] pipeline failed", e);
      setStatus("error");
      setError(
        isConnectionError(e) ? s.connectionLost : e instanceof Error ? e.message : s.translateFailed
      );
    }
  }

  // Re-translate the LAST recording in the opposite direction — fixes the
  // "wrong person's side was selected" mix-up with no re-recording.
  function flipLast() {
    const blob = lastBlobRef.current;
    if (!blob || status === "recording" || status === "processing") return;
    blessAudio();
    const newSource: LangCode = target;
    const newTarget: LangCode = source;
    setSource(newSource);
    setError(null);
    void translateBlob(blob, lastMimeRef.current || "audio/webm", newSource, newTarget);
  }

  function toggleRecord() {
    if (status === "recording") {
      stopRecording();
    } else if (status !== "processing") {
      void startRecording();
    }
  }

  function swap() {
    blessAudio();
    setSource((prev) => (prev === pair[0] ? pair[1] : pair[0]));
    setOriginal("");
    setTranslation("");
    setError(null);
    if (status !== "recording") setStatus("idle");
  }

  const recording = status === "recording";
  const processing = status === "processing";

  if (showPaywall) {
    return (
      <Paywall
        email={email}
        mine={mine}
        currentTier={getTier(profile)}
        onClose={() => setShowPaywall(false)}
        onSignOut={onSignOut}
      />
    );
  }

  return (
    <main className="min-h-screen px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-[calc(env(safe-area-inset-top)+1rem)]">
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-md flex-col gap-4">
        {/* THE NAV IS THREE TIERS. Verbs, catalog, identity — and no dropdown
            in the row a thumb reaches for.

            What this replaces: one pill row that mixed screens with a
            "Together ▾" disclosure holding two of them, and a nine-dot menu
            that held four more screens PLUS History, the guide, About and
            Sign out. Three different kinds of thing in two menus, and which
            menu a screen lived in was an accident of the order it shipped in.
            Liz, taking the app to strangers: nobody opens a menu to find out
            what an app does. Together ▾ in particular never earned itself —
            it was created on 8/19 to fix a WIDTH (ENHANCEMENTS.md), and two
            items behind a disclosure is a disclosure that costs a touch and
            saves nothing now that the row wraps.

            So:

              1. PILLS — the daily verbs, top level, one touch each, no menu.
                 Translate · Live · Table · Chat, plus Call for founders.
                 Translate leads because it is the stranger's first magic
                 moment: type a sentence, watch it come back.
              2. THE NINE-DOT GRID — a true app launcher. Every surface TAOS
                 has, as an icon, in one glance, including the screen you are
                 standing on. It is deliberately REDUNDANT with the pills: the
                 pills answer "take me there", the grid answers "what can this
                 app do?", and those are different questions asked by different
                 people. A launcher that hid the four screens you use daily
                 would answer neither.
              3. THE AVATAR — identity, and only identity. History, the guide,
                 About, Sign out. These were in the nine-dot menu, mixed in
                 among screens, which is why /vision (a SCREEN) had to be
                 described to readers as living in "the account menu".

            The geometry from #53/#54 is unchanged and load-bearing: two
            deliberate rows, flex-wrap on the pills, both menus anchored to the
            HEADER (never to their own trigger), 44px floors everywhere.
            tests/nav-tap-targets.test.ts is the fence; do not take flex-wrap
            off and do not put `relative` on a trigger's wrapper. The reasons
            are worth re-reading before touching this:

            THE HEADER WRAPS. Tom, 8/31, on the Droid: reaching Call through
            Together ▾ took two or three touches, every time. The row was
            405.9px of content inside a 343px container, so the nav ran off the
            right edge of the phone and took the page's scroll width with it.
            Two tap-eaters out of that one number — the grid trigger was laid
            out PAST THE EDGE (elementFromPoint at its centre returned nothing
            at 390/360/320px), and document.scrollWidth exceeding the viewport
            makes the page horizontally pannable, so a touch that drifts
            sideways is a PAN and the browser dispatches no click at all
            (measured: 20px of drift scrolled the page 7px and fired nothing).
            A row that wraps cannot do either. This row has now grown by two
            more controls without moving off the glass, which is the wrap
            earning its keep.

            BOTH MENUS ANCHOR TO THE HEADER. A dropdown positioned against its
            own trigger drops onto whatever is under that trigger — and what is
            under row one is the pill row. An open menu then covers the pills
            and a touch aimed at Translate lands on a menu item instead: not a
            dead tap, a WRONG one. `relative` belongs on <header> and nowhere
            else in here. */}
        <header className="relative flex flex-col gap-2">
          {/* ROW ONE: the brand, and the three controls that are not screens —
              Share, the app grid, and you. They sit here rather than on the end
              of the pill row because the pill row is the part that grows: every
              screen TAOS has added since 8/19 arrived as a pill, and the grid
              trigger riding on the end of that row is what carried it off the
              edge of the phone. */}
          <div className="flex items-center justify-between gap-2">
            {/* Five taps on the title open the personal-voice sheet. Looks and
                behaves like plain text to everyone who isn't looking for it. */}
            <h1
              onClick={personalVoiceTap}
              className="cursor-default select-none text-lg font-semibold tracking-tight text-amber-200"
            >
              TAOS·LITE
            </h1>
            <div className="flex shrink-0 items-center gap-2">
              {/* Share: one icon-only button, no label — the point is to hand
                  the app to someone you just met without the translator screen
                  growing another pill. */}
              <button
                type="button"
                onClick={() => setShareOpen(true)}
                aria-label="Share TAOS / Compartir TAOS"
                title="Share TAOS · Compartir"
                className="flex h-11 w-11 items-center justify-center rounded-full border border-amber-300/30 bg-amber-400/10 text-amber-200 transition active:scale-95"
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-4 w-4"
                >
                  <circle cx="18" cy="5" r="3" />
                  <circle cx="6" cy="12" r="3" />
                  <circle cx="18" cy="19" r="3" />
                  <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
                </svg>
              </button>
              {/* THE LAUNCHER. Nine dots closed, an X open — the two glyphs are
                  stacked in one 16px box and cross-faded so the header cannot
                  reflow on the swap.

                  The trigger used to draw the signed-in email's first letter,
                  and on Tom's account (xdrabbit@) that letter is X — so the
                  button that OPENS the menu wore the universal symbol for
                  close/delete. Liz, launching the wave on 8/30: strangers read
                  it as "remove" and would not tap it. Any account whose email
                  starts with x, or with no letter at all, had the same problem.
                  The nine-dot grid is the affordance every phone already
                  teaches, and it is now telling the truth as well: what is
                  behind it really is a grid of apps.
                  tests/nav-menu-trigger.test.ts pins that this glyph is never
                  derived from the account. The AVATAR next to it is — that is
                  what an avatar is for, and it is not a disclosure triangle. */}
              <div ref={gridMenuRef}>
                <button
                  type="button"
                  onClick={() => {
                    setAccountMenuOpen(false);
                    setGridMenuOpen((o) => !o);
                  }}
                  aria-label={gridMenuOpen ? nav.navCloseMenu : nav.navAllScreens}
                  aria-haspopup="menu"
                  aria-expanded={gridMenuOpen}
                  title={gridMenuOpen ? nav.navCloseMenu : nav.navAllScreens}
                  className="flex h-11 w-11 items-center justify-center rounded-full border border-amber-300/30 bg-amber-400/10 text-amber-200 transition active:scale-95"
                >
                  <span className="relative block h-4 w-4">
                    {/* Nine dots, filled rather than stroked: at 16px a 2px
                        stroke on a 3px circle fills it in anyway, and dots read
                        as "apps" where nine tiny rings read as noise. */}
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      className={`absolute inset-0 h-4 w-4 transition-opacity duration-150 ${
                        gridMenuOpen ? "opacity-0" : "opacity-100"
                      }`}
                    >
                      <circle cx="5" cy="5" r="2" />
                      <circle cx="12" cy="5" r="2" />
                      <circle cx="19" cy="5" r="2" />
                      <circle cx="5" cy="12" r="2" />
                      <circle cx="12" cy="12" r="2" />
                      <circle cx="19" cy="12" r="2" />
                      <circle cx="5" cy="19" r="2" />
                      <circle cx="12" cy="19" r="2" />
                      <circle cx="19" cy="19" r="2" />
                    </svg>
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      className={`absolute inset-0 h-4 w-4 transition-opacity duration-150 ${
                        gridMenuOpen ? "opacity-100" : "opacity-0"
                      }`}
                    >
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </span>
                </button>
                {gridMenuOpen ? (
                  <div
                    role="menu"
                    aria-label={nav.navAllScreens}
                    className="absolute right-0 top-full z-20 mt-2 w-[17rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-amber-300/20 bg-[rgba(20,16,14,0.97)] shadow-[0_10px_34px_rgba(0,0,0,0.55)] backdrop-blur"
                  >
                    {/* Two columns on a phone, and every tile the same size —
                        auto-rows-fr, because without it a CSS grid sizes each
                        ROW to its own tallest tile and the labels do not wrap
                        evenly: measured 65.8px for the Live/Table row against
                        79.5px for Quick translate/Photo translator. Two tile
                        sizes in one grid is the thing that stops a grid of
                        icons reading as a grid.
                        max-h + scroll is the backstop for a founder's eleven
                        entries on a short screen — a launcher that runs off
                        the bottom is the same bug as one that runs off the
                        right, and this one has been made twice. */}
                    <div className="grid max-h-[min(28rem,calc(100vh-9rem))] grid-cols-2 auto-rows-fr gap-2 overflow-y-auto p-2">
                      {/* The screen you are standing on is IN here. A launcher
                          that omits the current app is a launcher with a hole
                          in it, and this is the only tile that ever carries
                          the current-page mark on the home screen. */}
                      <a
                        href="/"
                        role="menuitem"
                        aria-label={nav.navSpeak}
                        aria-current={pathname === "/" ? "page" : undefined}
                        className={`flex min-h-[44px] flex-col items-center justify-center gap-1.5 rounded-xl border px-2 py-3 text-center text-[11px] leading-tight transition hover:bg-amber-400/10 ${
                          pathname === "/"
                            ? "border-amber-300/50 bg-amber-400/15 text-amber-100"
                            : "border-white/10 bg-white/[0.03] text-amber-100/85"
                        }`}
                      >
                        <NavIcon name="speak" />
                        {nav.navSpeak}
                      </a>
                      <a
                        href="/translate"
                        role="menuitem"
                        aria-label={nav.navTranslate}
                        aria-current={pathname === "/translate" ? "page" : undefined}
                        className={`flex min-h-[44px] flex-col items-center justify-center gap-1.5 rounded-xl border px-2 py-3 text-center text-[11px] leading-tight transition hover:bg-amber-400/10 ${
                          pathname === "/translate"
                            ? "border-amber-300/50 bg-amber-400/15 text-amber-100"
                            : "border-white/10 bg-white/[0.03] text-amber-100/85"
                        }`}
                      >
                        <NavIcon name="translate" />
                        {nav.navTranslate}
                      </a>
                      <a
                        href="/live"
                        role="menuitem"
                        aria-label={nav.navLive}
                        aria-current={pathname === "/live" ? "page" : undefined}
                        className={`flex min-h-[44px] flex-col items-center justify-center gap-1.5 rounded-xl border px-2 py-3 text-center text-[11px] leading-tight transition hover:bg-amber-400/10 ${
                          pathname === "/live"
                            ? "border-amber-300/50 bg-amber-400/15 text-amber-100"
                            : "border-white/10 bg-white/[0.03] text-amber-100/85"
                        }`}
                      >
                        <NavIcon name="live" />
                        {nav.navLive}
                      </a>
                      <a
                        href="/tabletop"
                        role="menuitem"
                        aria-label={nav.navTable}
                        aria-current={pathname === "/tabletop" ? "page" : undefined}
                        className={`flex min-h-[44px] flex-col items-center justify-center gap-1.5 rounded-xl border px-2 py-3 text-center text-[11px] leading-tight transition hover:bg-amber-400/10 ${
                          pathname === "/tabletop"
                            ? "border-amber-300/50 bg-amber-400/15 text-amber-100"
                            : "border-white/10 bg-white/[0.03] text-amber-100/85"
                        }`}
                      >
                        <NavIcon name="table" />
                        {nav.navTable}
                      </a>
                      <a
                        href="/chat"
                        role="menuitem"
                        aria-label="Chat"
                        aria-current={pathname === "/chat" ? "page" : undefined}
                        className={`flex min-h-[44px] flex-col items-center justify-center gap-1.5 rounded-xl border px-2 py-3 text-center text-[11px] leading-tight transition hover:bg-amber-400/10 ${
                          pathname === "/chat"
                            ? "border-amber-300/50 bg-amber-400/15 text-amber-100"
                            : "border-white/10 bg-white/[0.03] text-amber-100/85"
                        }`}
                      >
                        <NavIcon name="chat" />
                        Chat
                      </a>
                      {/* Gated tiles carry the SAME guard as their pill and
                          their page — callVisibleTo(), fastVisibleTo(),
                          isFounder(), tutorEnabled(), studyEnabled() (lib/release.ts). The
                          redundancy between grid and pills is per-screen, so a
                          screen cannot half-appear: strip these blocks and what
                          is left is exactly a stranger's launcher.
                          tests/nav-completeness.test.ts strips them and checks. */}
                      {callVisible ? (
                        <a
                          href="/call"
                          role="menuitem"
                          aria-label={nav.navCall}
                          aria-current={pathname === "/call" ? "page" : undefined}
                          className={`flex min-h-[44px] flex-col items-center justify-center gap-1.5 rounded-xl border px-2 py-3 text-center text-[11px] leading-tight transition hover:bg-amber-400/10 ${
                            pathname === "/call"
                              ? "border-amber-300/50 bg-amber-400/15 text-amber-100"
                              : "border-white/10 bg-white/[0.03] text-amber-100/85"
                          }`}
                        >
                          <NavIcon name="call" />
                          {nav.navCall}
                        </a>
                      ) : null}
                      {fastVisible ? (
                        <a
                          href="/fast"
                          role="menuitem"
                          aria-label={nav.navFast}
                          aria-current={pathname === "/fast" ? "page" : undefined}
                          className={`flex min-h-[44px] flex-col items-center justify-center gap-1.5 rounded-xl border px-2 py-3 text-center text-[11px] leading-tight transition hover:bg-amber-400/10 ${
                            pathname === "/fast"
                              ? "border-amber-300/50 bg-amber-400/15 text-amber-100"
                              : "border-white/10 bg-white/[0.03] text-amber-100/85"
                          }`}
                        >
                          <NavIcon name="fast" />
                          {nav.navFast}
                        </a>
                      ) : null}
                      <a
                        href="/vision"
                        role="menuitem"
                        aria-label={nav.navPhoto}
                        aria-current={pathname === "/vision" ? "page" : undefined}
                        className={`flex min-h-[44px] flex-col items-center justify-center gap-1.5 rounded-xl border px-2 py-3 text-center text-[11px] leading-tight transition hover:bg-amber-400/10 ${
                          pathname === "/vision"
                            ? "border-amber-300/50 bg-amber-400/15 text-amber-100"
                            : "border-white/10 bg-white/[0.03] text-amber-100/85"
                        }`}
                      >
                        <NavIcon name="photo" />
                        {nav.navPhoto}
                      </a>
                      {founder ? (
                        <a
                          href="/video"
                          role="menuitem"
                          aria-label={nav.navVideo}
                          aria-current={pathname === "/video" ? "page" : undefined}
                          className={`flex min-h-[44px] flex-col items-center justify-center gap-1.5 rounded-xl border px-2 py-3 text-center text-[11px] leading-tight transition hover:bg-amber-400/10 ${
                            pathname === "/video"
                              ? "border-amber-300/50 bg-amber-400/15 text-amber-100"
                              : "border-white/10 bg-white/[0.03] text-amber-100/85"
                          }`}
                        >
                          <NavIcon name="video" />
                          {nav.navVideo}
                        </a>
                      ) : null}
                      {tutorEnabled() ? (
                        <a
                          href="/tutor"
                          role="menuitem"
                          aria-label={nav.navTutor}
                          aria-current={pathname === "/tutor" ? "page" : undefined}
                          className={`flex min-h-[44px] flex-col items-center justify-center gap-1.5 rounded-xl border px-2 py-3 text-center text-[11px] leading-tight transition hover:bg-amber-400/10 ${
                            pathname === "/tutor"
                              ? "border-amber-300/50 bg-amber-400/15 text-amber-100"
                              : "border-white/10 bg-white/[0.03] text-amber-100/85"
                          }`}
                        >
                          <NavIcon name="tutor" />
                          {nav.navTutor}
                        </a>
                      ) : null}
                      {/* Study is you and your own material, not a class — so it
                          is deliberately not the tutor and not behind the tutor's
                          flag (lib/release.ts). It arrived (#74) after this grid
                          was designed; nav-completeness caught the missing tile. */}
                      {studyEnabled() ? (
                        <a
                          href="/study"
                          role="menuitem"
                          aria-label={nav.navStudy}
                          aria-current={pathname === "/study" ? "page" : undefined}
                          className={`flex min-h-[44px] flex-col items-center justify-center gap-1.5 rounded-xl border px-2 py-3 text-center text-[11px] leading-tight transition hover:bg-amber-400/10 ${
                            pathname === "/study"
                              ? "border-amber-300/50 bg-amber-400/15 text-amber-100"
                              : "border-white/10 bg-white/[0.03] text-amber-100/85"
                          }`}
                        >
                          <NavIcon name="study" />
                          {nav.navStudy}
                        </a>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
              {/* YOU. Everything that is about the account rather than about
                  translating: who you are, what you have said, how the app
                  works, and the way out.

                  These four used to sit in the nine-dot menu underneath four
                  screens, which is how the guide ended up telling readers that
                  the PHOTO TRANSLATOR — a screen — lives in "the account menu".
                  Splitting them is the whole point of this change: a person
                  looking for Sign out and a person looking for what the app can
                  do are never the same person.

                  The initial is back, and only here. #45 took it OFF the
                  launcher because a trigger drawn from the email meant Tom's
                  said X and strangers read it as "close" — that reasoning is
                  about a DISCLOSURE wearing a dismissal glyph, and it still
                  holds for the nine dots. An avatar is supposed to be a
                  function of whose phone it is; that is the entire convention.
                  It never swaps to an X on open (it takes a ring instead), so
                  it is never asked to mean "close". */}
              <div ref={accountMenuRef}>
                <button
                  type="button"
                  onClick={() => {
                    setGridMenuOpen(false);
                    setAccountMenuOpen((o) => !o);
                  }}
                  aria-label={accountMenuOpen ? nav.navCloseMenu : nav.navAccount}
                  aria-haspopup="menu"
                  aria-expanded={accountMenuOpen}
                  title={accountMenuOpen ? nav.navCloseMenu : nav.navAccount}
                  className={`flex h-11 w-11 items-center justify-center rounded-full transition active:scale-95 ${
                    accountMenuOpen ? "ring-2 ring-amber-300/60" : ""
                  }`}
                >
                  {/* A SOLID DISC with dark type on it, not an outlined icon
                      button like the two beside it. That is the whole reason
                      Tom's "X" reads as a person here and read as a dismissal
                      on the launcher: a filled amber chip is the shape every
                      phone uses for "you", and it sits next to two hollow
                      amber rings that are obviously controls. The distinction
                      is carried by the SHAPE, so it survives whatever letter
                      the account happens to start with. */}
                  <span
                    aria-hidden="true"
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-amber-300 text-[13px] font-semibold text-stone-900"
                  >
                    {avatarInitial ?? (
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="h-4 w-4"
                      >
                        <circle cx="12" cy="8" r="3.5" />
                        <path d="M5 20a7 7 0 0114 0" />
                      </svg>
                    )}
                  </span>
                </button>
                {accountMenuOpen ? (
                  <div
                    role="menu"
                    aria-label={nav.navAccount}
                    className="absolute right-0 top-full z-20 mt-2 w-56 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-amber-300/20 bg-[rgba(20,16,14,0.97)] shadow-[0_10px_34px_rgba(0,0,0,0.55)] backdrop-blur"
                  >
                    {/* Who you are signed in as. This used to be the trigger's
                        `title`, which no phone has ever rendered — a tooltip
                        needs a mouse. Sign out sits at the bottom of this same
                        menu, so the account it signs out of belongs at the top
                        of it. */}
                    <p className="truncate px-4 py-2 text-[11px] text-amber-100/50">
                      {email}
                    </p>
                    <button
                      type="button"
                      role="menuitem"
                      aria-label={nav.navHistory}
                      onClick={() => {
                        setAccountMenuOpen(false);
                        setHistoryOpen(true);
                      }}
                      className="flex min-h-[44px] w-full items-center border-t border-white/10 px-4 py-2.5 text-left text-sm text-amber-100 transition hover:bg-amber-400/10"
                    >
                      {nav.navHistory}
                    </button>
                    {/* The quick start, for the person who installed TAOS at a
                        table and now wants to know what the other pills do. The
                        share sheet offers it to the person being handed the
                        app; this offers it to the person doing the handing. */}
                    <a
                      href="/guide"
                      role="menuitem"
                      aria-label={nav.navGuide}
                      className="flex min-h-[44px] w-full items-center border-t border-white/10 px-4 py-2.5 text-left text-sm text-amber-100 transition hover:bg-amber-400/10"
                    >
                      {nav.navGuide}
                    </a>
                    {/* /about is the product page a stranger reads after
                        scanning the QR — Landing.tsx links it, but Landing is
                        only ever shown to logged-OUT visitors, so signing in
                        used to be a one-way door away from it. */}
                    <a
                      href="/about"
                      role="menuitem"
                      aria-label={nav.navAbout}
                      className="flex min-h-[44px] w-full items-center border-t border-white/10 px-4 py-2.5 text-left text-sm text-amber-100 transition hover:bg-amber-400/10"
                    >
                      {nav.navAbout}
                    </a>
                    <button
                      type="button"
                      role="menuitem"
                      aria-label={nav.navSignOut}
                      onClick={() => {
                        setAccountMenuOpen(false);
                        onSignOut();
                      }}
                      className="flex min-h-[44px] w-full items-center border-t border-white/10 px-4 py-2.5 text-left text-sm text-amber-100/70 transition hover:bg-amber-400/10"
                    >
                      {nav.navSignOut}
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
          {/* ROW TWO: the verbs. Right-aligned, wrapping, 44px tall, and NOT A
              MENU ANYWHERE IN IT — every pill is one touch to a screen.

              Translate leads. It is the screen a stranger can be handed with
              no instructions at all (type, watch it come back), where every
              other pill needs a sentence of explanation first, so it is the
              one worth the leftmost, easiest reach.

              Call is a pill for founders and absent for everyone else, behind
              the same callVisibleTo() the page gate and POST /api/call/realtime
              ask — one question, three surfaces, so they cannot drift apart the
              way /tabletop's nav entry once did (lib/release.ts). It also
              appears in the grid, behind the same guard; that redundancy is on
              purpose and is per-screen, not per-menu.

              min-h-[44px] with inline-flex, not padding: min-height does
              nothing to an inline element. These were 48x30 until #54 — the row
              a thumb reaches for most, 14px under the floor. */}
          <nav aria-label={nav.navScreens} className="flex flex-wrap items-center justify-end gap-2">
            <a
              href="/translate"
              aria-label={nav.navTranslate}
              className="inline-flex min-h-[44px] items-center rounded-full border border-amber-300/30 bg-amber-400/10 px-3 py-1.5 text-xs text-amber-200"
            >
              {nav.navTranslate}
            </a>
            <a
              href="/live"
              aria-label={nav.navLive}
              className="inline-flex min-h-[44px] items-center rounded-full border border-amber-300/30 bg-amber-400/10 px-3 py-1.5 text-xs text-amber-200"
            >
              {nav.navLive}
            </a>
            <a
              href="/tabletop"
              aria-label={nav.navTable}
              className="inline-flex min-h-[44px] items-center rounded-full border border-amber-300/30 bg-amber-400/10 px-3 py-1.5 text-xs text-amber-200"
            >
              {nav.navTable}
            </a>
            <a
              href="/chat"
              aria-label="Chat"
              className="inline-flex min-h-[44px] items-center rounded-full border border-amber-300/30 bg-amber-400/10 px-3 py-1.5 text-xs text-amber-200"
            >
              Chat
            </a>
            {callVisible ? (
              <a
                href="/call"
                aria-label={nav.navCall}
                className="inline-flex min-h-[44px] items-center rounded-full border border-amber-300/30 bg-amber-400/10 px-3 py-1.5 text-xs text-amber-200"
              >
                {nav.navCall}
              </a>
            ) : null}
          </nav>
        </header>

        {/* One-time "add to home screen" nudge (hides itself once installed
            or dismissed). Inline, above the trial banner — never floating over
            the record button. */}
        <InstallPrompt copy={s} />

        {/* Free-trial allowance banner (hidden for subscribers) */}
        {!subscriber && Number.isFinite(transLeft) ? (
          <div
            className={`flex items-center justify-between rounded-2xl border px-4 py-2.5 text-sm ${
              trialBlocked
                ? "border-rose-400/30 bg-rose-500/10 text-rose-100"
                : "border-amber-300/20 bg-amber-400/5 text-amber-100/80"
            }`}
          >
            <span>
              {trialBlocked
                ? s.trialUsedUp
                : transLeft === 1
                  ? s.trialLeftOne
                  : fill(s.trialLeft, { count: transLeft })}
            </span>
            <button
              type="button"
              onClick={() => setShowPaywall(true)}
              className="rounded-full bg-amber-400 px-3 py-1 text-xs font-semibold text-stone-950"
            >
              {s.upgrade}
            </button>
          </div>
        ) : null}

        {/* Language pills — the OUTPUT language is the solid one; your own
            side wears an outline. Tap another language to translate into it,
            or tap your own side to flip the direction. The row holds the pair
            plus recents (max five, lib/translate/pinned.ts); "+" opens the
            search sheet for every other language TAOS knows. The row keeps its
            width no matter how big the catalog gets — which was Tom's
            constraint on 8/15 and is the only reason the catalog could grow.
            Drawn by components/LanguagePicker.tsx, the same row /live,
            /tabletop and /chat put on screen. */}
        <LanguagePillRow
          pills={pills}
          selected={output}
          paired={mine}
          caption={s.translateInto}
          labels={s}
          sheetOpen={sheetOpen}
          onSelect={selectLanguage}
          onOpenSheet={() => setSheetOpen(true)}
        />

        {/* Who is speaking — manual swap card, or an Auto-detect indicator */}
        {autoDetect ? (
          <div className="flex items-center justify-between rounded-3xl border border-amber-300/20 bg-amber-400/5 p-4">
            <div>
              <div className="text-xs uppercase tracking-[0.2em] text-amber-100/50">
                {s.autoDetect}
              </div>
              <div className="text-2xl font-semibold text-white">
                {/* The language, never a name — see speakerFor above. */}
                {status === "done"
                  ? speaker.label
                  : `${pair[0].toUpperCase()} ⇄ ${pair[1].toUpperCase()}`}
              </div>
            </div>
            <span className="text-2xl text-amber-300">✨</span>
          </div>
        ) : (
          <button
            onClick={swap}
            type="button"
            className="flex items-center justify-between rounded-3xl border border-white/10 bg-[rgba(36,30,24,0.8)] p-4 text-left transition active:scale-[0.99]"
          >
            <div>
              <div className="text-xs uppercase tracking-[0.2em] text-amber-100/50">
                {s.speakingNow}
              </div>
              <div className="text-2xl font-semibold text-white">{speaker.label}</div>
            </div>
            <div className="flex flex-col items-center gap-1 text-amber-300">
              <span className="text-2xl">⇄</span>
              <span className="text-[10px] uppercase tracking-wider text-amber-100/50">{s.swap}</span>
            </div>
          </button>
        )}

        {/* Result — header in the owner's language */}
        <section className="flex flex-1 flex-col gap-3">
          <div className="flex min-h-[34vh] flex-1 flex-col rounded-3xl border border-white/10 bg-[rgba(18,44,36,0.7)] p-5">
            <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-[0.18em] text-emerald-100/50">
              {/* Neutral: "Translation · English", never "For <name>". The
                  word is the owner's, like the rest of the screen; the
                  language name after it is the listener's, in their own
                  script, so the person across the table still finds it.
                  Only once there IS a translation (Tom, 2026-10-04): over the
                  idle hint it named a language above a placeholder written
                  in a different one, which read as a broken screen. */}
              {translation ? (
                <span>
                  {s.translationLabel} · {listener.label}
                </span>
              ) : null}
              {translation ? (
                <div className="flex items-center gap-2">
                  {!autoDetect ? (
                    <button
                      type="button"
                      onClick={flipLast}
                      disabled={processing}
                      title={s.flipTitle}
                      aria-label={s.flipAria}
                      className="flex items-center gap-1 rounded-full border border-amber-300/30 bg-amber-400/10 px-3 py-1 text-amber-200 transition disabled:opacity-50"
                    >
                      <span className="text-base">⇄</span>
                      <span className="text-[11px]">{s.flip}</span>
                    </button>
                  ) : null}
                  {textOnlyTarget ? (
                    // No Play button rather than a dead one: a control that
                    // does nothing when tapped is worse than no control.
                    <TextOnlyNote />
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        blessAudio();
                        void speak(translation);
                      }}
                      className={`flex items-center gap-1 rounded-full border border-white/10 px-3 py-1 text-emerald-100 transition ${
                        isSpeaking ? "bg-emerald-400/30" : "bg-white/5"
                      }`}
                      aria-label={s.playAria}
                    >
                      <span className="text-base">{isSpeaking ? "🔊" : "🔈"}</span>
                      <span className="text-[11px]">{s.play}</span>
                    </button>
                  )}
                </div>
              ) : null}
            </div>
            <div className="flex flex-1 items-center">
              <p className="text-pretty text-[clamp(1.8rem,7vw,2.8rem)] font-semibold leading-tight tracking-tight text-white">
                {translation || (processing ? s.translating : recording ? s.listening : s.idle)}
              </p>
            </div>
            {original ? (
              <p className="mt-4 border-t border-white/10 pt-3 text-sm text-emerald-50/55">
                <span className="uppercase tracking-wider text-emerald-100/40">{s.heard}:</span>{" "}
                {original}
              </p>
            ) : null}
          </div>

          {error ? (
            <p className="rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
              {error}
            </p>
          ) : null}
        </section>

        {/* Controls */}
        <section className="flex flex-col gap-3 rounded-3xl border border-white/10 bg-[rgba(20,16,14,0.86)] p-4">
          <button
            ref={recordBtnRef}
            type="button"
            onClick={toggleRecord}
            disabled={processing || trialBlocked}
            className={`flex h-20 items-center justify-center gap-3 rounded-2xl text-xl font-semibold transition active:scale-[0.99] disabled:opacity-60 ${
              recording
                ? `bg-amber-400 text-stone-950 shadow-[0_0_34px_rgba(251,191,36,0.6)] ${
                    wrappingUp ? "" : "animate-pulse"
                  }`
                : "border border-amber-300/30 bg-stone-50 text-stone-900 hover:bg-white"
            }`}
          >
            <span
              className={`inline-block rounded-[6px] ${
                recording ? "h-5 w-5 bg-stone-900/85" : "h-6 w-6 bg-amber-500"
              }`}
            />
            {recording
              ? s.stop
              : processing
                ? s.working
                : autoDetect
                  ? speakPrompt(pair)
                  : `${s.speak} ${speaker.label}`}
          </button>

          {wrappingUp && recording ? (
            <p role="status" aria-live="polite" className="text-center text-sm text-amber-300">
              {s.wrapUp}
            </p>
          ) : null}

          <label className="flex items-center gap-2 text-sm text-amber-100/70">
            <input
              type="checkbox"
              checked={autoDetect}
              onChange={(e) => setAutoDetect(e.target.checked)}
              className="h-4 w-4 accent-amber-400"
            />
            {s.autoDetectLanguage}
          </label>

          <label className="flex items-center gap-2 text-sm text-amber-100/70">
            <input
              type="checkbox"
              checked={autoPlay}
              onChange={(e) => setAutoPlay(e.target.checked)}
              className="h-4 w-4 accent-amber-400"
            />
            {s.autoPlayVoice}
          </label>

          {/* The voice engine gets its own row since 10/06: three pills beside
              the auto-play label overflow a phone, and an overflowing row is
              what ate taps in PR #53. */}
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="shrink-0 text-amber-100/70">{s.voiceEngine}</span>
            <div className="grid min-w-0 flex-1 grid-cols-3 gap-1 rounded-full border border-white/10 bg-white/5 p-1">
              {/* Premium engines greyed (not hidden) for free-tier beta testers —
                  visible as a premium voice tier, unreachable as a cost. */}
              {(["elevenlabs", "fishaudio", "openai"] as Engine[]).map((eng) => {
                const locked = eng !== "openai" && !subscriber;
                return (
                  <button
                    key={eng}
                    type="button"
                    disabled={locked}
                    title={locked ? s.premiumVoices : undefined}
                    onClick={() => {
                      engineTouchedRef.current = true;
                      setEngine(eng);
                    }}
                    className={`truncate rounded-full px-2 py-1 text-xs font-medium transition ${
                      engine === eng
                        ? "bg-amber-400 text-stone-950"
                        : locked
                          ? "cursor-not-allowed text-amber-100/25"
                          : "text-amber-100/60"
                    }`}
                  >
                    {ENGINE_LABEL[eng]}
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        <p className="pt-1 text-center text-[10px] tracking-wider text-amber-100/25">{BUILD_LABEL}</p>
      </div>

      <HistoryDrawer open={historyOpen} onClose={() => setHistoryOpen(false)} />
      <LanguageSheet
        open={sheetOpen}
        selected={output}
        paired={mine}
        pairedLabel={s.yours}
        caption={s.translateInto}
        labels={s}
        onSelect={selectLanguage}
        onClose={() => setSheetOpen(false)}
      />

      <QrShareModal open={shareOpen} onClose={() => setShareOpen(false)} />
      <PersonalVoiceModal
        open={personalVoiceOpen}
        onClose={() => setPersonalVoiceOpen(false)}
      />
    </main>
  );
}
