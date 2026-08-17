"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { fetchWithRetry, isConnectionError } from "@/lib/net";
import { LANGUAGE_OPTIONS } from "@/lib/realtime/languages";
import { supabase } from "@/lib/supabase";
import { SignIn } from "./SignIn";

// /vision — point the camera at a sign, menu, or label (or pick a photo) and
// get the text translated. The browser downscales the photo to a small JPEG
// before upload (a raw phone photo would blow through the serverless
// request-body limit), /api/vision reads it with a vision model, and the
// original + translation come back as text. Nothing is stored.

type Phase = "idle" | "translating" | "done";

interface VisionResponse {
  sourceLang: string;
  targetLanguage: string;
  original: string;
  translation: string;
}

// Downscale to ~1600px JPEG. Big enough that menu print stays readable to the
// model, small enough (~300–800 KB) to travel over cellular fast. Decoding
// via <img> also converts iPhone HEIC on Safari for free.
const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.85;

// The server can detect languages outside LANGUAGE_OPTIONS (a French menu in
// auto mode is still read) — fall back to the raw code instead of narrowing
// the type.
function languageLabel(code: string): string {
  return LANGUAGE_OPTIONS.find((l) => l.code === code)?.label ?? code.toUpperCase();
}

function downscaleToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, MAX_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Could not process the image."));
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read that image format."));
    };
    img.src = url;
  });
}

export function VisionShell(): JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [image, setImage] = useState<string | null>(null);
  const [target, setTarget] = useState<string>("auto");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VisionResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const libraryInputRef = useRef<HTMLInputElement | null>(null);

  // Auth gating — same listener pattern as VideoShell/ChatShell (the 8/13
  // field report: a signed-out visitor must see SignIn, not a click-time
  // "Please sign in again").
  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setReady(true);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const pickImage = useCallback(async (file: File | null) => {
    setError(null);
    setResult(null);
    setPhase("idle");
    setCopied(false);
    if (!file) {
      setImage(null);
      return;
    }
    try {
      setImage(await downscaleToDataUrl(file));
    } catch (e) {
      setImage(null);
      setError(e instanceof Error ? e.message : "Could not read that image.");
    }
  }, []);

  const run = useCallback(async () => {
    if (!image || phase === "translating") return;
    setError(null);
    setResult(null);
    setCopied(false);

    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      setError("Please sign in again.");
      return;
    }

    try {
      setPhase("translating");
      const res = await fetchWithRetry(
        "/api/vision",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ image, targetLanguage: target })
        },
        { timeoutMs: 75000 }
      );
      const payload = (await res.json().catch(() => ({}))) as Partial<VisionResponse> & {
        error?: string;
        details?: string;
      };
      if (!res.ok || !payload.translation) {
        const base = payload.error || "Photo translation failed.";
        throw new Error(payload.details ? `${base} (${payload.details})` : base);
      }
      setResult(payload as VisionResponse);
      setPhase("done");
    } catch (e) {
      setError(
        isConnectionError(e)
          ? "Connection problem — check your signal and try again. · Problema de conexión."
          : e instanceof Error
            ? e.message
            : "Something went wrong."
      );
      setPhase("idle");
    }
  }, [image, phase, target]);

  const copyTranslation = useCallback(async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.translation);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked — the text is on screen to select by hand.
    }
  }, [result]);

  const shareTranslation = useCallback(async () => {
    if (!result) return;
    try {
      await navigator.share({ title: "TAOS translation", text: result.translation });
    } catch {
      // Canceled share sheet — not an error worth surfacing.
    }
  }, [result]);

  const busy = phase === "translating";

  if (!ready) {
    return (
      <main className="flex min-h-screen items-center justify-center text-amber-100/60">
        Loading…
      </main>
    );
  }
  if (!session) {
    return <SignIn />;
  }

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
          <div className="text-xs uppercase tracking-[0.2em] text-amber-100/50">
            Photo translator · Traductor de fotos
          </div>
          <p className="mt-1 text-sm text-amber-50/70">
            Point the camera at a sign, menu, or label — or pick a photo — and read it in your
            language. English becomes Spanish, Spanish becomes English, or choose below.
          </p>
        </div>

        {/* Two inputs: `capture` opens the camera directly on phones; the
            plain one opens the photo library. */}
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            void pickImage(e.target.files?.[0] ?? null);
            e.target.value = "";
          }}
        />
        <input
          ref={libraryInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            void pickImage(e.target.files?.[0] ?? null);
            e.target.value = "";
          }}
        />

        {!image ? (
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => cameraInputRef.current?.click()}
              className="flex min-h-[9rem] flex-col items-center justify-center gap-2 rounded-3xl border border-dashed border-amber-300/40 bg-amber-400/5 px-4 py-8 text-amber-100/80 transition active:scale-[0.99]"
            >
              <span className="text-3xl" aria-hidden="true">
                📷
              </span>
              <span className="text-sm font-medium">Camera · Cámara</span>
            </button>
            <button
              type="button"
              onClick={() => libraryInputRef.current?.click()}
              className="flex min-h-[9rem] flex-col items-center justify-center gap-2 rounded-3xl border border-dashed border-amber-300/40 bg-amber-400/5 px-4 py-8 text-amber-100/80 transition active:scale-[0.99]"
            >
              <span className="text-3xl" aria-hidden="true">
                🖼️
              </span>
              <span className="text-sm font-medium">Photo · Foto</span>
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-3 rounded-3xl border border-white/10 bg-white/5 p-4">
            {/* eslint-disable-next-line @next/next/no-img-element -- local data URL preview */}
            <img
              src={image}
              alt="Selected photo"
              className="max-h-72 w-full rounded-2xl border border-white/10 object-contain"
            />
            <div className="flex items-center justify-between gap-3">
              <label className="flex min-w-0 flex-1 items-center justify-between gap-3 text-sm text-amber-100/80">
                <span className="shrink-0">Read it in</span>
                <select
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  disabled={busy}
                  className="min-w-0 rounded-xl border border-white/10 bg-stone-900 px-3 py-1.5 text-sm text-amber-100"
                >
                  <option value="auto">Auto · EN ↔ ES</option>
                  {LANGUAGE_OPTIONS.map((lang) => (
                    <option key={lang.code} value={lang.code}>
                      {lang.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => void pickImage(null)}
                disabled={busy}
                className="shrink-0 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-amber-100/70 disabled:opacity-40"
              >
                Change
              </button>
            </div>
            <button
              type="button"
              onClick={() => void run()}
              disabled={busy}
              className="rounded-2xl bg-amber-400 px-4 py-3 text-sm font-semibold text-stone-950 transition active:scale-[0.99] disabled:opacity-60"
            >
              {busy ? "Reading the photo… · Leyendo…" : "Translate this photo · Traducir"}
            </button>
          </div>
        )}

        {error ? (
          <div className="rounded-2xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        ) : null}

        {result ? (
          <div className="flex flex-col gap-3">
            <div className="rounded-3xl border border-amber-300/20 bg-amber-400/5 p-4">
              <div className="text-xs uppercase tracking-[0.2em] text-amber-100/50">
                {languageLabel(result.targetLanguage)}
              </div>
              <div className="mt-1 whitespace-pre-wrap text-lg text-amber-50">
                {result.translation}
              </div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="text-xs uppercase tracking-[0.2em] text-amber-100/40">
                {result.sourceLang ? languageLabel(result.sourceLang) : "Original"}
              </div>
              <div className="mt-1 whitespace-pre-wrap text-sm text-amber-100/70">
                {result.original}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => void copyTranslation()}
                className="rounded-2xl border border-amber-300/40 bg-amber-400/10 px-4 py-2.5 text-sm font-semibold text-amber-200 transition active:scale-[0.99]"
              >
                {copied ? "Copied ✓ · Copiado" : "Copy · Copiar"}
              </button>
              {typeof navigator !== "undefined" && typeof navigator.share === "function" ? (
                <button
                  type="button"
                  onClick={() => void shareTranslation()}
                  className="rounded-2xl bg-amber-400 px-4 py-2.5 text-sm font-semibold text-stone-950 transition active:scale-[0.99]"
                >
                  ↗ Share · Compartir
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </main>
  );
}
