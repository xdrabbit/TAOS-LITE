// Browser half of the personal-voice gate: hold the code on the phone and
// attach it to TTS requests. The decision itself is the server's
// (lib/tts/personalVoice.ts) — nothing here is a security boundary, it just
// carries the key. A phone without it is locked no matter what it sends.

import { PERSONAL_VOICE_HEADER, PERSONAL_VOICE_STORAGE_KEY } from "./personalVoice";

// localStorage throws in Safari private browsing, and doesn't exist during
// SSR — either way the answer is "locked", never a crash mid-conversation.
function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readPersonalVoiceCode(): string | null {
  const code = storage()?.getItem(PERSONAL_VOICE_STORAGE_KEY)?.trim();
  return code ? code : null;
}

export function savePersonalVoiceCode(code: string): void {
  storage()?.setItem(PERSONAL_VOICE_STORAGE_KEY, code.trim());
}

export function clearPersonalVoiceCode(): void {
  storage()?.removeItem(PERSONAL_VOICE_STORAGE_KEY);
}

export function isPersonalVoiceUnlocked(): boolean {
  return readPersonalVoiceCode() !== null;
}

/**
 * Spread into the headers of any /api/tts call. Empty on a locked phone, so
 * the request looks exactly like a stranger's — which it is.
 */
export function personalVoiceHeaders(): Record<string, string> {
  const code = readPersonalVoiceCode();
  return code ? { [PERSONAL_VOICE_HEADER]: code } : {};
}

/** Asks the server whether a typed code is the real one. */
export async function verifyPersonalVoiceCode(code: string): Promise<boolean> {
  try {
    const res = await fetch("/api/tts/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code })
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}
