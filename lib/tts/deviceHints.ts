// The two device hints every /api/tts request carries for the request log
// (lib/tts/requestLog.ts): which screen asked, and whether the page is an
// installed Home Screen app rather than a browser tab. On an iPhone those two
// are different storage worlds — a Home Screen app does not share Safari's
// localStorage, so it can be locked while the Safari tab is unlocked.
//
// Isomorphic on purpose (no node: imports): the screens send these and the
// route reads them, from one definition. They are headers, not body fields,
// so the request body the route's tests pin stays exactly what it was. They
// never change which voice is chosen.

export const TTS_SURFACES = [
  "home",
  "call",
  "live",
  "tabletop",
  "chat",
  "study",
  "tutor",
  "fast",
  "try"
] as const;
export type TtsSurface = (typeof TTS_SURFACES)[number] | "unknown";

/** The screen that asked for the line. */
export const TTS_SURFACE_HEADER = "x-taos-surface";
/** "1" when the page runs as an installed Home Screen app. */
export const TTS_STANDALONE_HEADER = "x-taos-standalone";

export function parseSurface(raw: string | null | undefined): TtsSurface {
  const v = raw?.trim().toLowerCase();
  return TTS_SURFACES.find((s) => s === v) ?? "unknown";
}

export function parseStandalone(raw: string | null | undefined): boolean {
  return raw?.trim() === "1";
}

/** Spread into the headers of any /api/tts call. */
export function ttsDeviceHeaders(surface: TtsSurface = "unknown"): Record<string, string> {
  let standalone = false;
  try {
    standalone =
      typeof window !== "undefined" &&
      window.matchMedia?.("(display-mode: standalone)").matches === true;
  } catch {
    standalone = false;
  }
  return { [TTS_SURFACE_HEADER]: surface, [TTS_STANDALONE_HEADER]: standalone ? "1" : "0" };
}
