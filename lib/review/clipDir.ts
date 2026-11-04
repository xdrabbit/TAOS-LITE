// Reading a clip set off disk — the half of lib/review/clipSet.ts that needs
// node:fs. Used by the transcriber probe (tests/live-fire/
// transcribe-accuracy.measure.ts) and by the export round-trip test, so the
// probe reads exactly what the export wrote.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { CLIP_MIME, parseClipScript, type ClipPart } from "./clipSet";

export interface ClipFile {
  /** The file name without its extension. */
  stem: string;
  name: string;
  mime: string;
  bytes: Buffer;
  parts: ClipPart[];
}

/**
 * Every audio file in `dir` that has a `<stem>.txt` beside it, sorted by
 * name. A clip with no script is reported through `onSkip` and left out.
 */
export function readClipDir(dir: string, onSkip: (name: string) => void = () => {}): ClipFile[] {
  const out: ClipFile[] = [];
  for (const name of readdirSync(dir).sort()) {
    const ext = extname(name).toLowerCase();
    if (!CLIP_MIME[ext]) continue;
    const stem = basename(name, extname(name));
    const script = join(dir, `${stem}.txt`);
    if (!existsSync(script)) {
      onSkip(name);
      continue;
    }
    out.push({
      stem,
      name,
      mime: CLIP_MIME[ext],
      bytes: readFileSync(join(dir, name)),
      parts: parseClipScript(readFileSync(script, "utf8"))
    });
  }
  return out;
}
