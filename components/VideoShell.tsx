"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  LANGUAGE_OPTIONS,
  getLanguageLabel,
  type SupportedLanguageCode
} from "@/lib/realtime/languages";
import { supabase } from "@/lib/supabase";
import { toSrt, toVtt, type CaptionSegment } from "@/lib/video/captions";
import { MAX_VIDEO_BYTES } from "@/lib/video/storage";
import { SignIn } from "./SignIn";

// /video — feed TAOS a video (MP4/MOV/etc.), get translated closed captions.
// The browser uploads straight to Supabase Storage via a signed URL (a video
// can't fit through a serverless request body), then /api/video/process runs
// ffmpeg → whisper (segment timestamps) → per-segment translation and returns
// JSON segments. Everything after that — the player captions, the SRT/VTT
// downloads — is built client-side from those segments; the server keeps
// nothing (the upload is deleted after processing).

type Phase = "idle" | "uploading" | "processing" | "done";

interface ProcessResult {
  detectedLanguage: SupportedLanguageCode;
  targetLanguage: SupportedLanguageCode;
  sameLanguage: boolean;
  duration: number;
  segments: CaptionSegment[];
  warnings: string[];
}

// Client-side mirror of the server's ~50-minute audio ceiling, checked before
// spending minutes on an upload that would be rejected.
const MAX_DURATION_S = 50 * 60;

function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Read duration by pointing a detached <video> at the file. Best-effort: some
// containers won't report metadata in the browser — the server still enforces
// its own ceiling, this just fails fast on obvious over-length picks.
function readDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(probe.duration) ? probe.duration : null);
    };
    probe.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    probe.src = url;
  });
}

export function VideoShell(): JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [target, setTarget] = useState<string>("auto");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [captionTrack, setCaptionTrack] = useState<"translation" | "original">("translation");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Auth gating — same listener pattern as AppShell/ChatShell. Without this,
  // a signed-out visitor (e.g. a preview-deploy origin they never signed in
  // on) only found out at the "Caption this video" click, as a bare
  // "Please sign in again" error (field report 8/13).
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

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  const pickFile = useCallback((picked: File | null) => {
    setError(null);
    setResult(null);
    setPhase("idle");
    setVideoUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return picked ? URL.createObjectURL(picked) : null;
    });
    setFile(picked);
  }, []);

  const run = useCallback(async () => {
    if (!file || phase === "uploading" || phase === "processing") return;
    setError(null);
    setResult(null);

    if (file.size > MAX_VIDEO_BYTES) {
      setError(
        "That video is too large (300 MB max). Try trimming it or exporting at a lower quality."
      );
      return;
    }
    const duration = await readDuration(file);
    if (duration !== null && duration > MAX_DURATION_S) {
      setError("That video is too long (about 50 minutes max). Try splitting it.");
      return;
    }

    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      setError("Please sign in again.");
      return;
    }

    try {
      setPhase("uploading");
      const urlRes = await fetch("/api/video/upload-url", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, size: file.size })
      });
      const urlPayload = (await urlRes.json().catch(() => ({}))) as {
        path?: string;
        token?: string;
        bucket?: string;
        error?: string;
        details?: string;
      };
      if (!urlRes.ok || !urlPayload.path || !urlPayload.token || !urlPayload.bucket) {
        // Keep the details visible — the 8/13 field test surfaced only the
        // generic message and the actual cause had to be dug out server-side.
        const base = urlPayload.error || "Could not start the upload.";
        throw new Error(urlPayload.details ? `${base} (${urlPayload.details})` : base);
      }

      const { error: uploadErr } = await supabase.storage
        .from(urlPayload.bucket)
        .uploadToSignedUrl(urlPayload.path, urlPayload.token, file, {
          contentType: file.type || "video/mp4"
        });
      if (uploadErr) {
        throw new Error(`Upload failed: ${uploadErr.message}`);
      }

      setPhase("processing");
      const res = await fetch("/api/video/process", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ path: urlPayload.path, targetLanguage: target })
      });
      const payload = (await res.json().catch(() => ({}))) as Partial<ProcessResult> & {
        error?: string;
        details?: string;
      };
      if (!res.ok || !Array.isArray(payload.segments)) {
        // Show error AND details — the 8/13 hunt for "Video caption pipeline
        // failed" took a server-side repro because the cause was hidden here.
        const base = payload.error || "Processing failed.";
        throw new Error(payload.details ? `${base} (${payload.details})` : base);
      }
      setResult(payload as ProcessResult);
      setCaptionTrack(payload.sameLanguage ? "original" : "translation");
      setPhase("done");
    } catch (e) {
      // The upload is deleted server-side after every attempt, so a retry
      // starts over from the upload step — that's expected.
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setPhase("idle");
    }
  }, [file, phase, target]);

  // Caption artifacts, rebuilt whenever the result or track choice changes.
  const vttUrl = useMemo(() => {
    if (!result) return null;
    const blob = new Blob([toVtt(result.segments, captionTrack)], { type: "text/vtt" });
    return URL.createObjectURL(blob);
  }, [result, captionTrack]);
  useEffect(() => {
    return () => {
      if (vttUrl) URL.revokeObjectURL(vttUrl);
    };
  }, [vttUrl]);

  // Web Share API support, resolved client-side. iOS/Android get the native
  // share sheet (Messages/WhatsApp — the whole point: texting Liz the
  // captions without a download-and-dig through Safari's Downloads). Desktop
  // browsers without navigator.share just keep the download buttons.
  const [shareSupport, setShareSupport] = useState<{ text: boolean; files: boolean }>({
    text: false,
    files: false
  });
  useEffect(() => {
    if (typeof navigator === "undefined" || typeof navigator.share !== "function") return;
    const probe = new File(["x"], "captions.srt", { type: "text/plain" });
    setShareSupport({
      text: true,
      files: typeof navigator.canShare === "function" && navigator.canShare({ files: [probe] })
    });
  }, []);

  const shareTranscript = useCallback(async () => {
    if (!result) return;
    const track = result.sameLanguage ? "text" : "translation";
    const body = result.segments
      .map((s) => (track === "translation" ? (s.translation ?? s.text) : s.text))
      .join("\n");
    try {
      await navigator.share({
        title: "TAOS captions",
        text: body
      });
    } catch {
      // Canceled share sheet — not an error worth surfacing.
    }
  }, [result]);

  const shareSrt = useCallback(async () => {
    if (!result || !file) return;
    const base = file.name.replace(/\.[^.]+$/, "") || "captions";
    const lang = result.sameLanguage ? result.detectedLanguage : result.targetLanguage;
    const srt = toSrt(result.segments, result.sameLanguage ? "original" : "translation");
    // text/plain, not application/x-subrip — iOS refuses to share MIME types
    // it doesn't recognize, and every player opens .srt by extension anyway.
    const srtFile = new File([srt], `${base}.${lang}.srt`, { type: "text/plain" });
    try {
      await navigator.share({ title: "TAOS captions", files: [srtFile] });
    } catch {
      // Canceled share sheet.
    }
  }, [result, file]);

  const downloads = useMemo(() => {
    if (!result || !file) return [];
    const base = file.name.replace(/\.[^.]+$/, "") || "captions";
    const items: { label: string; name: string; url: string }[] = [];
    const add = (label: string, name: string, content: string, type: string) =>
      items.push({ label, name, url: URL.createObjectURL(new Blob([content], { type })) });
    if (!result.sameLanguage) {
      add(
        `${getLanguageLabel(result.targetLanguage)} .srt`,
        `${base}.${result.targetLanguage}.srt`,
        toSrt(result.segments, "translation"),
        "text/plain"
      );
      add(
        `${getLanguageLabel(result.targetLanguage)} .vtt`,
        `${base}.${result.targetLanguage}.vtt`,
        toVtt(result.segments, "translation"),
        "text/vtt"
      );
    }
    add(
      `${getLanguageLabel(result.detectedLanguage)} .srt`,
      `${base}.${result.detectedLanguage}.srt`,
      toSrt(result.segments, "original"),
      "text/plain"
    );
    add(
      `${getLanguageLabel(result.detectedLanguage)} .vtt`,
      `${base}.${result.detectedLanguage}.vtt`,
      toVtt(result.segments, "original"),
      "text/vtt"
    );
    return items;
  }, [result, file]);
  useEffect(() => {
    return () => {
      downloads.forEach((d) => URL.revokeObjectURL(d.url));
    };
  }, [downloads]);

  const busy = phase === "uploading" || phase === "processing";

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
            Video captions · Subtítulos
          </div>
          <p className="mt-1 text-sm text-amber-50/70">
            Drop in an MP4 or MOV and get translated closed captions. English becomes Spanish,
            Spanish becomes English — or pick a language below.
          </p>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="video/*,audio/*,.mp4,.mov,.m4v,.webm,.mkv"
          className="hidden"
          onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
        />

        {!file ? (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex min-h-[9rem] flex-col items-center justify-center gap-2 rounded-3xl border border-dashed border-amber-300/40 bg-amber-400/5 px-6 py-8 text-amber-100/80 transition active:scale-[0.99]"
          >
            <span className="text-3xl" aria-hidden="true">
              🎬
            </span>
            <span className="text-sm font-medium">Choose a video · Elige un video</span>
            <span className="text-xs text-amber-100/50">MP4, MOV… up to 300 MB / ~50 min</span>
          </button>
        ) : (
          <div className="flex flex-col gap-3 rounded-3xl border border-white/10 bg-white/5 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-amber-100">{file.name}</div>
                <div className="text-xs text-amber-100/50">
                  {(file.size / (1024 * 1024)).toFixed(1)} MB
                </div>
              </div>
              <button
                type="button"
                onClick={() => pickFile(null)}
                disabled={busy}
                className="shrink-0 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-amber-100/70 disabled:opacity-40"
              >
                Change
              </button>
            </div>

            <label className="flex items-center justify-between gap-3 text-sm text-amber-100/80">
              <span>Captions in</span>
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                disabled={busy}
                className="rounded-xl border border-white/10 bg-stone-900 px-3 py-1.5 text-sm text-amber-100"
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
              onClick={() => void run()}
              disabled={busy}
              className="rounded-2xl bg-amber-400 px-4 py-3 text-sm font-semibold text-stone-950 transition active:scale-[0.99] disabled:opacity-60"
            >
              {phase === "uploading"
                ? "Uploading… · Subiendo…"
                : phase === "processing"
                  ? "Translating captions… · Traduciendo…"
                  : "Caption this video · Subtitular"}
            </button>
            {busy ? (
              <p className="text-center text-xs text-amber-100/50">
                {phase === "uploading"
                  ? "Sending the video for processing."
                  : "Listening, transcribing, translating — a few minutes for long videos. Keep this page open."}
              </p>
            ) : null}
          </div>
        )}

        {error ? (
          <div className="rounded-2xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        ) : null}

        {result && videoUrl ? (
          <div className="flex flex-col gap-3">
            <video
              key={captionTrack}
              controls
              playsInline
              src={videoUrl}
              className="w-full rounded-2xl border border-white/10 bg-black"
              crossOrigin="anonymous"
            >
              {vttUrl ? (
                <track
                  default
                  kind="subtitles"
                  label={getLanguageLabel(
                    captionTrack === "translation" ? result.targetLanguage : result.detectedLanguage
                  )}
                  srcLang={
                    captionTrack === "translation" ? result.targetLanguage : result.detectedLanguage
                  }
                  src={vttUrl}
                />
              ) : null}
            </video>

            <div className="flex items-center justify-between gap-2 text-xs text-amber-100/60">
              <span>
                Heard {getLanguageLabel(result.detectedLanguage)}
                {result.sameLanguage
                  ? " — captions match the video's language."
                  : ` → captions in ${getLanguageLabel(result.targetLanguage)}.`}
              </span>
              {!result.sameLanguage ? (
                <button
                  type="button"
                  onClick={() =>
                    setCaptionTrack((t) => (t === "translation" ? "original" : "translation"))
                  }
                  className="shrink-0 rounded-full border border-amber-300/30 bg-amber-400/10 px-3 py-1 text-amber-200"
                >
                  Show {captionTrack === "translation" ? "original" : "translation"}
                </button>
              ) : null}
            </div>

            {result.warnings.length > 0 ? (
              <div className="rounded-2xl border border-amber-300/30 bg-amber-400/10 px-4 py-3 text-xs text-amber-100/80">
                {result.warnings.map((w) => (
                  <p key={w}>{w}</p>
                ))}
              </div>
            ) : null}

            {shareSupport.text ? (
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => void shareTranscript()}
                  className="rounded-2xl bg-amber-400 px-4 py-2.5 text-sm font-semibold text-stone-950 transition active:scale-[0.99]"
                >
                  ↗ Share text · Texto
                </button>
                {shareSupport.files ? (
                  <button
                    type="button"
                    onClick={() => void shareSrt()}
                    className="rounded-2xl border border-amber-300/40 bg-amber-400/10 px-4 py-2.5 text-sm font-semibold text-amber-200 transition active:scale-[0.99]"
                  >
                    ↗ Share .srt
                  </button>
                ) : null}
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2">
              {downloads.map((d) => (
                <a
                  key={d.name}
                  href={d.url}
                  download={d.name}
                  className="rounded-full border border-amber-300/30 bg-amber-400/10 px-3 py-1.5 text-xs text-amber-200"
                >
                  ⬇ {d.label}
                </a>
              ))}
            </div>

            <div className="max-h-80 overflow-y-auto rounded-2xl border border-white/10 bg-white/5">
              {result.segments.map((seg, i) => (
                <div
                  key={`${seg.start}-${i}`}
                  className="border-b border-white/5 px-4 py-2.5 last:border-b-0"
                >
                  <div className="text-[10px] tabular-nums text-amber-100/40">
                    {formatClock(seg.start)} – {formatClock(seg.end)}
                  </div>
                  <div className="text-sm text-amber-50">{seg.translation ?? seg.text}</div>
                  {seg.translation ? (
                    <div className="text-xs text-amber-100/50">{seg.text}</div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </main>
  );
}
