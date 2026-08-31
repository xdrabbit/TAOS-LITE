// The Clear button on /fast — the four things it has to do, and the one thing
// it must never do.
//
// Tom asked for it from the field: a quiet button above the mic that puts the
// quickie box back to the state the screen opens in. Small feature, and three
// of its four requirements are the obvious ones (it shows only when there is
// something to clear, it resets the whole screen, it hands the caret back).
//
// The fourth is the reason this file exists. /fast meters into the normal
// monthly allowance by writing one row per SETTLED input (lib/fast/settle.ts),
// and the guard against billing the same words twice is a set held for the
// life of the visit. A reset button is exactly the kind of change that
// reaches for "and clear that too" — and it would be invisible when it broke,
// because a double-billed phrase looks identical on screen. So the negative is
// pinned here, in the same file as the feature that threatens it.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { hasSomethingToClear } from "@/lib/fast/clear";
import { billingKey } from "@/lib/fast/settle";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** The body of FastShell's `clear` callback, which is what most of this pins. */
function clearHandler(): string {
  const shell = source("components/FastShell.tsx");
  const start = shell.indexOf("const clear = useCallback(");
  expect(start).toBeGreaterThan(-1);
  const end = shell.indexOf("const copy = useCallback(", start);
  expect(end).toBeGreaterThan(start);
  return shell.slice(start, end);
}

// ───────────────────────────────────────────────────────────────────────────
// 1. It is only there when there is something to clear
// ───────────────────────────────────────────────────────────────────────────

describe("hasSomethingToClear — the visibility toggle", () => {
  it("is absent on an empty box", () => {
    // The screen opens with two controls on the box and it should still be
    // two. /fast's whole virtue is that nothing is between somebody and the
    // word they wanted.
    expect(hasSomethingToClear("", "")).toBe(false);
  });

  it("appears as soon as a letter is typed", () => {
    expect(hasSomethingToClear("h", "")).toBe(true);
  });

  it("counts a tentative tail as content", () => {
    // The streaming mic draws hypotheses OUTSIDE `input` so they cannot start
    // a translation (lib/fast/liveTranscript.ts). For the first second of a
    // latched dictation that tail is the only thing on the box — and it is
    // plainly something a thumb would want to clear.
    expect(hasSomethingToClear("", "where is the phar")).toBe(true);
  });

  it("treats whitespace as content rather than as an empty box", () => {
    // Untrimmed on purpose: the caret is sitting after those spaces, and a
    // button that vanished while the box still held them would be lying.
    expect(hasSomethingToClear("   ", "")).toBe(true);
  });
});

describe("the button is rendered from that predicate, in a reserved slot", () => {
  const shell = source("components/FastShell.tsx");

  it("gates on hasSomethingToClear rather than on a hand-rolled check", () => {
    expect(shell).toContain("hasSomethingToClear(input, dictation.partial)");
    expect(shell).toMatch(/\{clearable \? \(/);
  });

  it("carries the bilingual label Tom asked for", () => {
    expect(shell).toContain('aria-label="Borrar · Clear"');
  });

  it("sits above the mic in one column, and is the smaller of the two", () => {
    // "Mic stays the star." The column is bottom-aligned inside the existing
    // `items-end` row, so the mic keeps the exact position it had before this
    // button existed and the small one stacks on top of it.
    const column = shell.slice(
      shell.indexOf('<div className="flex shrink-0 flex-col items-center gap-2">'),
      shell.indexOf('aria-label="Dictar · Dictate"')
    );
    expect(column).toContain('aria-label="Borrar · Clear"');
    expect(column).toContain("h-8 w-8"); // clear
    expect(shell).toContain("h-14 w-14"); // mic, untouched
  });

  it("reserves the slot so appearing costs no layout shift", () => {
    // The button comes and goes; the box it lives in does not. Without this
    // the mic would jump 40px the instant somebody typed their first letter —
    // under a thumb that is already on its way to it.
    expect(shell).toMatch(/<div className="flex h-8 items-center justify-center">\s*\{clearable \?/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. It resets the screen
// ───────────────────────────────────────────────────────────────────────────

describe("clear resets every piece of the answer on screen", () => {
  const handler = clearHandler();

  it.each([
    ['setInput("")', "the box itself"],
    ['setTranslation("")', "the rendered translation"],
    ["setDetected(null)", "the detected source the caption reads"],
    ["setTarget(null)", "the target the caption reads"],
    ["setEngine(null)", "the engine line under the answer"],
    ["setFallback(null)", "why the engine fell back"],
    ["setError(null)", "any error banner"],
    ["setBusy(false)", "the dimming that says a request is out"],
    ["setCopied(false)", "a stale Copied ✓ from the last quickie"]
  ])("clears %s — %s", (call) => {
    expect(handler).toContain(call);
  });

  it("orphans anything in flight so a late reply cannot repaint the box", () => {
    // Typing outruns the network constantly here. Without the bump, a request
    // issued a moment before the tap lands afterwards and paints a translation
    // into a box somebody just emptied.
    expect(handler).toContain("seqRef.current += 1");
  });

  it("cancels the mic, because a tail still arriving is text on its way in", () => {
    expect(handler).toContain("if (dictating) dictation.cancel()");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. It hands the caret back
// ───────────────────────────────────────────────────────────────────────────

describe("clear returns focus to the input", () => {
  it("focuses the textarea", () => {
    // Keyboard users must not have to reach for the box to carry on, and it
    // is also what makes the field flow work: clear, then type the next word.
    expect(clearHandler()).toContain("inputRef.current?.focus()");
  });

  it("leans on the post-dictation refocus for the live case", () => {
    // While the streaming view stands in for the textarea there is no element
    // to focus — the ref is null. The effect that already puts the caret back
    // when the mic lets go covers that render, so a clear during dictation
    // still ends with the caret in the box.
    const shell = source("components/FastShell.tsx");
    expect(shell).toContain("wasDictatingRef");
    expect(shell).toMatch(/if \(wasDictatingRef\.current && !dictating\)[\s\S]{0,200}el\.focus\(\)/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. THE MONEY ONE: it does not reset what has already been billed
// ───────────────────────────────────────────────────────────────────────────

describe("clear is a screen gesture, not a payment", () => {
  it("does not touch the billed set", () => {
    // The one assertion in this file that costs real money when it fails, and
    // the one that is invisible on screen: a cleared-and-retyped phrase that
    // billed twice looks exactly like one that billed once.
    const handler = clearHandler();
    expect(handler).not.toContain("billedRef");
  });

  it("does not hand the direction back to Auto either", () => {
    // Pinning is a decision about the conversation, not about the phrase.
    // Somebody who pinned ES→EN to read a menu is about to read the next line
    // of the same menu.
    expect(clearHandler()).not.toContain("setPinned");
  });

  it("re-entering the same words after a clear bills nothing more", () => {
    // The visit-long memory, walked: type, settle, clear, retype the same
    // thing. `billedRef` survives the clear, so the second settle is a no-op.
    const billed = new Set<string>();
    const settle = (text: string, from: string, to: string): boolean => {
      const key = billingKey(text, from, to);
      if (billed.has(key)) return false;
      billed.add(key);
      return true;
    };

    expect(settle("where is the pharmacy", "en", "es")).toBe(true);
    // …tap Clear. Nothing above this line is forgotten.
    expect(settle("where is the pharmacy", "en", "es")).toBe(false);
    expect(billed.size).toBe(1);
  });

  it("a genuinely new quickie after a clear bills exactly one fresh row", () => {
    // The other half of the ask: clearing must not make the NEXT lookup free
    // either. New words settle and count, once.
    const billed = new Set<string>();
    const settle = (text: string, from: string, to: string): boolean => {
      const key = billingKey(text, from, to);
      if (billed.has(key)) return false;
      billed.add(key);
      return true;
    };

    expect(settle("where is the pharmacy", "en", "es")).toBe(true);
    // …tap Clear, then look the next thing up.
    expect(settle("how much is this", "en", "es")).toBe(true);
    // Previews of that second phrase, arriving as it was typed, still add up
    // to the one row it is worth.
    expect(settle("how much is this", "en", "es")).toBe(false);
    expect(billed.size).toBe(2);
  });
});
