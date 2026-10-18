export interface ShareAudioOptions {
  fileName: string;
  title: string;
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
