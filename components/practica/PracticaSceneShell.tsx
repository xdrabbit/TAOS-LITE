"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Conversation, type Conversation as ElevenConversation } from "@elevenlabs/client";
import Link from "next/link";
import { jsonAuthHeaders } from "@/lib/authClient";
import { copyFor } from "@/lib/chrome/copy";
import { faceProvider, type FaceHandle, type FaceKind } from "@/lib/practica/face";
import { SCENE_DONE_MARKER, sceneFirstMessage, scenePrompt } from "@/lib/practica/prompt";
import type { PracticaScene, PracticaTrip } from "@/lib/practica/scenes";
import { requestSpeech } from "@/lib/tts/speech";
import { PracticaGate } from "./PracticaGate";

type EndReason = "timer" | "done" | "user" | "error";
type Status = "idle" | "connecting" | "live" | "ended" | "error";

const LIMIT_SECONDS = 300;

function clock(seconds: number): string {
  const clamped = Math.max(0, seconds);
  return `${Math.floor(clamped / 60)}:${String(clamped % 60).padStart(2, "0")}`;
}

export function PracticaSceneShell({
  configured,
  face,
  trip,
  scene,
  sceneIndex
}: {
  configured: boolean;
  face: FaceKind;
  trip: PracticaTrip;
  scene: PracticaScene;
  sceneIndex: number;
}): JSX.Element {
  const copy = copyFor(trip.learnerLanguage);
  const [status, setStatus] = useState<Status>("idle");
  const [remaining, setRemaining] = useState(LIMIT_SECONDS);
  const [speaking, setSpeaking] = useState(false);
  const [endReason, setEndReason] = useState<EndReason | null>(null);
  const [error, setError] = useState<string | null>(null);
  const faceContainerRef = useRef<HTMLDivElement | null>(null);
  const conversationRef = useRef<ElevenConversation | null>(null);
  const faceHandleRef = useRef<FaceHandle | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const startedAtRef = useRef(0);
  const finishingRef = useRef(false);
  const markerBufferRef = useRef("");
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  const writeEndLog = useCallback(
    async (ended: EndReason) => {
      const seconds = startedAtRef.current
        ? Math.min(LIMIT_SECONDS, Math.max(0, Math.round((Date.now() - startedAtRef.current) / 1000)))
        : 0;
      try {
        await fetch("/api/practica/end", {
          method: "POST",
          headers: await jsonAuthHeaders(),
          body: JSON.stringify({ tripId: trip.id, sceneIndex, seconds, ended }),
          keepalive: true
        });
      } catch {
        // One best-effort Vercel line; no local transcript or retry queue.
      }
    },
    [sceneIndex, trip.id]
  );

  const finish = useCallback(
    async (ended: EndReason) => {
      if (finishingRef.current) return;
      finishingRef.current = true;
      clearTimer();
      setEndReason(ended);
      setStatus(ended === "error" ? "error" : "ended");
      setSpeaking(false);

      const conversation = conversationRef.current;
      conversationRef.current = null;
      const faceHandle = faceHandleRef.current;
      faceHandleRef.current = null;
      await Promise.allSettled([conversation?.endSession(), faceHandle?.stop()]);
      await writeEndLog(ended);
    },
    [clearTimer, writeEndLog]
  );

  const inspectAgentText = useCallback(
    (message: string) => {
      markerBufferRef.current = `${markerBufferRef.current}${message}`.slice(-160);
      if (markerBufferRef.current.includes(SCENE_DONE_MARKER)) void finish("done");
    },
    [finish]
  );

  const start = useCallback(async () => {
    if (status !== "idle" && status !== "error") return;
    finishingRef.current = false;
    startedAtRef.current = 0;
    markerBufferRef.current = "";
    setError(null);
    setEndReason(null);
    setRemaining(LIMIT_SECONDS);
    setStatus("connecting");

    try {
      const response = await fetch("/api/practica/session", {
        method: "POST",
        headers: await jsonAuthHeaders(),
        body: JSON.stringify({ tripId: trip.id, sceneIndex })
      });
      const session = (await response.json().catch(() => ({}))) as {
        face?: FaceKind;
        conversationToken?: string;
        anamSessionToken?: string;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(
          session.error === "not_enabled" ? "No habilitado." : "No se pudo iniciar la sesión."
        );
      }
      if (!faceContainerRef.current) throw new Error("No se pudo preparar la ventana de video.");

      const selectedFace = session.face ?? face;
      const provider = await faceProvider(selectedFace);

      if (selectedFace === "anam") {
        const handle = await provider.start({
          container: faceContainerRef.current,
          anamSessionToken: session.anamSessionToken,
          onAgentMessage: inspectAgentText,
          onDisconnect: () => {
            if (!finishingRef.current) void finish("error");
          }
        });
        faceHandleRef.current = handle;
      } else {
        const handle = await provider.start({ container: faceContainerRef.current });
        faceHandleRef.current = handle;
        if (!session.conversationToken) throw new Error("Falta el token de conversación.");
        const conversation = await Conversation.startSession({
          conversationToken: session.conversationToken,
          overrides: {
            agent: {
              prompt: { prompt: scenePrompt(trip, scene) },
              firstMessage: sceneFirstMessage(scene)
            }
          },
          onModeChange: ({ mode }) => setSpeaking(mode === "speaking"),
          onMessage: ({ role, message }) => {
            if (role === "agent") inspectAgentText(message);
          },
          onError: () => {
            if (!finishingRef.current) void finish("error");
          },
          onDisconnect: () => {
            const elapsed = startedAtRef.current
              ? Math.floor((Date.now() - startedAtRef.current) / 1000)
              : 0;
            if (!finishingRef.current) void finish(elapsed >= LIMIT_SECONDS ? "timer" : "error");
          }
        });
        conversationRef.current = conversation;
        handle.receiveAudio({ getLevel: () => conversation.getOutputVolume() });
      }

      startedAtRef.current = Date.now();
      setStatus("live");
      timerRef.current = window.setInterval(() => {
        const elapsed = Math.floor((Date.now() - startedAtRef.current) / 1000);
        const left = Math.max(0, LIMIT_SECONDS - elapsed);
        setRemaining(left);
        if (left === 0) void finish("timer");
      }, 250);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo iniciar la sesión.");
      if (startedAtRef.current) await finish("error");
      else {
        setStatus("error");
        finishingRef.current = false;
        await Promise.allSettled([faceHandleRef.current?.stop()]);
        faceHandleRef.current = null;
      }
    }
  }, [face, finish, inspectAgentText, scene, sceneIndex, status, trip]);

  useEffect(() => {
    return () => {
      clearTimer();
      if (!finishingRef.current && startedAtRef.current) {
        finishingRef.current = true;
        void writeEndLog("user");
      }
      void conversationRef.current?.endSession();
      void faceHandleRef.current?.stop();
      audioRef.current?.pause();
    };
  }, [clearTimer, writeEndLog]);

  const hear = useCallback(
    async (phrase: string) => {
      try {
        const blob = await requestSpeech({
          text: phrase,
          sourceLanguage: trip.targetLanguage,
          targetLanguage: trip.targetLanguage
        });
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        audioRef.current?.pause();
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => {
          URL.revokeObjectURL(url);
          if (audioRef.current === audio) audioRef.current = null;
        };
        await audio.play();
      } catch {
        setError(copy.ttsFailed);
      }
    },
    [copy.ttsFailed, trip.targetLanguage]
  );

  const nextHref =
    sceneIndex + 1 < trip.scenes.length
      ? `/practica/${trip.id}/${sceneIndex + 1}`
      : "/practica";
  const backgroundStyle = scene.backgroundUrl
    ? { backgroundImage: `linear-gradient(rgba(12,10,9,.45),rgba(12,10,9,.88)),url(${scene.backgroundUrl})` }
    : undefined;

  return (
    <PracticaGate configured={configured}>
      <main
        className={`relative min-h-screen overflow-hidden bg-gradient-to-br ${scene.gradient} bg-cover bg-center text-amber-50`}
        style={backgroundStyle}
      >
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-[radial-gradient(circle_at_25%_15%,rgba(255,255,255,.12),transparent_35%)]"
        />
        <div className="relative mx-auto flex min-h-screen max-w-3xl flex-col gap-5 px-4 pb-[calc(env(safe-area-inset-bottom)+1.25rem)] pt-[calc(env(safe-area-inset-top)+1rem)]">
          <header className="pr-32 sm:pr-40">
            <Link href="/practica" className="text-sm text-amber-100/70">
              ← {copy.practicaBack}
            </Link>
            <p className="mt-3 text-xs uppercase tracking-[0.22em] text-amber-100/60">
              {copy.practicaScene} {sceneIndex + 1}/{trip.scenes.length}
            </p>
            <h1 className="mt-1 text-2xl font-semibold sm:text-4xl">{scene.title.learner}</h1>
            <p className="text-sm text-amber-100/70">{scene.title.target}</p>
          </header>

          <aside className="absolute right-4 top-[calc(env(safe-area-inset-top)+1rem)] flex flex-col items-center gap-2">
            <div
              ref={faceContainerRef}
              className={`h-24 w-24 rounded-full border-2 bg-stone-950/65 shadow-2xl sm:h-32 sm:w-32 ${
                speaking ? "border-amber-300" : "border-white/25"
              }`}
            >
              <div
                className="grid h-full w-full place-items-center rounded-full text-4xl text-amber-100/45"
                aria-hidden="true"
              >
                ●
              </div>
            </div>
            <span className="rounded-full bg-black/45 px-2 py-1 text-[10px] uppercase tracking-wider">Liz</span>
          </aside>

          <section className="max-w-xl rounded-3xl border border-white/15 bg-black/35 p-5 backdrop-blur-sm">
            <div className="space-y-2 text-sm leading-relaxed text-amber-50/90">
              {scene.setup.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
            <div className="mt-4 border-t border-white/10 pt-4">
              <p className="text-xs uppercase tracking-wider text-amber-200/65">{copy.practicaYourGoal}</p>
              <p className="mt-1 text-sm text-amber-50/85">{scene.doneCondition}</p>
            </div>
          </section>

          <section className="rounded-3xl border border-white/15 bg-black/30 p-4 backdrop-blur-sm">
            <h2 className="font-semibold">{copy.practicaPhrases}</h2>
            <p className="mt-1 text-xs text-amber-100/60">{copy.practicaListen}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {scene.targetPhrases.map((phrase) => (
                <button
                  key={phrase}
                  type="button"
                  onClick={() => void hear(phrase)}
                  className="min-h-[44px] rounded-full border border-amber-200/25 bg-amber-100/10 px-4 py-2 text-left text-sm text-amber-50 active:scale-[0.98]"
                >
                  🔊 {phrase}
                </button>
              ))}
            </div>
          </section>

          {status === "ended" || status === "error" ? (
            <section className="rounded-3xl border border-amber-200/30 bg-stone-950/80 p-5 shadow-2xl">
              <p className="text-xs uppercase tracking-[0.2em] text-amber-300/70">
                {endReason === "done" ? copy.practicaComplete : copy.practicaDebrief}
              </p>
              <p className="mt-3 text-sm leading-relaxed text-amber-50/85">{scene.debrief}</p>
              {error ? <p className="mt-3 text-sm text-rose-200">{error}</p> : null}
              <a href={nextHref} className="mt-5 flex min-h-[48px] items-center justify-center rounded-2xl bg-amber-300 px-5 py-3 font-semibold text-stone-950">
                {sceneIndex + 1 < trip.scenes.length ? copy.practicaNext : copy.practicaBack}
              </a>
            </section>
          ) : (
            <div className="mt-auto rounded-3xl border border-white/15 bg-stone-950/70 p-4 backdrop-blur-md">
              <div className="mb-3 flex items-center justify-between text-sm">
                <span>{status === "connecting" ? copy.practicaConnecting : copy.practicaReady}</span>
                <span className="font-mono text-lg tabular-nums" aria-label={copy.practicaTimer}>{clock(remaining)}</span>
              </div>
              {status === "live" ? (
                <div className="grid grid-cols-2 gap-3">
                  <button type="button" onClick={() => void finish("done")} className="min-h-[52px] rounded-2xl border border-emerald-300/30 bg-emerald-400/15 px-4 py-3 font-semibold text-emerald-100">
                    {copy.practicaDone} · Done
                  </button>
                  <button type="button" onClick={() => void finish("user")} className="min-h-[52px] rounded-2xl bg-rose-500 px-4 py-3 font-semibold text-white">
                    {copy.practicaEnd} · End
                  </button>
                </div>
              ) : (
                <button type="button" disabled={status === "connecting"} onClick={() => void start()} className="min-h-[54px] w-full rounded-2xl bg-amber-300 px-5 py-3 text-lg font-semibold text-stone-950 disabled:opacity-60">
                  {status === "connecting" ? copy.practicaConnecting : copy.practicaBegin}
                </button>
              )}
            </div>
          )}
        </div>
      </main>
    </PracticaGate>
  );
}
