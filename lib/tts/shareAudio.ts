import { languageNative } from "@/lib/languages/catalog";
import { tagMp3 } from "./id3";

export interface ShareAudioOptions {
  fileName: string;
  title: string;
  /** Best-effort message beside the file; platforms that drop it drop it. */
  text?: string;
}

// ── Branding (Tom, 2026-10-24) ──────────────────────────────────────────────
// The shared file says where it came from in three places that never cost the
// recipient inline playback: its name, its ID3 tag, and the message beside it.
// The spoken sign-off is the server's (lib/tts/shareSignoff.ts).

/** One-line switch for the APIC cover art, should a player choke on it. */
export const SHARE_COVER_ART = true;
/** One-line switch for the share text, should a target drop the file for it. */
export const SHARE_TEXT_WITH_FILE = false;

export const SHARE_TAG_ARTIST = "TAOS·LITE";
export const SHARE_TAG_ALBUM = "taoslite.com";
export const SHARE_TAG_URL = "https://taoslite.com/try";
/** The app icon, small enough (≈6 KB) to ride in every shared file. */
export const SHARE_COVER_PATH = "/icons/icon-192.png";
const TITLE_MAX = 60;

/** `TAOS · Español · taoslite.com.mp3` — the target language's own name. */
export function shareFileName(target: string): string {
  const name = languageNative(target).replace(/[\\/:*?"<>|]/g, " ").trim();
  return `TAOS · ${name} · taoslite.com.mp3`;
}

/** The first ~60 characters of the translated line, cut on a character. */
export function shareTagTitle(text: string): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length <= TITLE_MAX ? chars.join("") : `${chars.slice(0, TITLE_MAX - 1).join("").trimEnd()}…`;
}

/** The message beside the file. */
export function shareText(translation: string): string {
  return `${translation}\n— taoslite.com`;
}

let coverArt: Promise<Uint8Array | null> | null = null;

/**
 * The cover PNG, fetched once per page and kept. Start it before the tap so
 * the share never waits on it; a failure resolves null (no art), not an error.
 */
export function loadShareCoverArt(fetchImpl: typeof fetch = fetch): Promise<Uint8Array | null> {
  if (!SHARE_COVER_ART) return Promise.resolve(null);
  coverArt ??= fetchImpl(SHARE_COVER_PATH)
    .then(async (res) => (res.ok ? new Uint8Array(await res.arrayBuffer()) : null))
    .catch(() => null)
    .then((png) => {
      if (!png) coverArt = null; // try again next time
      return png;
    });
  return coverArt;
}

/** The shared mp3, ID3-tagged. The audio frames are untouched. */
export async function brandSharedAudio(
  blob: Blob,
  translation: string,
  cover: Uint8Array | null
): Promise<Blob> {
  const audio = new Uint8Array(await blob.arrayBuffer());
  const tagged = tagMp3(audio, {
    title: shareTagTitle(translation),
    artist: SHARE_TAG_ARTIST,
    album: SHARE_TAG_ALBUM,
    url: SHARE_TAG_URL,
    coverPng: SHARE_COVER_ART ? cover : null
  });
  return new Blob([tagged as BlobPart], { type: "audio/mpeg" });
}

/**
 * One count per share tap, as a `[taos-share]` line in the Vercel log
 * (app/api/tts/share/route.ts). Fire and forget: a share never waits on it.
 */
export interface ShareTap {
  result: ShareAudioResult;
  lang: string;
  signoff: boolean;
  subscriber: boolean;
  files: 1;
  text: boolean;
  cover: boolean;
}

export function logShareTap(
  tap: ShareTap,
  headers: Record<string, string>,
  fetchImpl: typeof fetch = fetch
): void {
  try {
    void fetchImpl("/api/tts/share", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(tap),
      keepalive: true
    }).catch(() => undefined);
  } catch {
    // a lost count is fine
  }
}

export interface ShareAudioEnvironment {
  navigator: Pick<Navigator, "canShare" | "share">;
  document: Pick<Document, "body" | "createElement">;
  url: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;
}

export type ShareAudioResult = "shared" | "downloaded" | "cancelled";

function browserEnvironment(): ShareAudioEnvironment {
  return { navigator, document, url: URL };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function download(file: File, env: ShareAudioEnvironment): void {
  const objectUrl = env.url.createObjectURL(file);
  try {
    const anchor = env.document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = file.name;
    anchor.hidden = true;
    env.document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    env.url.revokeObjectURL(objectUrl);
  }
}

/**
 * Put one synthesized line on the native file share sheet, or download the
 * same file where file sharing is unavailable. A rejected share that is not
 * the person's explicit cancellation also downloads: Safari uses that path
 * when a fetch took long enough for it to drop the tap's user activation.
 */
export async function shareAudioFile(
  blob: Blob,
  options: ShareAudioOptions,
  env: ShareAudioEnvironment = browserEnvironment()
): Promise<ShareAudioResult> {
  const file = new File([blob], options.fileName, { type: blob.type || "audio/mpeg" });
  const files = [file];
  const shareData: ShareData = { files, title: options.title };
  if (options.text) shareData.text = options.text;

  let canShareFile = false;
  try {
    canShareFile =
      typeof env.navigator.share === "function" &&
      typeof env.navigator.canShare === "function" &&
      env.navigator.canShare({ files });
  } catch {
    canShareFile = false;
  }

  if (canShareFile) {
    try {
      await env.navigator.share(shareData);
      return "shared";
    } catch (error) {
      if (isAbortError(error)) return "cancelled";
      // NotAllowedError is the usual lost-user-gesture answer. Other share
      // failures get the same recoverable fallback rather than a dead tap.
    }
  }

  download(file, env);
  return "downloaded";
}
