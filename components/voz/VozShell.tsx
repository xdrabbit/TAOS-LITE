"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authHeaders } from "@/lib/authClient";
import { copyFor, fill } from "@/lib/chrome/copy";
import { canSpeak, languageFlag, languageLabel, languageNative } from "@/lib/languages/catalog";
import { supabase } from "@/lib/supabase";
import { useLanguagePair } from "@/lib/translate/useLanguagePair";
import { shareAudioFile } from "@/lib/tts/shareAudio";
import { TEXT_ONLY_TITLE } from "@/lib/tts/speech";
import {
  VOZ_MAX_LINE_CHARS,
  VOZ_MAX_LINE_SECONDS,
  VOZ_MAX_LINES,
  VOZ_MAX_SAMPLE_SECONDS,
  VOZ_MIN_SAMPLE_SECONDS,
  vozShareFileName,
  vozTargetFor
} from "@/lib/voz/limits";
import { fileNameFor, pickMimeType, SAMPLE_BITS_PER_SECOND, sendCleanupBeacon } from "@/lib/voz/recorder";
import { ExitHome } from "@/components/ExitHome";
import { SignIn } from "@/components/SignIn";

// ── /voz — "Tu voz", public ────────────────────────────────────────────────
// The stranger's OWN phone, from a link. No founder anywhere on this screen.
//
//   1. consent  — one sentence of what this is, the consent text in the
//                 phone's language (the other language small below), one
//                 "Acepto · I agree" tap → /api/voz/consent mints the token
//                 the record button needs; no token, no recording, no clone
//   2. record   — 10-60 s, live mic only (there is no file input anywhere)
//   3. reveal   — ONE line in their own language, said or typed, comes back
//                 in the other language in their voice; two lines max
//   4. share    — the home share path; then the ladder card
//   5. done     — "Listo · Done", page unload (beacon) or the 10-min sweep
//
// The voice id lives in this component's state and nowhere else on the client.

type Stage = "consent" | "recording" | "cloning" | "reveal" | "ended" | "refused";

interface VozVoice {
  voiceId: string;
  token: string;
  expiresAt: number;
}

/** The "creating your voice" beat is part of the show; never shorter than this. */
const MIN_CREATING_MS = 3000;

function cleanupBody(voice: VozVoice, reason: "done" | "unload"): string {
  return JSON.stringify({ voiceId: voice.voiceId, token: voice.token, reason });
}

async function errorFrom(res: Response, fallback: string): Promise<string> {
  const payload = (await res.json().catch(() => ({}))) as { error?: string };
  return payload.error || fallback;
}

export function VozShell(): JSX.Element {
  const { mine } = useLanguagePair();
  // Spanish phone → the line comes out in English; anything else → Spanish
  // for English phones, English otherwise (lib/voz/limits.ts).
  const target = vozTargetFor(mine);
  const s = copyFor(mine);
  const t = copyFor(target);
  const bilingual = t.vozConsent !== s.vozConsent;

  const [stage, setStage] = useState<Stage>("consent");
  const [consentToken, setConsentToken] = useState<string | null>(null);
  const [consenting, setConsenting] = useState(false);
  const [removeNoise, setRemoveNoise] = useState(true);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [voice, setVoice] = useState<VozVoice | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [signedIn, setSignedIn] = useState(false);
  const [showSignIn, setShowSignIn] = useState(false);

  const [line, setLine] = useState("");
  const [translation, setTranslation] = useState("");
  const [linesLeft, setLinesLeft] = useState(VOZ_MAX_LINES);
  const [busy, setBusy] = useState(false);
  const [lineRecording, setLineRecording] = useState(false);
  const [lastAudio, setLastAudio] = useState<Blob | null>(null);
  const [shared, setShared] = useState(false);
  const [deleteState, setDeleteState] = useState<"idle" | "deleting" | "deleted" | "failed">("idle");

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const voiceRef = useRef<VozVoice | null>(null);
  useEffect(() => {
    voiceRef.current = voice;
  }, [voice]);

  // Signed in changes the daily allowance and hides "create your account".
  useEffect(() => {
    let alive = true;
    void supabase.auth
      .getSession()
      .then(({ data }) => alive && setSignedIn(!!data.session))
      .catch(() => {});
    const { data } = supabase.auth.onAuthStateChange((_e, session) => setSignedIn(!!session));
    return () => {
      alive = false;
      data.subscription.unsubscribe();
    };
  }, []);

  // ── Delete paths: Done, unload, leaving in-app ───────────────────────────
  const unloadCleanup = useCallback(() => {
    const v = voiceRef.current;
    if (!v) return;
    voiceRef.current = null;
    sendCleanupBeacon("/api/voz/cleanup", cleanupBody(v, "unload"));
  }, []);

  useEffect(() => {
    window.addEventListener("pagehide", unloadCleanup);
    window.addEventListener("beforeunload", unloadCleanup);
    return () => {
      window.removeEventListener("pagehide", unloadCleanup);
      window.removeEventListener("beforeunload", unloadCleanup);
      unloadCleanup();
    };
  }, [unloadCleanup]);

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
      const res = await fetch("/api/voz/cleanup", {
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

  // ── 1. Consent ───────────────────────────────────────────────────────────
  async function agree() {
    if (consentToken || consenting) return;
    setConsenting(true);
    setError(null);
    try {
      const res = await fetch("/api/voz/consent", { method: "POST", headers: await authHeaders() });
      if (!res.ok) {
        const message = await errorFrom(res, s.connectionLost);
        if (res.status === 429) {
          setError(message);
          setStage("refused");
        } else {
          setError(message);
        }
        return;
      }
      const payload = (await res.json()) as { token?: string };
      if (!payload.token) throw new Error(s.connectionLost);
      setConsentToken(payload.token);
    } catch (e) {
      setError(e instanceof Error ? e.message : s.connectionLost);
    } finally {
      setConsenting(false);
    }
  }

  // ── 2. Record ────────────────────────────────────────────────────────────
  async function startSample() {
    if (!consentToken) return;
    setError(null);
    blessAudio();
    try {
      setStage("recording");
      await openRecorder((blob, mime, ms) => void cloneSample(blob, mime, ms), VOZ_MAX_SAMPLE_SECONDS * 1000);
    } catch (e) {
      stopTracks();
      setStage("consent");
      setError(e instanceof Error && e.name === "NotAllowedError" ? s.micDenied : s.micUnavailable);
    }
  }

  async function cloneSample(blob: Blob, mime: string, ms: number) {
    if (ms < VOZ_MIN_SAMPLE_SECONDS * 1000 || blob.size === 0) {
      setStage("consent");
      setError(fill(s.demoKeepTalking, { seconds: VOZ_MIN_SAMPLE_SECONDS }));
      return;
    }
    setStage("cloning");
    const shownAt = Date.now();
    try {
      const form = new FormData();
      form.append("sample", blob, fileNameFor(mime, "sample"));
      form.append("consentToken", consentToken ?? "");
      form.append("durationMs", String(Math.round(ms)));
      form.append("removeNoise", removeNoise ? "1" : "0");
      const res = await fetch("/api/voz/clone", { method: "POST", headers: await authHeaders(), body: form });
      const payload = (await res.json().catch(() => ({}))) as {
        voiceId?: string;
        token?: string;
        expiresAt?: number;
        error?: string;
      };
      if (res.status === 429) {
        setError(payload.error || s.connectionLost);
        setStage("refused");
        return;
      }
      if (!res.ok || !payload.voiceId || !payload.token || !payload.expiresAt) {
        throw new Error(payload.error || "Voice cloning failed.");
      }
      const wait = MIN_CREATING_MS - (Date.now() - shownAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const v = { voiceId: payload.voiceId, token: payload.token, expiresAt: payload.expiresAt };
      voiceRef.current = v;
      setVoice(v);
      setNow(Date.now());
      setLinesLeft(VOZ_MAX_LINES);
      setStage("reveal");
    } catch (e) {
      // A consent is one recording: a failed clone asks for the tap again.
      setConsentToken(null);
      setStage("consent");
      setError(e instanceof Error ? e.message : "Voice cloning failed.");
    }
  }

  // ── 3. Reveal ────────────────────────────────────────────────────────────
  async function speakLine(fields: { text?: string; audio?: Blob; mime?: string }) {
    const v = voiceRef.current;
    if (!v) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("voiceId", v.voiceId);
      form.append("token", v.token);
      form.append("sourceLanguage", mine);
      form.append("targetLanguage", target);
      if (fields.text) form.append("text", fields.text);
      if (fields.audio) form.append("audio", fields.audio, fileNameFor(fields.mime ?? "", "line"));
      const res = await fetch("/api/voz/line", { method: "POST", headers: await authHeaders(), body: form });
      if (!res.ok) throw new Error(await errorFrom(res, s.ttsFailed));
      const decode = (h: string) => {
        try {
          return decodeURIComponent(res.headers.get(h) ?? "");
        } catch {
          return "";
        }
      };
      const original = decode("X-Voz-Original");
      if (original) setLine(original);
      setTranslation(decode("X-Voz-Translation"));
      const left = Number(res.headers.get("X-Voz-Lines-Left"));
      setLinesLeft(Number.isFinite(left) ? left : (n) => Math.max(0, n - 1));
      const blob = await res.blob();
      setLastAudio(blob);
      const a = ensureAudio();
      if (!a) return;
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = URL.createObjectURL(blob);
      a.src = objectUrlRef.current;
      await a.play();
    } catch (e) {
      setError(e instanceof Error ? e.message : s.ttsFailed);
    } finally {
      setBusy(false);
    }
  }

  function sayTyped() {
    const text = line.trim();
    if (!text || busy || linesLeft <= 0) return;
    blessAudio();
    void speakLine({ text });
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
      await openRecorder((blob, mime) => {
        setLineRecording(false);
        if (blob.size === 0) {
          setError(s.noAudio);
          return;
        }
        void speakLine({ audio: blob, mime });
      }, VOZ_MAX_LINE_SECONDS * 1000);
    } catch (e) {
      stopTracks();
      setLineRecording(false);
      setError(e instanceof Error && e.name === "NotAllowedError" ? s.micDenied : s.micUnavailable);
    }
  }

  // ── 4. Share ─────────────────────────────────────────────────────────────
  async function share() {
    const v = voiceRef.current;
    if (!lastAudio) return;
    try {
      const name = languageLabel(target);
      const outcome = await shareAudioFile(lastAudio, { fileName: vozShareFileName(name), title: `TAOS · ${name}` });
      if (outcome !== "cancelled") setShared(true);
      if (v) {
        void fetch("/api/voz/share", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ voiceId: v.voiceId, token: v.token, outcome }),
          keepalive: true
        }).catch(() => {});
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : s.ttsFailed);
    }
  }

  function restart() {
    setStage("consent");
    setConsentToken(null);
    setError(null);
    setLine("");
    setTranslation("");
    setLastAudio(null);
    setShared(false);
    setDeleteState("idle");
  }

  const seconds = Math.floor(elapsedMs / 1000);
  const minReached = seconds >= VOZ_MIN_SAMPLE_SECONDS;
  const minutesLeft = voice ? Math.max(1, Math.ceil((voice.expiresAt - now) / 60_000)) : 0;
  const both = (a: string, b: string) => (bilingual && a !== b ? `${a} · ${b}` : a);

  // ── 6. The ladder: after the share, after Done, or when today is used up ─
  const ladder =
    shared || stage === "ended" || stage === "refused" ? (
      <section className="flex flex-col gap-3 rounded-2xl border border-amber-300/20 bg-amber-400/5 p-4">
        {!signedIn ? (
          showSignIn ? (
            <SignIn redirectPath="/voz" title={s.vozAgainSignUp} />
          ) : (
            <button
              type="button"
              onClick={() => setShowSignIn(true)}
              className="min-h-[44px] rounded-xl bg-amber-400 px-4 text-sm font-semibold text-stone-950"
            >
              {s.vozAgainSignUp}
            </button>
          )
        ) : null}
        <p className="text-sm text-amber-100/70">{s.vozKeepForever}</p>
      </section>
    ) : null;

  return (
    <main className="min-h-screen px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-[calc(env(safe-area-inset-top)+1rem)]">
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-md flex-col gap-4">
        <header className="flex items-center gap-3">
          {/* Leaving by the link still deletes the voice: pagehide → beacon. */}
          <ExitHome lang={mine} />
          <h1 className="text-lg font-semibold tracking-tight text-amber-200">TAOS·LITE</h1>
          {stage === "reveal" && (
            <button
              type="button"
              onClick={() => void finish()}
              className="ml-auto min-h-[44px] rounded-full bg-amber-400 px-4 text-sm font-semibold text-stone-950"
            >
              Listo · Done
            </button>
          )}
        </header>

        <div className="text-xs uppercase tracking-[0.2em] text-amber-100/50">{both(s.navDemo, t.navDemo)}</div>

        {stage === "consent" || stage === "recording" ? (
          <section className="flex flex-col gap-4">
            <p className="text-lg leading-snug text-amber-50">
              {s.vozWhat}
              {bilingual ? <span className="mt-1 block text-sm text-amber-100/50">{t.vozWhat}</span> : null}
            </p>
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <p className="text-base leading-snug text-amber-50">{s.vozConsent}</p>
              {bilingual ? <p className="mt-2 text-xs leading-snug text-amber-100/50">{t.vozConsent}</p> : null}
              <button
                type="button"
                aria-pressed={!!consentToken}
                disabled={!!consentToken || consenting || stage === "recording"}
                onClick={() => void agree()}
                className={`mt-3 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl border px-3 text-sm font-semibold transition ${
                  consentToken
                    ? "border-emerald-300/50 bg-emerald-400/15 text-emerald-100"
                    : "border-amber-300/40 bg-amber-400/10 text-amber-100"
                }`}
              >
                {consentToken ? "✓ " : ""}
                {consenting ? s.working : both(s.demoAgree, t.demoAgree)}
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

            <p className="text-center text-lg text-amber-100/90">“{s.demoPrompt}”</p>

            {stage === "consent" ? (
              <button
                type="button"
                disabled={!consentToken}
                onClick={() => void startSample()}
                className="mx-auto flex h-36 w-36 items-center justify-center rounded-full bg-rose-500 text-lg font-semibold text-white shadow-lg transition active:scale-95 disabled:opacity-30"
              >
                {s.demoRecord}
              </button>
            ) : (
              <div className="flex flex-col items-center gap-3">
                <div className="font-mono text-4xl tabular-nums text-amber-100">
                  {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
                  <span className="text-base text-amber-100/40">
                    {" "}
                    / {Math.floor(VOZ_MAX_SAMPLE_SECONDS / 60)}:{String(VOZ_MAX_SAMPLE_SECONDS % 60).padStart(2, "0")}
                  </span>
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
                    {fill(s.demoKeepTalking, { seconds: VOZ_MIN_SAMPLE_SECONDS })}
                  </p>
                ) : null}
              </div>
            )}
          </section>
        ) : null}

        {stage === "cloning" ? (
          <section className="flex flex-1 flex-col items-center justify-center gap-4">
            <div className="h-16 w-16 animate-spin rounded-full border-4 border-amber-300/20 border-t-amber-300" />
            <p className="text-lg text-amber-100">{s.demoCreating}</p>
          </section>
        ) : null}

        {stage === "reveal" ? (
          <section className="flex flex-col gap-3">
            <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-amber-100/80">
              {languageFlag(mine)} {languageNative(mine)} → {languageFlag(target)} {languageNative(target)}
            </div>
            <p className="text-sm text-amber-100/60">{fill(s.vozRevealHint, { language: languageNative(target) })}</p>
            {!canSpeak(target) ? <p className="text-sm text-rose-300">{TEXT_ONLY_TITLE}</p> : null}

            <textarea
              value={line}
              onChange={(e) => setLine(e.target.value.slice(0, VOZ_MAX_LINE_CHARS))}
              placeholder={s.demoTypePlaceholder}
              rows={2}
              disabled={busy || lineRecording || linesLeft <= 0}
              className="w-full rounded-2xl border border-white/10 bg-black/20 p-3 text-base text-amber-50 placeholder:text-amber-100/30"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void toggleLineRecording()}
                disabled={busy || linesLeft <= 0 || !canSpeak(target)}
                className={`min-h-[44px] flex-1 rounded-xl px-3 text-sm font-semibold transition disabled:opacity-40 ${
                  lineRecording ? "animate-pulse bg-rose-600 text-white" : "border border-white/15 bg-white/5 text-amber-100"
                }`}
              >
                {lineRecording ? s.stop : `🎙 ${s.demoSpeakLine}`}
              </button>
              <button
                type="button"
                onClick={sayTyped}
                disabled={busy || lineRecording || !line.trim() || linesLeft <= 0 || !canSpeak(target)}
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
              <span>{fill(s.demoLinesLeft, { count: linesLeft, max: VOZ_MAX_LINES })}</span>
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
          <section className="flex flex-col items-center gap-2 py-6 text-center">
            <p className="text-lg text-amber-100">
              {deleteState === "deleting"
                ? s.demoDeleting
                : deleteState === "failed"
                  ? s.demoDeleteFailed
                  : both(s.demoDeleted, t.demoDeleted)}
            </p>
            {!signedIn ? <p className="text-sm text-amber-100/60">{s.vozUsedToday}</p> : null}
            {/* Signed in has more than one try a day; the server still counts. */}
            {signedIn && deleteState !== "deleting" ? (
              <button
                type="button"
                onClick={restart}
                className="mt-2 min-h-[44px] rounded-2xl bg-amber-400 px-5 text-sm font-semibold text-stone-950"
              >
                {s.demoAgain}
              </button>
            ) : null}
          </section>
        ) : null}

        {error ? <p className="rounded-xl bg-rose-500/10 p-3 text-sm text-rose-200">{error}</p> : null}

        {ladder}
      </div>
    </main>
  );
}
