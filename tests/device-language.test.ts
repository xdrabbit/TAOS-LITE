// @vitest-environment jsdom
//
// A first-time visitor's pair follows their phone (Tom, 2026-10-02).
//
// The one way this change could do real damage is by overriding somebody's
// choice. Tom and Liz both have stored pairs, and for them this must be
// invisible — so the first block drives the real hook, with the real
// provider, and a device language that disagrees with what is stored.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { cleanup, renderHook } from "@testing-library/react";
import { CHROME_LANGUAGES } from "@/lib/chrome/copy";
import { DEVICE_LANGUAGES, deviceLanguage, pairForDevice } from "@/lib/translate/deviceLanguage";
import { DEFAULT_PAIR, PAIR_STORAGE_KEY, type PairLangCode } from "@/lib/translate/pair";
import { DevicePairProvider, useLanguagePair } from "@/lib/translate/useLanguagePair";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

/** Mount the hook under the provider exactly as the root layout does. */
function mountWithHeader(header: string | null, onPairChange = vi.fn()) {
  const pair = pairForDevice(header);
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(DevicePairProvider, { pair }, children);
  const hook = renderHook(() => useLanguagePair({ onPairChange }), { wrapper });
  return { ...hook, onPairChange };
}

describe("a stored pair always wins", () => {
  it("Tom's stored EN⇄IT survives a Spanish phone", () => {
    window.localStorage.setItem(PAIR_STORAGE_KEY, JSON.stringify(["en", "it"]));
    const { result, onPairChange } = mountWithHeader("es-MX,es;q=0.9");
    expect(result.current.pair).toEqual(["en", "it"]);
    // Exactly one change: the restore. The device pair never reached the screen.
    expect(onPairChange).toHaveBeenCalledTimes(1);
    expect(onPairChange).toHaveBeenCalledWith(["en", "it"]);
  });

  it("Liz's stored ES⇄IT survives an English phone", () => {
    window.localStorage.setItem(PAIR_STORAGE_KEY, JSON.stringify(["es", "it"]));
    const { result, onPairChange } = mountWithHeader("en-US,en;q=0.9");
    expect(result.current.pair).toEqual(["es", "it"]);
    expect(onPairChange).toHaveBeenCalledTimes(1);
    expect(onPairChange).toHaveBeenCalledWith(["es", "it"]);
  });

  it("is not written back to storage by the device pair", () => {
    window.localStorage.setItem(PAIR_STORAGE_KEY, JSON.stringify(["en", "it"]));
    mountWithHeader("zh-CN");
    expect(window.localStorage.getItem(PAIR_STORAGE_KEY)).toBe(JSON.stringify(["en", "it"]));
  });
});

describe("a phone with nothing stored starts in its own language", () => {
  it("an English phone starts EN⇄ES and tells the screen", () => {
    const { result, onPairChange } = mountWithHeader("en-US,en;q=0.9");
    expect(result.current.pair).toEqual(["en", "es"]);
    expect(result.current.mine).toBe("en");
    expect(onPairChange).toHaveBeenCalledWith(["en", "es"]);
    // Detection is a starting point, not a choice: nothing is persisted.
    expect(window.localStorage.getItem(PAIR_STORAGE_KEY)).toBeNull();
  });

  it("a Spanish phone gets today's default, untouched", () => {
    const { result, onPairChange } = mountWithHeader("es-ES");
    expect(result.current.pair).toEqual(DEFAULT_PAIR);
    expect(onPairChange).not.toHaveBeenCalled();
  });
});

describe("unsupported or missing falls back to today's default, unchanged", () => {
  it.each([
    ["missing", null],
    ["empty", ""],
    ["wildcard", "*"],
    ["French (catalog, but no chrome)", "fr-FR,fr;q=0.9"],
    ["Portuguese (pt-BR)", "pt-BR"],
    ["not a language", "xx-YY"],
    ["everything refused", "en;q=0"]
  ])("%s → DEFAULT_PAIR", (_label, header) => {
    expect(pairForDevice(header)).toBe(DEFAULT_PAIR);
  });

  it("does not fall through to a second preference", () => {
    // A French phone that also lists English is a French phone.
    expect(pairForDevice("fr-FR,fr;q=0.9,en;q=0.8")).toBe(DEFAULT_PAIR);
  });

  it("the hook with no provider and nothing stored behaves exactly as before", () => {
    const onPairChange = vi.fn();
    const { result } = renderHook(() => useLanguagePair({ onPairChange }));
    expect(result.current.pair).toEqual(["es", "en"]);
    expect(onPairChange).not.toHaveBeenCalled();
  });

  it("an unsupported phone in the real hook sits in DEFAULT_PAIR silently", () => {
    const { result, onPairChange } = mountWithHeader("fr-FR");
    expect(result.current.pair).toEqual(DEFAULT_PAIR);
    expect(onPairChange).not.toHaveBeenCalled();
  });
});

describe("the mapping, one language at a time", () => {
  it("covers exactly the chrome languages", () => {
    // If someone adds a chrome table, its phones start in it automatically —
    // this is the place that would notice a language silently NOT joining.
    expect([...DEVICE_LANGUAGES].sort()).toEqual([...CHROME_LANGUAGES].sort());
    expect([...DEVICE_LANGUAGES].sort()).toEqual(["bs", "en", "es", "it", "yue", "zh"]);
  });

  it.each<[string, readonly [PairLangCode, PairLangCode]]>([
    ["en-US,en;q=0.9", ["en", "es"]],
    ["en-GB", ["en", "es"]],
    ["es-MX,es;q=0.9,en;q=0.8", ["es", "en"]],
    ["it-IT,it;q=0.9", ["it", "en"]],
    ["bs-BA", ["bs", "en"]],
    ["zh-CN,zh;q=0.9", ["zh", "en"]],
    ["zh-Hant-TW", ["zh", "en"]],
    ["yue-Hant-HK", ["yue", "en"]]
  ])("%s → %j", (header, pair) => {
    expect(pairForDevice(header)).toEqual(pair);
  });
});

describe("reading the header", () => {
  it("takes the primary subtag, case-insensitively", () => {
    expect(deviceLanguage("ES-mx")).toBe("es");
    expect(deviceLanguage(" it ")).toBe("it");
  });

  it("orders by q, header order breaking ties", () => {
    expect(deviceLanguage("fr;q=0.5, it;q=0.9")).toBe("it");
    expect(deviceLanguage("it, fr")).toBe("it");
    expect(deviceLanguage("*;q=1, es;q=0.4")).toBe("es");
  });

  it("treats a garbled q as refused, not as first", () => {
    expect(deviceLanguage("fr;q=abc, es;q=0.1")).toBe("es");
  });
});
