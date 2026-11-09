// The captions of an Interpreter-mode session, as data: one entry per thing
// the interpreter said, with what it heard beside it. Pure — the engines emit
// updates (lib/interpreter/client.ts), this folds them into a list, and the
// two panes of the table each read the list in their own reader's language.
//
// OLDEST FIRST, always (#101 / #117): an entry is appended when it starts and
// updated in place while it streams; nothing is ever re-ordered or put on
// top. Entries live in component state only — nothing here is stored or sent
// anywhere.

export interface CaptionEntry {
  id: string;
  /** Language spoken / language interpreted into. Null = a one-session table, which cannot say. */
  source: string | null;
  target: string | null;
  /** What the speaker said, as the transcriber heard it. */
  heard: string;
  /** What the interpreter said. */
  said: string;
  /** Still being written. */
  live: boolean;
  at: number;
}

export interface CaptionUpdate {
  id: string;
  source: string | null;
  target: string | null;
  heard?: string;
  said?: string;
  live?: boolean;
  at: number;
}

/** A dinner is long; the screen keeps the recent part of it. */
export const MAX_CAPTIONS = 60;

export function applyCaption(
  entries: readonly CaptionEntry[],
  update: CaptionUpdate,
  max: number = MAX_CAPTIONS
): CaptionEntry[] {
  const index = entries.findIndex((e) => e.id === update.id);
  if (index === -1) {
    const next: CaptionEntry = {
      id: update.id,
      source: update.source,
      target: update.target,
      heard: update.heard ?? "",
      said: update.said ?? "",
      live: update.live ?? true,
      at: update.at
    };
    // Nothing to show yet → nothing on screen yet.
    if (!next.heard.trim() && !next.said.trim()) return entries.slice();
    return [...entries, next].slice(-max);
  }
  const prev = entries[index];
  const merged: CaptionEntry = {
    ...prev,
    heard: update.heard ?? prev.heard,
    said: update.said ?? prev.said,
    live: update.live ?? prev.live
  };
  const out = entries.slice();
  out[index] = merged;
  return out;
}

/** Every entry stops streaming — the session ended. */
export function settleCaptions(entries: readonly CaptionEntry[]): CaptionEntry[] {
  return entries.map((e) => (e.live ? { ...e, live: false } : e));
}

/**
 * How one entry reads from one end of the table.
 *
 *   incoming  the OTHER person spoke; this is the interpretation, in this
 *             reader's language. The line the pane exists for — big.
 *   outgoing  this reader spoke; this is their own words as heard — small,
 *             so they can see they were understood.
 *   both      a one-session table: no sides, so both lines, on both panes.
 */
export type PaneLine =
  | { id: string; kind: "incoming"; text: string; live: boolean }
  | { id: string; kind: "outgoing"; text: string; live: boolean }
  | { id: string; kind: "both"; heard: string; said: string; live: boolean };

export function paneLines(entries: readonly CaptionEntry[], lang: string): PaneLine[] {
  const out: PaneLine[] = [];
  for (const e of entries) {
    if (e.source === null || e.target === null) {
      if (e.heard.trim() || e.said.trim()) {
        out.push({ id: e.id, kind: "both", heard: e.heard, said: e.said, live: e.live });
      }
    } else if (e.target === lang) {
      if (e.said.trim()) out.push({ id: e.id, kind: "incoming", text: e.said, live: e.live });
    } else if (e.source === lang) {
      if (e.heard.trim()) out.push({ id: e.id, kind: "outgoing", text: e.heard, live: e.live });
    }
  }
  return out;
}

/** The text a pane is streaming right now — what follow-the-tail watches. */
export function paneStreamingText(lines: readonly PaneLine[]): { on: boolean; text: string } {
  const live = lines.filter((l) => l.live);
  if (!live.length) return { on: false, text: "" };
  return {
    on: true,
    text: live.map((l) => (l.kind === "both" ? `${l.heard}\n${l.said}` : l.text)).join("\n")
  };
}
