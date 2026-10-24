"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authHeaders, jsonAuthHeaders } from "@/lib/authClient";
import { copyFor, fill } from "@/lib/chrome/copy";
import { canSpeak, languageFlag, languageLabel, languageNative } from "@/lib/languages/catalog";
import { useLanguagePair } from "@/lib/translate/useLanguagePair";
import { shareAudioFile } from "@/lib/tts/shareAudio";
import { TEXT_ONLY_TITLE } from "@/lib/tts/speech";
import {
  DEMO_MAX_LINES,
  DEMO_MAX_SAMPLE_SECONDS,
  DEMO_MIN_SAMPLE_SECONDS,
  demoShareFileName
} from "@/lib/demo/limits";
import { ExitHome } from "@/components/ExitHome";
import { LanguagePillRow, LanguageSheet } from "@/components/LanguagePicker";

// ── /demo — "Tu voz" ───────────────────────────────────────────────────────
// Four screens on one phone, held by a founder, facing a stranger:
//
//   1. consent + record — the consent line is tapped BEFORE the mic opens;
//      10 s minimum, 90 s maximum, a prompt to talk about their day
//   2. clone            — /api/demo/clone, "creating your voice"
//   3. reveal           — the founder says or types a line; it is translated
//                         and spoken in the stranger's clone (≤ 3 lines)
//   4. share + done     — the home screen's share path; "Done" deletes
//
// The voice id lives in this component's state and nowhere else on the
// client. It is deleted by "Done", by a beacon on page unload, and — if both
// of those miss — by the server's ten-minute sweep (lib/demo/server.ts).

type Stage = "consent" | "recording" | "cloning" | "reveal" | "ended";

interface DemoVoice {
  voiceId: string;
  token: string;
  expiresAt: number;
}

/** Same candidates as the home screen; opus first, AAC for iOS. */
function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const c of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac"]) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return "";
}

function fileNameFor(mime: string, stem: string): string {
  return mime.includes("mp4") || mime.includes("aac") ? `${stem}.mp4` : `${stem}.webm`;
}

/** Twice the home screen's bitrate: this recording becomes a voice. ~720 KB at 90 s. */
const SAMPLE_BITS_PER_SECOND = 64000;
/** The "creating your voice" beat is part of the show; never shorter than this. */
const MIN_CREATING_MS = 3000;
/** The founder's own line: a sentence, not a speech. */
const MAX_LINE_MS = 30_000;

function cleanupBody(voice: DemoVoice, reason: "done" | "unload"): string {
  return JSON.stringify({ voiceId: voice.voiceId, token: voice.token, reason });
}

export function DemoShell(): JSX.Element {
  const { mine, theirs, pills, sheetOpen, setSheetOpen, selectLanguage } = useLanguagePair();
  const s = copyFor(mine);
  const t = copyFor(theirs);

  const [stage, setStage] = useState<Stage>("consent");
  const [consented, setConsented] = useState(false);
  const [removeNoise, setRemoveNoise] = useState(true);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [voice, setVoice] = useState<DemoVoice | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Reveal
  const [reversed, setReversed] = useState(false);
  const [line, setLine] = useState("");
  const [translation, setTranslation] = useState("");
  const [linesLeft, setLinesLeft] = useState(DEMO_MAX_LINES);
  const [busy, setBusy] = useState(false);
  const [lineRecording, setLineRecording] = useState(false);
  const [lastAudio, setLastAudio] = useState<Blob | null>(null);
  const [deleteState, setDeleteState] = useState<"idle" | "deleting" | "deleted" | "failed">("idle");

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  // The voice, readable from the unload handler without re-binding it.
  const voiceRef = useRef<DemoVoice | null>(null);
  useEffect(() => {
    voiceRef.current = voice;
  }, [voice]);

  const from = reversed ? theirs : mine;
  const to = reversed ? mine : theirs;

  // ── Delete paths (a) Done and (b) unload ─────────────────────────────────
  const sendCleanupBeacon = useCallback(() => {
    const v = voiceRef.current;
    if (!v) return;
    voiceRef.current = null;
    const body = cleanupBody(v, "unload");
    try {
      // text/plain keeps the beacon a "simple" request; the route parses it.
      const sent =
        typeof navigator !== "undefined" &&
        typeof navigator.sendBeacon === "function" &&
        navigator.sendBeacon("/api/demo/cleanup", new Blob([body], { type: "text/plain" }));
      if (!sent) {
        void fetch("/api/demo/cleanup", { method: "POST", body, keepalive: true }).catch(() => {});
      }
    } catch {
      // The sweep is the backstop.
    }
  }, []);

  useEffect(() => {
    // pagehide is the one iOS fires reliably; beforeunload covers desktop.
    window.addEventListener("pagehide", sendCleanupBeacon);
    window.addEventListener("beforeunload", sendCleanupBeacon);
    return () => {
      window.removeEventListener("pagehide", sendCleanupBeacon);
      window.removeEventListener("beforeunload", sendCleanupBeacon);
      // Leaving /demo inside the app (no unload) is still leaving.
      sendCleanupBeacon();
    };
  }, [sendCleanupBeacon]);

  const finish = useCallback(async () => {
    const v = voiceRef.current;
    voiceRef.current = null;
    setStage("ended");
    if (!v) {
      setDeleteState("deleted");
      return;
    }
    setDeleteState("deleting");
    try {
      const res = await fetch("/api/demo/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: cleanupBody(v, "done"),
        keepalive: true
      });
      setDeleteState(res.ok ? "deleted" : "failed");
    } catch {
      setDeleteState("failed");
    }
    setVoice(null);
  }, []);

  // Expiry clock: once the server would have swept it, the demo is over.
  useEffect(() => {
    if (!voice) return;
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, [voice]);
  useEffect(() => {
    if (voice && now >= voice.expiresAt) void finish();
  }, [voice, now, finish]);

  // ── Audio ────────────────────────────────────────────────────────────────
  function ensureAudio(): HTMLAudioElement | null {
    if (!audioRef.current && typeof Audio !== "undefined") audioRef.current = new Audio();
    return audioRef.current;
  }
  // play() inside the tap "blesses" the element for the play() after the fetch (iOS).
  function blessAudio() {
    const a = ensureAudio();
    if (!a) return;
    a.play().catch(() => {});
    a.pause();
  }

  function stopTracks() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
  }
  useEffect(() => () => stopTracks(), []);

  async function openRecorder(onStop: (blob: Blob, mime: string, ms: number) => void, maxMs: number) {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw new Error(s.micUnavailable);
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;
    const mime = pickMimeType();
    const opts: MediaRecorderOptions = { audioBitsPerSecond: SAMPLE_BITS_PER_SECOND };
    if (mime) opts.mimeType = mime;
    const recorder = new MediaRecorder(stream, opts);
    chunksRef.current = [];
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
    };
    recorder.onstop = () => {
      const ms = Date.now() - startedAtRef.current;
      stopTracks();
      const type = recorder.mimeType || mime || "audio/webm";
      onStop(new Blob(chunksRef.current, { type }), type, ms);
    };
    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    recorder.start(1000);
    tickRef.current = setInterval(() => {
      const ms = Date.now() - startedAtRef.current;
      setElapsedMs(ms);
      if (ms >= maxMs && recorder.state === "recording") recorder.stop();
    }, 250);
  }

  function stopRecorder() {
    const r = recorderRef.current;
    if (r && r.state === "recording") r.stop();
  }

  // ── Screen 1: consent → record ───────────────────────────────────────────
  async function startSample() {
    // The consent tap is the precondition for opening the mic at all.
    if (!consented) return;
    setError(null);
    blessAudio();
    try {
      setStage("recording");
      await openRecorder((blob, mime, ms) => void cloneSample(blob, mime, ms), DEMO_MAX_SAMPLE_SECONDS * 1000);
    } catch (e) {
      stopTracks();
      setStage("consent");
      setError(e instanceof Error && e.name === "NotAllowedError" ? s.micDenied : s.micUnavailable);
    }
  }

  // ── Screen 2: clone ──────────────────────────────────────────────────────
  async function cloneSample(blob: Blob, mime: string, ms: number) {
    if (ms < DEMO_MIN_SAMPLE_SECONDS * 1000 || blob.size === 0) {
      setStage("consent");
      setError(fill(s.demoKeepTalking, { seconds: DEMO_MIN_SAMPLE_SECONDS }));
      return;
    }
    setStage("cloning");
    const shownAt = Date.now();
    try {
      const form = new FormData();
      form.append("sample", blob, fileNameFor(mime, "sample"));
      form.append("consent", "yes");
      form.append("durationMs", String(Math.round(ms)));
      form.append("removeNoise", removeNoise ? "1" : "0");
      const res = await fetch("/api/demo/clone", {
        method: "POST",
        headers: await authHeaders(),
        body: form
      });
      const payload = (await res.json().catch(() => ({}))) as {
        voiceId?: string;
        token?: string;
        expiresAt?: number;
        error?: string;
      };
      if (!res.ok || !payload.voiceId || !payload.token || !payload.expiresAt) {
        throw new Error(payload.error || "Voice cloning failed.");
      }
      const wait = MIN_CREATING_MS - (Date.now() - shownAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const v = { voiceId: payload.voiceId, token: payload.token, expiresAt: payload.expiresAt };
      voiceRef.current = v;
      setVoice(v);
      setNow(Date.now());
      setLinesLeft(DEMO_MAX_LINES);
      setStage("reveal");
    } catch (e) {
      setStage("consent");
      setError(e instanceof Error ? e.message : "Voice cloning failed.");
    }
  }

  // ── Screen 3: the reveal ─────────────────────────────────────────────────
  async function speakInTheirVoice(text: string) {
    const v = voiceRef.current;
    if (!v) return;
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: await jsonAuthHeaders(),
      body: JSON.stringify({
        text,
        engine: "elevenlabs",
        sourceLanguage: from,
        targetLanguage: to,
        voiceOverride: v.voiceId,
        demoToken: v.token
      })
    });
    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(payload.error || s.ttsFailed);
    }
    const left = Number(res.headers.get("X-Demo-Lines-Left"));
    setLinesLeft(Number.isFinite(left) ? left : (n) => Math.max(0, n - 1));
    const blob = await res.blob();
    setLastAudio(blob);
    const a = ensureAudio();
    if (!a) return;
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = URL.createObjectURL(blob);
    a.src = objectUrlRef.current;
    await a.play();
  }

  async function sayTyped() {
    const text = line.trim();
    if (!text || busy || linesLeft <= 0) return;
    blessAudio();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/text-translate", {
        method: "POST",
        headers: await jsonAuthHeaders(),
        body: JSON.stringify({ text, sourceLanguage: from, targetLanguage: to })
      });
      const payload = (await res.json().catch(() => ({}))) as { translation?: string; error?: string };
      if (!res.ok || !payload.translation) throw new Error(payload.error || s.translateFailed);
      setTranslation(payload.translation);
      await speakInTheirVoice(payload.translation);
    } catch (e) {
      setError(e instanceof Error ? e.message : s.translateFailed);
    } finally {
      setBusy(false);
    }
  }

  async function toggleLineRecording() {
    if (lineRecording) {
      stopRecorder();
      return;
    }
    if (busy || linesLeft <= 0) return;
    blessAudio();
    setError(null);
    try {
      setLineRecording(true);
      await openRecorder((blob, mime) => void translateSpoken(blob, mime), MAX_LINE_MS);
    } catch (e) {
      stopTracks();
      setLineRecording(false);
      setError(e instanceof Error && e.name === "NotAllowedError" ? s.micDenied : s.micUnavailable);
    }
  }

  async function translateSpoken(blob: Blob, mime: string) {
    setLineRecording(false);
    if (blob.size === 0) {
      setError(s.noAudio);
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.append("audio", blob, fileNameFor(mime, "audio"));
      form.append("sourceLanguage", from);
      form.append("targetLanguage", to);
      form.append("tone", "detailed");
      const res = await fetch("/api/translate", { method: "POST", headers: await authHeaders(), body: form });
      const payload = (await res.json().catch(() => ({}))) as {
        original?: string;
        translation?: string;
        error?: string;
        details?: string;
      };
      if (!res.ok || !payload.translation) {
        throw new Error(payload.details || payload.error || s.translateFailed);
      }
      setLine(payload.original ?? "");
      setTranslation(payload.translation);
      await speakInTheirVoice(payload.translation);
    } catch (e) {
      setError(e instanceof Error ? e.message : s.translateFailed);
    } finally {
      setBusy(false);
    }
  }

  // ── Screen 4: share ──────────────────────────────────────────────────────
  async function share() {
    if (!lastAudio) return;
    try {
      const name = languageLabel(to);
      await shareAudioFile(lastAudio, { fileName: demoShareFileName(name), title: `TAOS · ${name}` });
    } catch (e) {
      setError(e instanceof Error ? e.message : s.ttsFailed);
    }
  }

  function restart() {
    setStage("consent");
    setConsented(false);
    setError(null);
    setLine("");
    setTranslation("");
    setLastAudio(null);
    setReversed(false);
    setDeleteState("idle");
  }

  const seconds = Math.floor(elapsedMs / 1000);
  const minReached = seconds >= DEMO_MIN_SAMPLE_SECONDS;
  const minutesLeft = voice ? Math.max(1, Math.ceil((voice.expiresAt - now) / 60_000)) : 0;
  // The stranger may not read the phone owner's language: show theirs too.
  const bilingual = t.demoConsent !== s.demoConsent;

  return (
    <main className="min-h-screen px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-[calc(env(safe-area-inset-top)+1rem)]">
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-md flex-col gap-4">
        <header className="flex items-center gap-3">
          {/* A plain link out still deletes the clone: pagehide sends the
              cleanup beacon (above). */}
          <ExitHome lang={mine} />
          <h1 className="text-lg font-semibold tracking-tight text-amber-200">TAOS·LITE</h1>
          {stage === "reveal" && (
            <button
              type="button"
              onClick={() => void finish()}
              className="ml-auto rounded-full bg-amber-400 px-4 py-1.5 text-sm font-semibold text-stone-950"
            >
              Terminar · Done
            </button>
          )}
        </header>

        <div className="text-xs uppercase tracking-[0.2em] text-amber-100/50">
          {bilingual ? `${t.navDemo} · ${s.navDemo}` : s.navDemo}
        </div>

        {stage === "consent" || stage === "recording" ? (
          <section className="flex flex-col gap-4">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <p className="text-base leading-snug text-amber-50">{t.demoConsent}</p>
              {bilingual ? <p className="mt-2 text-sm leading-snug text-amber-100/60">{s.demoConsent}</p> : null}
              <button
                type="button"
                aria-pressed={consented}
                disabled={stage === "recording"}
                onClick={() => setConsented((c) => !c)}
                className={`mt-3 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl border px-3 text-sm font-semibold transition ${
                  consented
                    ? "border-emerald-300/50 bg-emerald-400/15 text-emerald-100"
                    : "border-amber-300/40 bg-amber-400/10 text-amber-100"
                }`}
              >
                {consented ? "✓ " : ""}
                {bilingual ? `${t.demoAgree} · ${s.demoAgree}` : s.demoAgree}
              </button>
            </div>

            <label className="flex items-center gap-2 text-sm text-amber-100/70">
              <input
                type="checkbox"
                checked={removeNoise}
                disabled={stage === "recording"}
                onChange={(e) => setRemoveNoise(e.target.checked)}
              />
              {s.demoRemoveNoise}
            </label>

            <p className="text-center text-lg text-amber-100/90">
              “{t.demoPrompt}”
              {bilingual ? <span className="block text-sm text-amber-100/50">{s.demoPrompt}</span> : null}
            </p>

            {stage === "consent" ? (
              <button
                type="button"
                disabled={!consented}
                onClick={() => void startSample()}
                className="mx-auto flex h-36 w-36 items-center justify-center rounded-full bg-rose-500 text-lg font-semibold text-white shadow-lg transition active:scale-95 disabled:opacity-30"
              >
                {bilingual ? `${t.demoRecord} · ${s.demoRecord}` : s.demoRecord}
              </button>
            ) : (
              <div className="flex flex-col items-center gap-3">
                <div className="font-mono text-4xl tabular-nums text-amber-100">
                  {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
                  <span className="text-base text-amber-100/40"> / 1:30</span>
                </div>
                <button
                  type="button"
                  disabled={!minReached}
                  onClick={stopRecorder}
                  className="flex h-36 w-36 animate-pulse items-center justify-center rounded-full bg-rose-600 text-lg font-semibold text-white shadow-lg disabled:animate-none disabled:opacity-60"
                >
                  {s.demoStopRecording}
                </button>
                {!minReached ? (
                  <p className="text-sm text-amber-100/60">
                    {fill(s.demoKeepTalking, { seconds: DEMO_MIN_SAMPLE_SECONDS })}
                  </p>
                ) : null}
              </div>
            )}
          </section>
        ) : null}

        {stage === "cloning" ? (
          <section className="flex flex-1 flex-col items-center justify-center gap-4">
            <div className="h-16 w-16 animate-spin rounded-full border-4 border-amber-300/20 border-t-amber-300" />
            <p className="text-lg text-amber-100">{bilingual ? `${t.demoCreating} · ${s.demoCreating}` : s.demoCreating}</p>
          </section>
        ) : null}

        {stage === "reveal" ? (
          <section className="flex flex-col gap-3">
            <LanguagePillRow
              pills={pills}
              selected={theirs}
              paired={mine}
              caption="Between · Entre"
              sheetOpen={sheetOpen}
              onSelect={selectLanguage}
              onOpenSheet={() => setSheetOpen(true)}
            />
            <div className="flex items-center justify-between gap-2 rounded-2xl border border-white/10 bg-white/5 px-3 py-2">
              <span className="truncate text-sm text-amber-100/80">
                {languageFlag(from)} {languageNative(from)} → {languageFlag(to)} {languageNative(to)}
              </span>
              <button
                type="button"
                onClick={() => setReversed((r) => !r)}
                className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-amber-100/70"
              >
                ⇄ {s.swap}
              </button>
            </div>

            <p className="text-sm text-amber-100/60">{s.demoRevealHint}</p>
            {!canSpeak(to) ? <p className="text-sm text-rose-300">{TEXT_ONLY_TITLE}</p> : null}

            <textarea
              value={line}
              onChange={(e) => setLine(e.target.value)}
              placeholder={s.demoTypePlaceholder}
              rows={2}
              disabled={busy || lineRecording || linesLeft <= 0}
              className="w-full rounded-2xl border border-white/10 bg-black/20 p-3 text-base text-amber-50 placeholder:text-amber-100/30"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void toggleLineRecording()}
                disabled={busy || linesLeft <= 0 || !canSpeak(to)}
                className={`min-h-[44px] flex-1 rounded-xl px-3 text-sm font-semibold transition disabled:opacity-40 ${
                  lineRecording ? "animate-pulse bg-rose-600 text-white" : "border border-white/15 bg-white/5 text-amber-100"
                }`}
              >
                {lineRecording ? s.stop : `🎙 ${s.demoSpeakLine}`}
              </button>
              <button
                type="button"
                onClick={() => void sayTyped()}
                disabled={busy || lineRecording || !line.trim() || linesLeft <= 0 || !canSpeak(to)}
                className="min-h-[44px] flex-1 rounded-xl bg-amber-400 px-3 text-sm font-semibold text-stone-950 transition disabled:opacity-40"
              >
                {busy ? s.working : s.demoSay}
              </button>
            </div>

            {translation ? (
              <div className="rounded-2xl border border-amber-300/20 bg-amber-400/5 p-4">
                <div className="text-[10px] uppercase tracking-[0.2em] text-amber-100/40">{s.translationLabel}</div>
                <p className="mt-1 text-lg text-amber-50">{translation}</p>
              </div>
            ) : null}

            <div className="flex items-center justify-between text-xs text-amber-100/50">
              <span>{fill(s.demoLinesLeft, { count: linesLeft, max: DEMO_MAX_LINES })}</span>
              <span>{fill(s.demoExpiresIn, { minutes: minutesLeft })}</span>
            </div>

            {lastAudio ? (
              <button
                type="button"
                onClick={() => void share()}
                className="min-h-[44px] rounded-xl border border-white/15 bg-white/5 px-3 text-sm font-semibold text-amber-100"
              >
                ↗ {s.demoShare}
              </button>
            ) : null}
          </section>
        ) : null}

        {stage === "ended" ? (
          <section className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
            <p className="text-lg text-amber-100">
              {deleteState === "deleting"
                ? s.demoDeleting
                : deleteState === "failed"
                  ? s.demoDeleteFailed
                  : bilingual
                    ? `${t.demoDeleted} · ${s.demoDeleted}`
                    : s.demoDeleted}
            </p>
            {deleteState !== "deleting" ? (
              <button
                type="button"
                onClick={restart}
                className="rounded-2xl bg-amber-400 px-5 py-2.5 text-sm font-semibold text-stone-950"
              >
                {s.demoAgain}
              </button>
            ) : null}
          </section>
        ) : null}

        {error ? <p className="rounded-xl bg-rose-500/10 p-3 text-sm text-rose-200">{error}</p> : null}
      </div>

      <LanguageSheet
        open={sheetOpen}
        selected={theirs}
        paired={mine}
        caption={s.translateInto}
        onSelect={selectLanguage}
        onClose={() => setSheetOpen(false)}
      />
    </main>
  );
}
