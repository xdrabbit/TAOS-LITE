// @vitest-environment jsdom
//
// Every label on the home screen reads in ONE language: the phone owner's.
//
// The doubled label ("Flip · Voltear", "Translate into · Traducir a") has come
// back twice — once on the nav (#55 → lost in #56 → recovered in #77) and once
// on the rest of home, which Tom found on his phone on 2026-10-04 alongside an
// English-only upgrade banner Liz could not read. This file is the fence for
// the third time: it mounts the real screen on an English phone and on a
// Spanish one and asserts each control is in that phone's language and
// carries none of the other's.
//
// One label is doubled ON PURPOSE and asserted as such: the auto-detect record
// button, "Speak · Hablar" / "Hablar · Speak", which greets both people at
// once so neither waits to read it.
//
// And the result card's "Translation · English" header must not exist until
// there is a translation under it. Over the idle hint it named a language
// above a placeholder written in a different one.
//
// The last four strays joined it the same day, on Tom's call to finish home in
// one change: the install banner (English with a Spanish tail), "+ More ·
// Más", the language sheet's "Close · Cerrar", and the sheet's "Yours" badge
// on the phone's own language — English-only, so a Spanish reader could not
// tell what it was marking. Walking those in Chrome turned up the rest of the
// sheet doubled as well — its name, the search box and the empty result — so
// they went too.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PAIR_STORAGE_KEY } from "@/lib/translate/pair";
import type { LanguageCode } from "@/lib/languages/catalog";
import { copyFor, fill, type ChromeKey } from "@/lib/chrome/copy";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

/** Free-tier state the next mount sees. */
let subscriber = false;
let left = 7;

vi.mock("@/lib/supabase", () => ({
  getMonthlyUsage: async () => ({ translations: 0, tutorSeconds: 0 }),
  getTier: () => (subscriber ? "premium" : "free"),
  isSubscriber: () => subscriber,
  saveTranslation: async () => {},
  translationsLeft: () => (subscriber ? Infinity : left),
  listHistory: async () => [],
  deleteHistoryItem: async () => {},
  clearHistory: async () => {},
  startCheckout: async () => {},
  startPackCheckout: async () => {}
}));

vi.mock("@/lib/authClient", () => ({
  jsonAuthHeaders: async () => ({ "Content-Type": "application/json" }),
  authHeaders: async () => ({})
}));

vi.mock("@/lib/tts/speech", () => ({
  requestSpeech: async () => null,
  isTextOnlyLanguage: () => false,
  TEXT_ONLY_TITLE: "Text only"
}));

vi.mock("@/lib/wakeLock", () => ({ keepWake: () => () => {} }));

class FakeRecorder {
  state: "inactive" | "recording" = "inactive";
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  static isTypeSupported = () => true;
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
    this.onstop?.();
  }
}

beforeEach(() => {
  subscriber = false;
  left = 7;
  window.localStorage.clear();
  const track = { stop: () => {}, onended: null };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] })
    }
  });
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => (clock += 1000));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const fields: Record<string, string> = {};
      const form = init?.body;
      if (form instanceof FormData) {
        form.forEach((v, k) => {
          if (typeof v === "string") fields[k] = v;
        });
      }
      const src = fields.sourceLanguage === "auto" ? fields.pairB : fields.sourceLanguage;
      return new Response(
        JSON.stringify({
          original: "what was said",
          translation: "what it means",
          sourceLanguage: src,
          targetLanguage: src === fields.pairA ? fields.pairB : fields.pairA,
          model: null
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function mountHome(pair: [LanguageCode, LanguageCode]) {
  window.localStorage.setItem(PAIR_STORAGE_KEY, JSON.stringify(pair));
  const { TranslatorShell } = await import("@/components/TranslatorShell");
  const { DevicePairProvider } = await import("@/lib/translate/useLanguagePair");
  render(
    createElement(
      DevicePairProvider,
      { pair },
      createElement(TranslatorShell, { email: "owner@example.com", profile: null, onSignOut: () => {} })
    )
  );
  await act(async () => {});
}

/** Every word a reader or a screen reader can meet: text, titles, aria-labels. */
function everything(): string {
  const attrs = Array.from(document.querySelectorAll("[title],[aria-label]")).flatMap((el) => [
    el.getAttribute("title") ?? "",
    el.getAttribute("aria-label") ?? ""
  ]);
  return [document.body.textContent ?? "", ...attrs].join("\n");
}

/** The labels this file fences, each of which used to be doubled or English-only. */
const KEYS: ChromeKey[] = [
  "translateInto",
  "autoDetect",
  "autoDetectLanguage",
  "autoPlayVoice",
  "premiumVoices",
  "flip",
  "flipAria",
  "flipTitle",
  "play",
  "playAria",
  "trialLeft",
  "trialLeftOne",
  "trialUsedUp",
  "upgrade",
  "moreLanguages",
  "moreLanguagesAria",
  "close",
  "yours",
  "chooseLanguage",
  "searchLanguages",
  "searchLanguagesAria",
  "noLanguageMatches",
  "installTitle",
  "installHowIos",
  "installHowOther",
  "install",
  "installDismiss"
];

/** The doubled and English-only literals as they were before 2026-10-04. */
const OLD = [
  "Translate into · Traducir a",
  "Auto-detect · Detección automática",
  "Flip · Voltear",
  "Flip direction / Voltear",
  "Play · Oír",
  "Play translation / Reproducir traducción",
  "Auto-detect language · Detectar idioma",
  "Auto-play voice · Reproducir voz",
  "Premium voices · Voces premium",
  "+ More · Más",
  "More languages · Más idiomas",
  "Close · Cerrar",
  "Choose a language · Elegir idioma",
  "Search · Buscar…",
  "Search languages · Buscar idiomas",
  "No language matches · Ningún idioma coincide",
  "Compartir → Añadir a inicio · ",
  " · Compartir → Añadir a inicio",
  " · Pantalla completa",
  "Dismiss install prompt / Descartar"
];

const PHONES = [
  { owner: "en", other: "es", pair: ["en", "es"] as [LanguageCode, LanguageCode], speak: /^Speak · Hablar$/ },
  { owner: "es", other: "en", pair: ["es", "en"] as [LanguageCode, LanguageCode], speak: /^Hablar · Speak$/ }
] as const;

for (const phone of PHONES) {
  const mine = copyFor(phone.owner);
  const theirs = copyFor(phone.other);

  /** None of the other language's words for the fenced keys, anywhere. */
  function expectNoneOfTheirs() {
    const all = everything();
    for (const key of KEYS) {
      const word = key === "trialLeft" ? fill(theirs.trialLeft, { count: left }) : theirs[key];
      expect(all, `${phone.owner} phone shows ${phone.other}.${key}`).not.toContain(word);
    }
    for (const old of OLD) expect(all).not.toContain(old);
  }

  describe(`a ${phone.owner} phone (${phone.pair.join("⇄")})`, () => {
    it("writes the idle screen's labels in its own language only", async () => {
      await mountHome(phone.pair);

      // Picker caption, the auto-detect card, both checkboxes.
      expect(screen.getByText(mine.translateInto)).toBeTruthy();
      expect(screen.getByText(mine.autoDetect)).toBeTruthy();
      expect(screen.getByLabelText(mine.autoDetectLanguage)).toBeTruthy();
      expect(screen.getByLabelText(mine.autoPlayVoice)).toBeTruthy();
      // The locked premium engine's tooltip.
      expect(document.querySelector(`[title="${mine.premiumVoices}"]`)).toBeTruthy();
      // The free-trial banner and its button — English-only until now.
      expect(screen.getByText(fill(mine.trialLeft, { count: 7 }))).toBeTruthy();
      expect(screen.getByRole("button", { name: mine.upgrade })).toBeTruthy();

      // The record button is the one label doubled on purpose.
      expect(screen.getByRole("button", { name: phone.speak })).toBeTruthy();

      expectNoneOfTheirs();
    });

    it("shows no result header over an empty card — only the hint", async () => {
      await mountHome(phone.pair);
      expect(screen.getByText(mine.idle)).toBeTruthy();
      const all = everything();
      for (const word of [copyFor("en").translationLabel, copyFor("es").translationLabel]) {
        expect(all, `"${word}" announced before a result`).not.toContain(word);
      }
    });

    it("brings the header in with the result, and Flip and Play in its language", async () => {
      await mountHome(phone.pair);
      // Manual mode, so Flip is on screen too (it hides under auto-detect).
      await act(async () => {
        fireEvent.click(screen.getByLabelText(mine.autoDetectLanguage));
      });
      const record = screen.getByRole("button", { name: new RegExp(`^${mine.speak} `) });
      await act(async () => {
        fireEvent.click(record);
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: mine.stop }));
      });
      await act(async () => {});
      expect(screen.getByText("what it means")).toBeTruthy();

      // The header #83 shipped: owner's word, listener's language name.
      expect(screen.getByText(new RegExp(`^${mine.translationLabel} · `))).toBeTruthy();

      const flip = screen.getByRole("button", { name: mine.flipAria });
      expect(flip.textContent).toContain(mine.flip);
      expect(flip.getAttribute("title")).toBe(mine.flipTitle);
      const play = screen.getByRole("button", { name: mine.playAria });
      expect(play.textContent).toContain(mine.play);

      expectNoneOfTheirs();
    });

    it("counts down the last free translation and says when they are gone", async () => {
      left = 1;
      await mountHome(phone.pair);
      expect(screen.getByText(mine.trialLeftOne)).toBeTruthy();
      cleanup();

      left = 0;
      await mountHome(phone.pair);
      expect(screen.getByText(mine.trialUsedUp)).toBeTruthy();
      expect(screen.getByRole("button", { name: mine.upgrade })).toBeTruthy();
      expect(everything()).not.toContain(theirs.trialUsedUp);
    });

    it("captions the language sheet in its own language too", async () => {
      await mountHome(phone.pair);
      // "+ More" — its face, its screen-reader name and its tooltip.
      const more = screen.getByRole("button", { name: mine.moreLanguagesAria });
      expect(more.textContent).toBe(mine.moreLanguages);
      expect(more.getAttribute("title")).toBe(mine.moreLanguagesAria);
      await act(async () => {
        fireEvent.click(more);
      });
      const sheet = screen.getByRole("dialog", { name: mine.chooseLanguage });
      expect(sheet.textContent).toContain(mine.translateInto);
      const search = screen.getByRole("searchbox", { name: mine.searchLanguagesAria });
      expect(search.getAttribute("placeholder")).toBe(mine.searchLanguages);
      expect(sheet.textContent).not.toContain(theirs.translateInto);

      // Close: face and name.
      const close = screen.getByRole("button", { name: mine.close });
      expect(close.textContent).toBe(mine.close);

      // The badge on the phone's own language — pair[0] is `mine`, drawn as
      // the sheet's `paired` row — reads in that phone's language.
      const own = Array.from(sheet.querySelectorAll("li button")).find(
        (row) => row.getAttribute("aria-pressed") === "false" && row.textContent?.includes(mine.yours)
      );
      expect(own, `no "${mine.yours}" badge in the sheet`).toBeTruthy();
      expect(sheet.textContent).not.toContain(theirs.yours);

      expectNoneOfTheirs();

      // A search with no hit says so in the owner's language.
      await act(async () => {
        fireEvent.change(search, { target: { value: "zzzzqqq" } });
      });
      expect(sheet.textContent).toContain(mine.noLanguageMatches);
      expectNoneOfTheirs();
    });

    it("writes the install banner in its own language on Android", async () => {
      await mountHome(phone.pair);
      // Chromium announces installability; the banner waits for it.
      const ev = Object.assign(new Event("beforeinstallprompt"), {
        prompt: async () => {},
        userChoice: Promise.resolve({ outcome: "dismissed" as const })
      });
      await act(async () => {
        window.dispatchEvent(ev);
      });
      expect(screen.getByText(mine.installTitle)).toBeTruthy();
      expect(screen.getByText(mine.installHowOther)).toBeTruthy();
      expect(screen.getByRole("button", { name: mine.install })).toBeTruthy();
      expect(screen.getByRole("button", { name: mine.installDismiss })).toBeTruthy();
      expectNoneOfTheirs();
    });

    it("writes the install banner in its own language on an iPhone", async () => {
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148"
      );
      await mountHome(phone.pair);
      expect(screen.getByText(mine.installTitle)).toBeTruthy();
      expect(screen.getByText(mine.installHowIos)).toBeTruthy();
      expect(screen.getByRole("button", { name: mine.installDismiss })).toBeTruthy();
      expectNoneOfTheirs();
    });
  });
}

describe("the copy table carries every one of them", () => {
  it("has a real Spanish word for each, distinct from the English", () => {
    for (const key of KEYS) {
      expect(copyFor("es")[key], key).not.toBe(copyFor("en")[key]);
      // Never doubled inside a single language's entry.
      expect(copyFor("en")[key], key).not.toMatch(
        / · (Traducir|Detecci|Voltear|Oír|Reproducir|Detectar|Voces|Más|Cerrar|Compartir|Pantalla|Descartar|Elegir|Buscar|Ningún)/
      );
    }
  });
});

describe("the picker caption is one language on every screen that used the doubled one", () => {
  // Source-reading: /translate and /fast need a predict model and a typing
  // loop to mount, and what is fenced here is only which string they hand
  // the picker. LanguageSheet has no default caption any more, so a screen
  // that forgets to pass one is a type error, not a doubled label.
  const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

  it("no longer exists as a literal in the picker, /translate or home", () => {
    for (const path of [
      "components/LanguagePicker.tsx",
      "components/TranslateShell.tsx",
      "components/TranslatorShell.tsx"
    ]) {
      expect(read(path), path).not.toContain("Translate into · Traducir a");
    }
    expect(read("components/LanguagePicker.tsx")).not.toContain("DEFAULT_PICKER_CAPTION");
  });

  it("is the owner's translateInto on /translate and /fast", () => {
    expect(read("components/TranslateShell.tsx").match(/caption=\{copy\.translateInto\}/g)).toHaveLength(2);
    expect(read("components/FastShell.tsx")).toContain("caption={copyFor(mine).translateInto}");
  });
});
