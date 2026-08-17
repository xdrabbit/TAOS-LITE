"use client";

import { useEffect, useRef, useState } from "react";
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
import { Paywall } from "./Paywall";
import { fetchWithRetry, isConnectionError } from "@/lib/net";
import { createWakeLockHold, type WakeLockHold } from "@/lib/wakeLock";

type LangCode = "en" | "es" | "zh" | "yue";
type Engine = "elevenlabs" | "openai";
type Status = "idle" | "recording" | "processing" | "done" | "error";

interface Speaker {
  code: LangCode;
  who: string;
  label: string; // language name in its own language
}

const SPEAKERS: Record<LangCode, Speaker> = {
  es: { code: "es", who: "Liz", label: "Español" },
  en: { code: "en", who: "Tom", label: "English" },
  // Mandarin/Cantonese speakers are guests, not named members of the household.
  zh: { code: "zh", who: "Guest", label: "中文" },
  yue: { code: "yue", who: "Guest", label: "廣東話" }
};

// ── Conversation language pairs ─────────────────────────────────────────────
// Phase 1 of multi-language: /translate operates on a language PAIR. The
// picker stacks pairs most-recently-used first (persisted) so the daily pair
// stays one tap away. To add a pair: add its languages to SPEAKERS + STRINGS,
// then list it here — the server already supports 12 languages.
const PAIRS: ReadonlyArray<readonly [LangCode, LangCode]> = [
  ["en", "es"],
  ["en", "zh"],
  ["es", "zh"],
  // 7/25 Yellowstone promise: the Cantonese/Mandarin guests' own pair, plus
  // English for talking with them.
  ["zh", "yue"],
  ["en", "yue"]
];
const pairKey = (p: readonly [LangCode, LangCode]): string => `${p[0]}-${p[1]}`;
// Tom's 8/15 call: the picker is TWO buttons — EN⇄ES (the daily pair) and
// "Other · Otros" holding every remaining pair. EN⇄ES never hides behind the
// menu, and the guest pairs stop crowding the top of the screen.
const HOME_PAIR = PAIRS[0];
const PAIR_ORDER_STORAGE_KEY = "taos.translate.pairOrder";

// Unobtrusive build marker so we can tell which deploy is live. Vercel injects
// the commit SHA at build time; falls back to "local" during dev.
const APP_VERSION = "0.4";
const BUILD_SHA = (process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7);
const BUILD_LABEL = `v${APP_VERSION}${BUILD_SHA ? ` · ${BUILD_SHA}` : " · local"}`;

// Speaker-facing copy flips to whoever is talking (Tom = en, Liz = es) so each
// person reads the controls they act on in their own language.
const STRINGS: Record<
  LangCode,
  {
    speak: string;
    stop: string;
    working: string;
    speakingNow: string;
    swap: string;
    listening: string;
    translating: string;
    idle: string;
    heard: string;
    translationLabel: string;
    wrapUp: string;
    micUnavailable: string;
    micDenied: string;
    ttsFailed: string;
    translateFailed: string;
    connectionLost: string;
    noAudio: string;
    tooShort: string;
  }
> = {
  en: {
    speak: "Speak",
    stop: "Stop & Translate",
    working: "Working…",
    speakingNow: "Speaking now",
    swap: "Swap",
    listening: "Listening…",
    translating: "Translating…",
    idle: "Tap the mic, speak a full thought, tap again.",
    heard: "Heard",
    translationLabel: "Translation",
    wrapUp: "Wrapping up — auto stop & translate in a few seconds…",
    micUnavailable: "Microphone not available. Open this page over HTTPS in Safari and allow mic access.",
    micDenied: "Microphone permission was denied. Enable it in Safari settings and retry.",
    ttsFailed: "Voice playback failed.",
    translateFailed: "Translation failed.",
    connectionLost: "Connection problem — check your signal and try again.",
    noAudio: "No audio was captured. Check the mic and try again.",
    tooShort: "Too short — tap, say a full thought, then tap again."
  },
  es: {
    speak: "Hablar",
    stop: "Detener y traducir",
    working: "Procesando…",
    speakingNow: "Hablando ahora",
    swap: "Cambiar",
    listening: "Escuchando…",
    translating: "Traduciendo…",
    idle: "Toca el micrófono, di una idea completa y toca otra vez.",
    heard: "Se escuchó",
    translationLabel: "Traducción",
    wrapUp: "Terminando — se detiene y traduce en unos segundos…",
    micUnavailable: "Micrófono no disponible. Abre esta página con HTTPS en Safari y permite el micrófono.",
    micDenied: "Se denegó el permiso del micrófono. Actívalo en los ajustes de Safari e inténtalo de nuevo.",
    ttsFailed: "No se pudo reproducir la voz.",
    translateFailed: "No se pudo traducir.",
    connectionLost: "Problema de conexión — revisa tu señal e inténtalo de nuevo.",
    noAudio: "No se captó audio. Revisa el micrófono e inténtalo de nuevo.",
    tooShort: "Muy corto — toca, di una idea completa y toca otra vez."
  },
  zh: {
    speak: "说话",
    stop: "停止并翻译",
    working: "处理中…",
    speakingNow: "正在说话",
    swap: "切换",
    listening: "正在听…",
    translating: "翻译中…",
    idle: "点击麦克风，说完整的一句话，再点一次。",
    heard: "听到",
    translationLabel: "翻译",
    wrapUp: "即将结束 — 几秒后自动停止并翻译…",
    micUnavailable: "麦克风不可用。请在 Safari 中通过 HTTPS 打开此页面并允许使用麦克风。",
    micDenied: "麦克风权限被拒绝。请在 Safari 设置中开启后重试。",
    ttsFailed: "语音播放失败。",
    translateFailed: "翻译失败。",
    connectionLost: "网络连接问题 — 请检查信号后重试。",
    noAudio: "没有录到声音。请检查麦克风后重试。",
    tooShort: "太短了 — 点击，说完整的一句话，再点一次。"
  },
  yue: {
    speak: "講嘢",
    stop: "停低並翻譯",
    working: "處理緊…",
    speakingNow: "而家講緊",
    swap: "轉換",
    listening: "聽緊…",
    translating: "翻譯緊…",
    idle: "撳一下咪高峰，講完一句嘢，再撳一下。",
    heard: "聽到",
    translationLabel: "翻譯",
    wrapUp: "就快完 — 幾秒後自動停低並翻譯…",
    micUnavailable: "用唔到咪高峰。請喺 Safari 用 HTTPS 開呢頁，並允許使用咪高峰。",
    micDenied: "咪高峰權限被拒。請喺 Safari 設定入面開返，再試多次。",
    ttsFailed: "播唔到語音。",
    translateFailed: "翻譯唔到。",
    connectionLost: "網絡有問題 — 檢查吓訊號再試多次。",
    noAudio: "錄唔到聲。檢查吓咪高峰再試多次。",
    tooShort: "太短喇 — 撳一下，講完一句嘢，再撳一下。"
  }
};

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
  const [pair, setPair] = useState<readonly [LangCode, LangCode]>(PAIRS[0]);
  const [pairOrder, setPairOrder] = useState<string[]>(() => PAIRS.map(pairKey));
  const [otherOpen, setOtherOpen] = useState(false);
  // Beta (7/27): ElevenLabs cloned voices are for subscribers (Tom, Liz);
  // free-tier beta testers get OpenAI only — ElevenLabs is priced per
  // character and a fleet of testers would run up real cost. Default is
  // openai so a free user never touches ElevenLabs even during the
  // profile-load window; a subscriber's default upgrades once the profile
  // resolves (unless they already tapped the toggle themselves).
  const [engine, setEngine] = useState<Engine>("openai");
  const engineTouchedRef = useRef(false);
  useEffect(() => {
    if (subscriber && !engineTouchedRef.current) setEngine("elevenlabs");
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
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [togetherMenuOpen, setTogetherMenuOpen] = useState(false);

  // Avatar initial derived from the signed-in email (the only identity the
  // component receives — Profile has no name field). Falls back to a generic
  // user icon when the email yields no alphanumeric character.
  const avatarInitial = (email.match(/[a-z0-9]/i)?.[0] ?? "").toUpperCase();
  const accountMenuRef = useRef<HTMLDivElement | null>(null);
  const togetherMenuRef = useRef<HTMLDivElement | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef<string>("");
  const lastBlobRef = useRef<Blob | null>(null);
  const lastMimeRef = useRef<string>("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const wakeHoldRef = useRef<WakeLockHold | null>(null);
  const maxStopTimerRef = useRef<number | null>(null);
  // Visual ramp state (drives the record button directly, no re-render per frame).
  const recordBtnRef = useRef<HTMLButtonElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const recordStartRef = useRef<number>(0);
  const pulsePhaseRef = useRef<number>(0);
  const lastTickRef = useRef<number>(0);

  const target: LangCode = source === pair[0] ? pair[1] : pair[0];
  const speaker = SPEAKERS[source];
  const listener = SPEAKERS[target];
  const s = STRINGS[source]; // speaker-facing copy (active speaker's language)
  const orderedPairs = pairOrder
    .map((k) => PAIRS.find((p) => pairKey(p) === k))
    .filter((p): p is (typeof PAIRS)[number] => Boolean(p));

  // Restore the most-recently-used pair order (and start on the top pair).
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(PAIR_ORDER_STORAGE_KEY);
      if (!saved) return;
      const stored = (JSON.parse(saved) as string[]).filter((k) =>
        PAIRS.some((p) => pairKey(p) === k)
      );
      if (!stored.length) return;
      const rest = PAIRS.map(pairKey).filter((k) => !stored.includes(k));
      setPairOrder([...stored, ...rest]);
      const top = PAIRS.find((p) => pairKey(p) === stored[0]);
      if (top) {
        setPair(top);
        setSource((prev) => (prev === top[0] || prev === top[1] ? prev : top[0]));
      }
    } catch {
      /* corrupt storage — keep defaults */
    }
  }, []);

  function selectPair(p: readonly [LangCode, LangCode]) {
    setPair(p);
    setOtherOpen(false);
    setSource((prev) => (prev === p[0] || prev === p[1] ? prev : p[0]));
    setOriginal("");
    setTranslation("");
    setError(null);
    if (status !== "recording") setStatus("idle");
    setPairOrder((prev) => {
      const k = pairKey(p);
      const next = [k, ...prev.filter((x) => x !== k)];
      try {
        window.localStorage.setItem(PAIR_ORDER_STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* private mode — MRU just won't persist */
      }
      return next;
    });
  }

  useEffect(() => {
    return () => {
      clearRecordingTimers();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The screen must never sleep mid-dictation. Held for the whole time this
  // page is open, via the shared holder in lib/wakeLock.ts — which, unlike
  // the old inline pattern (8/2 field report: screens still slept mid-turn),
  // also listens for the sentinel's "release" event: iOS drops the lock
  // WITHOUT a visibilitychange under Low Power Mode / pressure, and only
  // that event says so. startRecording() calls ensure() too, so a previously
  // denied lock gets retried inside a user gesture.
  useEffect(() => {
    const hold = createWakeLockHold(() => true);
    wakeHoldRef.current = hold;
    hold.ensure();
    return () => {
      wakeHoldRef.current = null;
      hold.stop();
    };
  }, []);

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

  // Close the account menu on outside pointer press or Escape. Only wired while
  // the menu is open so there's no idle global listener.
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

  // Same close-on-outside/Escape behavior for the Together (Call/Chat/Table)
  // menu — the header collapsed those pills into one so it fits a phone width.
  useEffect(() => {
    if (!togetherMenuOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (togetherMenuRef.current && !togetherMenuRef.current.contains(e.target as Node)) {
        setTogetherMenuOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setTogetherMenuOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [togetherMenuOpen]);

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
    const a = ensureAudioEl();
    if (!a) return;
    try {
      setIsSpeaking(true);
      const res = await fetchWithRetry(
        "/api/tts",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, engine, sourceLanguage: src, targetLanguage: tgt })
        },
        { retries: 2, timeoutMs: 60000 }
      );
      if (!res.ok) {
        const p = (await res.json().catch(() => ({}))) as { error?: string; details?: string };
        throw new Error(p.details || p.error || s.ttsFailed);
      }
      const blob = await res.blob();
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
    // Re-assert the wake lock inside the tap gesture: if the page-lifetime
    // acquire was denied (Low Power Mode) or silently dropped, the start of a
    // recording is the moment that matters — and the best context to ask in.
    wakeHoldRef.current?.ensure();

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
        { method: "POST", body: form },
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
        void saveTranslation({
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
        currentTier={getTier(profile)}
        onClose={() => setShowPaywall(false)}
        onSignOut={onSignOut}
      />
    );
  }

  return (
    <main className="min-h-screen px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-[calc(env(safe-area-inset-top)+1rem)]">
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-md flex-col gap-4">
        <header className="flex items-center justify-between gap-2">
          <h1 className="text-lg font-semibold tracking-tight text-amber-200">TAOS·LITE</h1>
          <div className="flex items-center gap-2">
            <a
              href="/live"
              className="rounded-full border border-amber-300/30 bg-amber-400/10 px-3 py-1.5 text-xs text-amber-200"
            >
              Live
            </a>
            {/* Call / Chat / Table stacked under one pill — six pills overflowed
                a phone width and made the whole page slide sideways. */}
            <div ref={togetherMenuRef} className="relative">
              <button
                type="button"
                onClick={() => setTogetherMenuOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={togetherMenuOpen}
                className="rounded-full border border-amber-300/30 bg-amber-400/10 px-3 py-1.5 text-xs text-amber-200"
              >
                Together ▾
              </button>
              {togetherMenuOpen ? (
                <div
                  role="menu"
                  aria-label="Together"
                  className="absolute right-0 top-full z-20 mt-2 w-44 overflow-hidden rounded-2xl border border-amber-300/20 bg-[rgba(20,16,14,0.97)] shadow-[0_10px_34px_rgba(0,0,0,0.55)] backdrop-blur"
                >
                  <a
                    href="/call"
                    role="menuitem"
                    className="block w-full px-4 py-2.5 text-left text-sm text-amber-100 transition hover:bg-amber-400/10"
                  >
                    Call · Llamada
                  </a>
                  <a
                    href="/chat"
                    role="menuitem"
                    className="block w-full border-t border-white/10 px-4 py-2.5 text-left text-sm text-amber-100 transition hover:bg-amber-400/10"
                  >
                    Chat · Chat
                  </a>
                  <a
                    href="/tabletop"
                    role="menuitem"
                    className="block w-full border-t border-white/10 px-4 py-2.5 text-left text-sm text-amber-100 transition hover:bg-amber-400/10"
                  >
                    Table · Mesa
                  </a>
                </div>
              ) : null}
            </div>
            <a
              href="/translate"
              className="rounded-full border border-amber-300/30 bg-amber-400/10 px-3 py-1.5 text-xs text-amber-200"
            >
              Translate
            </a>
            {/* Tutor lives in the avatar menu (with History) — Tom, 7/27:
                one fewer pill keeps the header from crowding phone widths. */}
            <div ref={accountMenuRef} className="relative">
              <button
                type="button"
                onClick={() => setAccountMenuOpen((o) => !o)}
                aria-label="Account menu"
                aria-haspopup="menu"
                aria-expanded={accountMenuOpen}
                title={email}
                className="flex h-8 w-8 items-center justify-center rounded-full border border-amber-300/30 bg-amber-400/10 text-xs font-semibold text-amber-200 transition active:scale-95"
              >
                {avatarInitial || (
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="h-4 w-4"
                  >
                    <circle cx="12" cy="8" r="4" />
                    <path d="M4 21c0-4 3.5-6 8-6s8 2 8 6" strokeLinecap="round" />
                  </svg>
                )}
              </button>
              {accountMenuOpen ? (
                <div
                  role="menu"
                  aria-label="Account"
                  className="absolute right-0 top-full z-20 mt-2 w-48 overflow-hidden rounded-2xl border border-amber-300/20 bg-[rgba(20,16,14,0.97)] shadow-[0_10px_34px_rgba(0,0,0,0.55)] backdrop-blur"
                >
                  <a
                    href="/tutor"
                    role="menuitem"
                    className="block w-full px-4 py-2.5 text-left text-sm text-amber-100 transition hover:bg-amber-400/10"
                  >
                    Tutor
                  </a>
                  {/* Video joins Tutor here rather than as a header pill —
                      same phone-width rationale (Tom, 7/27). */}
                  <a
                    href="/video"
                    role="menuitem"
                    className="block w-full border-t border-white/10 px-4 py-2.5 text-left text-sm text-amber-100 transition hover:bg-amber-400/10"
                  >
                    Video captions · Subtítulos
                  </a>
                  <a
                    href="/vision"
                    role="menuitem"
                    className="block w-full border-t border-white/10 px-4 py-2.5 text-left text-sm text-amber-100 transition hover:bg-amber-400/10"
                  >
                    Photo translator · Fotos
                  </a>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setAccountMenuOpen(false);
                      setHistoryOpen(true);
                    }}
                    className="block w-full border-t border-white/10 px-4 py-2.5 text-left text-sm text-amber-100 transition hover:bg-amber-400/10"
                  >
                    History · Historial
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setAccountMenuOpen(false);
                      onSignOut();
                    }}
                    className="block w-full border-t border-white/10 px-4 py-2.5 text-left text-sm text-amber-100/70 transition hover:bg-amber-400/10"
                  >
                    Sign out · Salir
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </header>

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
                ? "Free translations used up this month"
                : `Free · ${transLeft} translation${transLeft === 1 ? "" : "s"} left this month`}
            </span>
            <button
              type="button"
              onClick={() => setShowPaywall(true)}
              className="rounded-full bg-amber-400 px-3 py-1 text-xs font-semibold text-stone-950"
            >
              Upgrade
            </button>
          </div>
        ) : null}

        {/* Language pair picker — EN⇄ES plus one "Other" button (Tom, 8/15).
            When a guest pair is active, the Other button wears its label so
            the current pair is always visible. The expanded list keeps
            most-recently-used order. */}
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => selectPair(HOME_PAIR)}
              className={`rounded-full border px-3.5 py-1.5 text-xs font-semibold uppercase tracking-wide transition active:scale-95 ${
                pairKey(pair) === pairKey(HOME_PAIR)
                  ? "border-amber-300 bg-amber-400 text-stone-950"
                  : "border-amber-300/30 bg-amber-400/10 text-amber-200"
              }`}
            >
              {HOME_PAIR[0].toUpperCase()} ⇄ {HOME_PAIR[1].toUpperCase()}
            </button>
            <button
              type="button"
              onClick={() => setOtherOpen((o) => !o)}
              className={`rounded-full border px-3.5 py-1.5 text-xs font-semibold uppercase tracking-wide transition active:scale-95 ${
                pairKey(pair) !== pairKey(HOME_PAIR)
                  ? "border-amber-300 bg-amber-400 text-stone-950"
                  : "border-amber-300/30 bg-amber-400/10 text-amber-200"
              }`}
            >
              {pairKey(pair) !== pairKey(HOME_PAIR)
                ? `${pair[0].toUpperCase()} ⇄ ${pair[1].toUpperCase()}`
                : "Other · Otros"}{" "}
              {otherOpen ? "▴" : "▾"}
            </button>
          </div>
          {otherOpen ? (
            <div className="flex flex-wrap gap-2">
              {orderedPairs
                .filter((p) => pairKey(p) !== pairKey(HOME_PAIR))
                .map((p) => {
                  const active = pairKey(p) === pairKey(pair);
                  return (
                    <button
                      key={pairKey(p)}
                      type="button"
                      onClick={() => selectPair(p)}
                      className={`rounded-full border px-3.5 py-1.5 text-xs font-semibold uppercase tracking-wide transition active:scale-95 ${
                        active
                          ? "border-amber-300 bg-amber-400 text-stone-950"
                          : "border-amber-300/30 bg-amber-400/10 text-amber-200"
                      }`}
                    >
                      {p[0].toUpperCase()} ⇄ {p[1].toUpperCase()}
                    </button>
                  );
                })}
            </div>
          ) : null}
        </div>

        {/* Who is speaking — manual swap card, or an Auto-detect indicator */}
        {autoDetect ? (
          <div className="flex items-center justify-between rounded-3xl border border-amber-300/20 bg-amber-400/5 p-4">
            <div>
              <div className="text-xs uppercase tracking-[0.2em] text-amber-100/50">
                Auto-detect · Detección automática
              </div>
              <div className="text-2xl font-semibold text-white">
                {/* Names are the household's UX; beta testers see just the
                    language (they are not Tom or Liz). */}
                {status === "done"
                  ? subscriber
                    ? `${speaker.who} · ${speaker.label}`
                    : speaker.label
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
              <div className="text-2xl font-semibold text-white">
                {subscriber ? `${speaker.who} · ${speaker.label}` : speaker.label}
              </div>
            </div>
            <div className="flex flex-col items-center gap-1 text-amber-300">
              <span className="text-2xl">⇄</span>
              <span className="text-[10px] uppercase tracking-wider text-amber-100/50">{s.swap}</span>
            </div>
          </button>
        )}

        {/* Result — header in the listener's language */}
        <section className="flex flex-1 flex-col gap-3">
          <div className="flex min-h-[34vh] flex-1 flex-col rounded-3xl border border-white/10 bg-[rgba(18,44,36,0.7)] p-5">
            <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-[0.18em] text-emerald-100/50">
              <span>
                {/* Neutral for the beta: "Translation · English", not "For Tom"
                    — testers aren't Tom or Liz (7/27). Written in the
                    LISTENER's language like before. */}
                {STRINGS[target].translationLabel} · {listener.label}
              </span>
              {translation ? (
                <div className="flex items-center gap-2">
                  {!autoDetect ? (
                    <button
                      type="button"
                      onClick={flipLast}
                      disabled={processing}
                      title="Wrong direction? Re-translate the same recording the other way"
                      aria-label="Flip direction / Voltear"
                      className="flex items-center gap-1 rounded-full border border-amber-300/30 bg-amber-400/10 px-3 py-1 text-amber-200 transition disabled:opacity-50"
                    >
                      <span className="text-base">⇄</span>
                      <span className="text-[11px]">Flip · Voltear</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      blessAudio();
                      void speak(translation);
                    }}
                    className={`flex items-center gap-1 rounded-full border border-white/10 px-3 py-1 text-emerald-100 transition ${
                      isSpeaking ? "bg-emerald-400/30" : "bg-white/5"
                    }`}
                    aria-label="Play translation / Reproducir traducción"
                  >
                    <span className="text-base">{isSpeaking ? "🔊" : "🔈"}</span>
                    <span className="text-[11px]">Play · Oír</span>
                  </button>
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
                  ? `${STRINGS[pair[0]].speak} · ${STRINGS[pair[1]].speak}`
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
            Auto-detect language · Detectar idioma
          </label>

          <div className="flex items-center justify-between gap-3 text-sm">
            <label className="flex items-center gap-2 text-amber-100/70">
              <input
                type="checkbox"
                checked={autoPlay}
                onChange={(e) => setAutoPlay(e.target.checked)}
                className="h-4 w-4 accent-amber-400"
              />
              Auto-play voice · Reproducir voz
            </label>
            <div className="flex items-center gap-1 rounded-full border border-white/10 bg-white/5 p-1">
              {/* ElevenLabs greyed (not hidden) for free-tier beta testers —
                  visible as a premium voice tier, unreachable as a cost. */}
              {(["elevenlabs", "openai"] as Engine[]).map((eng) => {
                const locked = eng === "elevenlabs" && !subscriber;
                return (
                  <button
                    key={eng}
                    type="button"
                    disabled={locked}
                    title={locked ? "Premium voices · Voces premium" : undefined}
                    onClick={() => {
                      engineTouchedRef.current = true;
                      setEngine(eng);
                    }}
                    className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                      engine === eng
                        ? "bg-amber-400 text-stone-950"
                        : locked
                          ? "cursor-not-allowed text-amber-100/25"
                          : "text-amber-100/60"
                    }`}
                  >
                    {eng === "elevenlabs" ? "ElevenLabs" : "OpenAI"}
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        <p className="pt-1 text-center text-[10px] tracking-wider text-amber-100/25">{BUILD_LABEL}</p>
      </div>

      <HistoryDrawer open={historyOpen} onClose={() => setHistoryOpen(false)} />
    </main>
  );
}
