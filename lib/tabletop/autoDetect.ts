// Reading the language tag an auto-detect table response opens with.
//
// In auto-detect mode (lib/tabletop/instructions.ts, buildAutoInstructions)
// every response starts `[xx] ` — the catalog code of the language the model
// WROTE. That one tag decides three things on the phone: which pane the words
// land in (the pane whose language they are), which language the readout is
// spoken FROM (the other one — so /api/tts's voice-follows-speaker rule picks
// the right clone), and the direction the exchange is recorded with.
//
// ── A miss is not a guess ──────────────────────────────────────────────────
// No tag, a tag that is not one of the table's two codes, or a "tag" that never
// closes: all the same answer, `miss`. The caller does not guess a direction
// from the text — it keeps the last direction it knew, marks the exchange
// `detect: "miss"`, and counts it, so a field test can say how often the model
// broke format instead of hiding it inside a wrong-voice readout.
//
// ── The tag arrives in pieces ──────────────────────────────────────────────
// The realtime API streams deltas of a token or so, and `[es] ` is often two
// of them (`[e` + `s] …`). createTagStream holds back the opening characters
// until it can decide, then hands the rest through untouched, so a pane never
// flashes `[e` before the tag resolves.

/** What the tag said: the output language, or a miss. */
export type TagVerdict = { kind: "hit"; code: string } | { kind: "miss" };

/** Longest bracketed run that can still be a tag. Catalog codes are 2–3 letters. */
const MAX_TAG_CHARS = 8;
const TAG_RE = /^\s*\[([A-Za-z]{2,3})\]\s*/;
// Could still BECOME a tag with more characters: optional leading space, "[",
// up to a few letters, no "]" yet.
const PARTIAL_TAG_RE = /^\s*(\[[A-Za-z]{0,3})?$/;

function verdictFor(code: string, pair: readonly [string, string]): TagVerdict {
  const c = code.toLowerCase();
  return c === pair[0] || c === pair[1] ? { kind: "hit", code: c } : { kind: "miss" };
}

/**
 * One whole response's text → its verdict and the text with the tag removed.
 * A miss leaves the text exactly as it came (trimmed), tag-looking or not:
 * stripping a tag we did not accept would hide the very thing that went wrong.
 */
export function parseTag(
  raw: string,
  pair: readonly [string, string]
): { verdict: TagVerdict; text: string } {
  const m = TAG_RE.exec(raw);
  if (m) {
    const verdict = verdictFor(m[1], pair);
    if (verdict.kind === "hit") return { verdict, text: raw.slice(m[0].length).trim() };
  }
  return { verdict: { kind: "miss" }, text: raw.trim() };
}

/**
 * The streaming form, one per RESPONSE. `push` each delta in order; it returns
 * the text that is safe to render now (possibly "") and, exactly once, the
 * verdict — on the push that decided it. `end` flushes anything still held
 * back (a response that stopped mid-tag) and decides as a miss if it never
 * did.
 */
export function createTagStream(pair: readonly [string, string]) {
  let held = "";
  let decided = false;

  const decide = (): { text: string; verdict: TagVerdict } => {
    decided = true;
    const m = TAG_RE.exec(held);
    const out =
      m && verdictFor(m[1], pair).kind === "hit"
        ? { verdict: verdictFor(m[1], pair), text: held.slice(m[0].length) }
        : { verdict: { kind: "miss" } as TagVerdict, text: held.replace(/^\s+/, "") };
    held = "";
    return out;
  };

  return {
    push(delta: string): { text: string; verdict?: TagVerdict } {
      if (decided) return { text: delta };
      held += delta;
      // `[es]` with nothing after it yet: the space (and the translation)
      // may still be on its way, but the verdict already is not.
      if (TAG_RE.test(held)) {
        const m = TAG_RE.exec(held)!;
        // Wait for at least one character past the tag so a trailing space
        // split across deltas is still swallowed with it.
        if (m[0].length === held.length && held.length <= MAX_TAG_CHARS + 2) return { text: "" };
        return decide();
      }
      if (PARTIAL_TAG_RE.test(held) && held.trimStart().length <= MAX_TAG_CHARS) return { text: "" };
      return decide();
    },
    end(): { text: string; verdict?: TagVerdict } {
      if (decided) return { text: "" };
      if (!held.trim()) {
        // Nothing but whitespace ever arrived: an empty response, not a miss.
        held = "";
        decided = true;
        return { text: "" };
      }
      return decide();
    }
  };
}
