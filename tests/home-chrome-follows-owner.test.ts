// @vitest-environment jsdom
//
// The home screen is written in the phone OWNER's language (Tom, 2026-10-04).
//
// It used to follow the active speaker: every auto-detected turn moved
// `source`, and `source` picked the copy, so the buttons on Tom's phone went
// Spanish the moment Liz spoke into it. That is right for one phone passed
// back and forth and wrong for two people each holding their own — and /call
// (copyFor(mine)) and the #77 nav (copyFor(mine)) already read the other way.
//
// The bug only shows AFTER the other person speaks, so every test here walks a
// real turn: tap record, stop, let the server name the language that was
// heard. A test that only mounts the screen would pass on the old code.
//
// `source` still has a second job — it is the translation direction — and
// that job must not move. The turns below also assert on what was SENT to
// /api/translate, and that the speaker card still follows the last speaker.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PAIR_STORAGE_KEY } from "@/lib/translate/pair";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

vi.mock("@/lib/supabase", () => ({
  getMonthlyUsage: async () => ({ translations: 0, tutorSeconds: 0 }),
  getTier: () => "premium",
  isSubscriber: () => true,
  saveTranslation: async () => {},
  translationsLeft: () => 999,
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

/** The language /api/translate says it heard on the next turn. */
let heard = "es";
const sent: Record<string, string>[] = [];

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
  heard = "es";
  sent.length = 0;
  window.localStorage.clear();
  const track = { stop: () => {}, onended: null };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] })
    }
  });
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  // jsdom's media element returns undefined from play(); the screen chains .catch on it.
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  // Each read is a second later, so every turn clears MIN_TURN_DURATION_MS.
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => (clock += 1000));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const form = init?.body as FormData;
      const fields: Record<string, string> = {};
      form.forEach((v, k) => {
        if (typeof v === "string") fields[k] = v;
      });
      sent.push(fields);
      const src = fields.sourceLanguage === "auto" ? heard : fields.sourceLanguage;
      return new Response(
        JSON.stringify({
          original: "what was said",
          translation: "what it means",
          sourceLanguage: src,
          targetLanguage: src === fields.pairA ? fields.pairB : fields.pairA
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

/** Mount home on a phone with `stored` saved (or nothing) and an Accept-Language. */
async function mount(stored: [string, string] | null, acceptLanguage: string | null = null) {
  if (stored) window.localStorage.setItem(PAIR_STORAGE_KEY, JSON.stringify(stored));
  // Imported together, after resetModules: a provider from an older module
  // instance is a different React context and the shell would never see it.
  const { TranslatorShell } = await import("@/components/TranslatorShell");
  const { DevicePairProvider } = await import("@/lib/translate/useLanguagePair");
  const { pairForDevice } = await import("@/lib/translate/deviceLanguage");
  render(
    createElement(
      DevicePairProvider,
      { pair: pairForDevice(acceptLanguage) },
      createElement(TranslatorShell, { email: "owner@example.com", profile: null, onSignOut: () => {} })
    )
  );
  // The pair is restored in an effect, so the first paint is the default.
  await act(async () => {});
}

/** One push-to-talk turn through the real record button. */
async function speakTurn(recordLabel: RegExp, language?: string) {
  if (language) heard = language;
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: recordLabel }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^(Stop|Detener)/ }));
  });
  await act(async () => {});
  expect(screen.getByText("what it means")).toBeTruthy();
}

describe("Tom's phone (EN⇄ES), Liz speaks into it", () => {
  it("keeps every label in English after a Spanish turn", async () => {
    await mount(["en", "es"]);
    expect(screen.getByText("Tap the mic, speak a full thought, tap again.")).toBeTruthy();

    await speakTurn(/Speak · Hablar/, "es");

    // The bug: these went Spanish ("Se escuchó", "Hablando ahora") here.
    expect(screen.getByText("Heard:")).toBeTruthy();
    expect(screen.getByText(/^Translation · English$/)).toBeTruthy();
    expect(screen.queryByText(/Se escuchó/)).toBeNull();
    expect(screen.queryByText(/Traducción/)).toBeNull();
    // The record button still greets both sides in auto-detect, on purpose.
    expect(screen.getByRole("button", { name: /Speak · Hablar/ })).toBeTruthy();
  });

  it("still routes the turn the way auto-detect resolved it", async () => {
    await mount(["en", "es"]);
    await speakTurn(/Speak · Hablar/, "es");
    expect(sent[0]).toMatchObject({ sourceLanguage: "auto", targetLanguage: "auto", pairA: "en", pairB: "es" });

    // Leave auto-detect: the speaker card shows who spoke last — Spanish,
    // because `source` still moved — while its labels stay in English.
    await act(async () => {
      fireEvent.click(screen.getByLabelText(/Auto-detect language/));
    });
    expect(screen.getByText("Speaking now")).toBeTruthy();
    expect(screen.getByText("Swap")).toBeTruthy();
    expect(screen.queryByText("Hablando ahora")).toBeNull();

    // And the next manual turn goes Spanish → English, exactly as before.
    await speakTurn(/^Speak Español$/);
    expect(sent[1]).toMatchObject({ sourceLanguage: "es", targetLanguage: "en" });
  });
});

describe("Liz's phone (ES⇄EN), Tom speaks into it", () => {
  it("keeps every label in Spanish after an English turn", async () => {
    await mount(["es", "en"]);
    await speakTurn(/Hablar · Speak/, "en");

    expect(screen.getByText("Se escuchó:")).toBeTruthy();
    expect(screen.getByText(/^Traducción · Español$/)).toBeTruthy();
    expect(screen.queryByText("Heard:")).toBeNull();
    expect(screen.queryByText(/^Translation ·/)).toBeNull();
  });
});

describe("a phone with no saved pair", () => {
  it("follows the device language from first paint through the other side's turn", async () => {
    // #78: nothing stored, an English phone → pair [en, es], so the owner is
    // English even though the app-wide default pair is Spanish-first.
    await mount(null, "en-US,en;q=0.9");
    expect(screen.getByText("Tap the mic, speak a full thought, tap again.")).toBeTruthy();

    await speakTurn(/Speak · Hablar/, "es");
    expect(screen.getByText("Heard:")).toBeTruthy();
    expect(screen.getByText(/^Translation · English$/)).toBeTruthy();
    expect(sent[0]).toMatchObject({ pairA: "en", pairB: "es" });
  });

  it("is Spanish on a Spanish phone, and stays Spanish after an English turn", async () => {
    await mount(null, "es-MX,es;q=0.9");
    expect(screen.getByText("Toca el micrófono, di una idea completa y toca otra vez.")).toBeTruthy();

    await speakTurn(/Hablar · Speak/, "en");
    expect(screen.getByText("Se escuchó:")).toBeTruthy();
    expect(screen.queryByText("Heard:")).toBeNull();
  });
});
