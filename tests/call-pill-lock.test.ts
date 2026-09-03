// @vitest-environment jsdom
//
// The pill that was a label and behaved like a switch.
//
// Tom, mid-call on 2026-09-03, on a pair of [en, es]. The row showed ES solid
// and EN outlined. He wanted to hear English, saw the outlined EN pill, and
// tapped it. What he got was Spanish — because tapping your own side is the
// FLIP, the rule that gives one row of pills both EN⇄IT and ES⇄IT at a table
// (lib/translate/pair.ts). At a table that is a good rule and one tap undoes
// it. On a call it did three things at once: re-pointed the live interpreter,
// announced the new language down the data channel so his partner's phone
// followed him into the wrong language too, and persisted the flipped pair to
// localStorage for whatever screen he opened next.
//
// Two things were missing and both are fixed here. The row had no caption
// mid-call, so the ONLY thing distinguishing "solid" from "outlined" was a
// `title` — and a phone has no hover, so on the device where this row is used
// it said nothing at all. And the pill was a live control when it should have
// been a readout.
//
// This file renders the real picker and drives the real hook. Source-reading
// would have passed against the broken version: it rendered a `pairedTitle`
// of "You hear this · Tú escuchas esto" and called an onSelect, both of which
// grep exactly like a correct row.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { LanguagePillRow, LanguageSheet } from "@/components/LanguagePicker";
import type { LanguageCode } from "@/lib/languages/catalog";
import { PAIR_STORAGE_KEY } from "@/lib/translate/pair";
import { useLanguagePair } from "@/lib/translate/useLanguagePair";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

/** The row as /call draws it mid-call: [en, es], own side locked. */
function callRow(onSelect: (code: LanguageCode) => void) {
  return render(
    createElement(LanguagePillRow, {
      pills: ["en", "es", "it"],
      selected: "es",
      paired: "en",
      pairedTitle: "You hear this · Tú escuchas esto",
      pairedLocked: true,
      caption: "They speak · Ellos hablan",
      sheetOpen: false,
      onSelect,
      onOpenSheet: () => {}
    })
  );
}

describe("the in-call row says which side is which, on a phone", () => {
  it("captions the row instead of leaving it to a tooltip", () => {
    // The lobby row has carried this caption since /call came back on 8/27.
    // The in-call one passed no `caption` prop at all, so mid-call the screen
    // was two pill colours and nothing else.
    callRow(vi.fn());
    expect(screen.getByText("They speak · Ellos hablan")).toBeTruthy();
  });

  it("keeps the 44px tap-target floor on every pill", () => {
    // The floor #54 put on the nav pills on 8/31, applied to the row a
    // stranger holding the phone actually aims at. px-3 py-1.5 on a text-xs
    // line lays out 30px tall, and #53's rig measured a reaching thumb
    // drifting 12-20px — more than half of a 30px target.
    callRow(vi.fn());
    for (const button of screen.getAllByRole("button")) {
      expect(button.className).toContain("min-h-[44px]");
      // min-height does nothing without a box that can grow.
      expect(button.className).toContain("inline-flex");
      expect(button.className).toContain("items-center");
    }
  });
});

describe("your own pill is not a flip", () => {
  it("does nothing at all when it is tapped mid-call", () => {
    const onSelect = vi.fn();
    callRow(onSelect);
    // The pill Tom tapped: outlined, and labelled with the thing he wanted.
    fireEvent.click(screen.getByRole("button", { name: /You hear this/ }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("says so to a screen reader, without going silent", () => {
    // aria-disabled, not `disabled`: the pill is still the answer to "which
    // language am I hearing?", so it has to keep announcing its label and
    // stay reachable. It just is not a control.
    callRow(vi.fn());
    const own = screen.getByRole("button", { name: /You hear this/ });
    expect(own.getAttribute("aria-disabled")).toBe("true");
    expect((own as HTMLButtonElement).disabled).toBe(false);
  });

  it("still lets you change what your PARTNER speaks", () => {
    // The lock is about your own side, not about the row. Re-pointing the
    // interpreter mid-call is the one job this row has.
    const onSelect = vi.fn();
    callRow(onSelect);
    fireEvent.click(screen.getByRole("button", { name: /Italiano/ }));
    expect(onSelect).toHaveBeenCalledWith("it");
  });

  it("is a live flip again when nothing is locked — the table rule", () => {
    // /translate, /live and /tabletop pass no `pairedLocked` and must be
    // untouched by this.
    const onSelect = vi.fn();
    render(
      createElement(LanguagePillRow, {
        pills: ["en", "es"],
        selected: "es",
        paired: "en",
        sheetOpen: false,
        onSelect,
        onOpenSheet: () => {}
      })
    );
    fireEvent.click(screen.getByRole("button", { name: /tap to flip/ }));
    expect(onSelect).toHaveBeenCalledWith("en");
  });

  it("closes the OTHER way to tap your own side: the sheet", () => {
    // A fix that only covered the pill row would have left the flip one
    // "+ More · Más" away — the sheet lists all hundred languages, and your
    // own is a row in it like any other.
    const onSelect = vi.fn();
    render(
      createElement(LanguageSheet, {
        open: true,
        selected: "es",
        paired: "en",
        pairedLabel: "You hear this",
        pairedLocked: true,
        caption: "What they speak · Lo que ellos hablan",
        onSelect,
        onClose: () => {}
      })
    );
    fireEvent.click(screen.getByText("English").closest("button") as HTMLElement);
    expect(onSelect).not.toHaveBeenCalled();
    // ...and a language that is neither side still picks.
    fireEvent.click(screen.getByText("Italiano").closest("button") as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith("it");
  });
});

describe("the locked tap writes nothing, anywhere", () => {
  // The half of the bug that outlived the call. A flip persisted, so the pair
  // Tom went back to /translate with was the flipped one — a mid-call mistap
  // following him onto a screen he had not opened yet.
  it("leaves the pair, localStorage and onPairChange untouched", () => {
    window.localStorage.setItem(PAIR_STORAGE_KEY, JSON.stringify(["en", "es"]));
    const onPairChange = vi.fn();
    const { result } = renderHook(() => useLanguagePair({ lockMine: true, onPairChange }));

    // The mount restore fires once; everything below must add nothing to it.
    expect(result.current.pair).toEqual(["en", "es"]);
    const restores = onPairChange.mock.calls.length;

    act(() => result.current.selectLanguage("en"));

    expect(result.current.pair).toEqual(["en", "es"]);
    expect(result.current.mine).toBe("en");
    expect(onPairChange.mock.calls.length).toBe(restores);
    expect(window.localStorage.getItem(PAIR_STORAGE_KEY)).toBe(JSON.stringify(["en", "es"]));
    // And it tells the row to draw itself inert, so the two halves cannot
    // drift: one flag, the rule and the chrome.
    expect(result.current.mineLocked).toBe(true);
  });

  it("flips and persists when the caller has NOT locked it", () => {
    window.localStorage.setItem(PAIR_STORAGE_KEY, JSON.stringify(["en", "es"]));
    const { result } = renderHook(() => useLanguagePair());

    act(() => result.current.selectLanguage("en"));

    expect(result.current.pair).toEqual(["es", "en"]);
    expect(window.localStorage.getItem(PAIR_STORAGE_KEY)).toBe(JSON.stringify(["es", "en"]));
    expect(result.current.mineLocked).toBe(false);
  });
});
