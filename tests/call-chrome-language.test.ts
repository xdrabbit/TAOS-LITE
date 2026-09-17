// @vitest-environment jsdom
//
// The whole point of the copy table, driven through the actual screen.
//
// Liz is the app's daily user and owns most of this company, and she did not
// use /call. Not because it was broken — because she could not read it. The
// screen was ~41 English-only strings and 27 doubled ones ("connected ·
// conectado"), so the important half of it was a language she does not read
// and the rest was English full stop.
//
// /call had no copy table at all. It has one now, shared with the home screen
// and /tabletop, and it follows `mine` — what THIS phone's owner hears —
// rather than `direction.source`, which is the PARTNER's language and would
// have handed Liz's phone an English screen with extra steps.
//
// Two phones, two owners, two screens. That is the thing being fenced here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CallEvents } from "@/lib/call/session";
import type { InterpreterEvents } from "@/lib/call/interpreter";
import { PAIR_STORAGE_KEY } from "@/lib/translate/pair";

let callEvents: CallEvents | null = null;
let interpreterEvents: InterpreterEvents | null = null;
const startCall = vi.fn(async (_config: unknown, events: CallEvents) => {
  callEvents = events;
  return {
    hangUp: vi.fn(async () => {}),
    setMicMuted: vi.fn(),
    setVideo: vi.fn(async () => {}),
    setRemoteVolume: vi.fn(),
    sendInterpreterSpeaking: vi.fn(),
    sendLanguage: vi.fn(),
    readMediaFlow: vi.fn(async () => null)
  };
});

vi.mock("@/lib/call/session", () => ({
  startCall: (...args: unknown[]) =>
    (startCall as unknown as (...a: unknown[]) => unknown)(...args),
  generateRoomCode: () => "AMOR",
  normalizeRoomCode: (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6)
}));

vi.mock("@/lib/call/interpreter", async () => {
  const actual = await vi.importActual<typeof import("@/lib/call/interpreter")>(
    "@/lib/call/interpreter"
  );
  return {
    ...actual,
    startCallInterpreter: async (_config: unknown, events: InterpreterEvents) => {
      interpreterEvents = events;
      events.onState?.("connected");
      return {
        stop: vi.fn(async () => {}),
        setMuted: vi.fn(),
        setDirection: vi.fn(),
        spend: () => ({
          engine: "elevenlabs" as const,
          responses: 0,
          textInTokens: 0,
          cachedTextInTokens: 0,
          audioInTokens: 0,
          cachedAudioInTokens: 0,
          textOutTokens: 0,
          audioOutTokens: 0,
          transcribedSeconds: 0,
          ttsCharacters: 0
        }),
        inputStats: () => ({
          speechStarted: 0,
          speechCommitted: 0,
          level: null,
          energy: null,
          bridged: false
        })
      };
    }
  };
});

vi.mock("@/lib/authClient", () => ({
  jsonAuthHeaders: async () => ({ "Content-Type": "application/json" }),
  authHeaders: async () => ({})
}));

vi.mock("@/lib/tts/speech", () => ({
  requestSpeech: async () => null,
  isTextOnlyLanguage: () => false,
  TEXT_ONLY_TITLE: "Text only"
}));

/**
 * Mount /call on a phone whose owner hears `mine`.
 *
 * The pair is [mine, theirs] in localStorage (lib/translate/pair.ts), which is
 * the only thing that decides the chrome language today — deliberately, and
 * only for now. Untying the screen's language from the translation pair, and
 * defaulting it from the device locale, is the next PR.
 */
async function mount(pair: [string, string] | null): Promise<void> {
  window.localStorage.clear();
  if (pair) window.localStorage.setItem(PAIR_STORAGE_KEY, JSON.stringify(pair));
  const { CallShell } = await import("@/components/CallShell");
  render(createElement(CallShell));
  // The pair is restored in an effect, so the first paint is the default.
  await act(async () => {});
}

/** Walk the lobby into a connected call with the partner's audio in hand. */
async function joinAndConnect(roomPlaceholder: string, joinLabel: string): Promise<void> {
  fireEvent.change(screen.getByPlaceholderText(roomPlaceholder), { target: { value: "AMOR" } });
  await act(async () => {
    fireEvent.click(screen.getByText(joinLabel));
  });
  await act(async () => {
    callEvents?.onState?.("connected");
    callEvents?.onRemoteAudioTrack?.({
      kind: "audio",
      readyState: "live",
      muted: false
    } as unknown as MediaStreamTrack);
  });
  await act(async () => {});
}

beforeEach(() => {
  vi.clearAllMocks();
  callEvents = null;
  interpreterEvents = null;
});

afterEach(() => {
  cleanup();
  vi.resetModules();
});

describe("Liz's phone", () => {
  it("draws the lobby in Spanish when she is the one who hears Spanish", async () => {
    await mount(["es", "en"]);

    expect(screen.getByText("Llamada traducida")).toBeTruthy();
    expect(screen.getByText("Entrar a la llamada")).toBeTruthy();
    expect(screen.getByPlaceholderText("Código de sala")).toBeTruthy();
    expect(screen.getByText("Compartir enlace")).toBeTruthy();
    expect(screen.getByText("Probar conexión")).toBeTruthy();
    // And not doubled: the Spanish half used to arrive bolted onto English.
    expect(screen.queryByText(/Join call/)).toBeNull();
    expect(screen.queryByText(/Test connection/)).toBeNull();
  });

  it("draws the call controls and the interpreter status in Spanish", async () => {
    await mount(["es", "en"]);
    await joinAndConnect("Código de sala", "Entrar a la llamada");

    expect(screen.getByText("🎙️ Micro encendido")).toBeTruthy();
    expect(screen.getByText("🗣️ Voz encendida")).toBeTruthy();
    expect(screen.getByText("💬 Subtítulos sí")).toBeTruthy();
    expect(screen.getByText("Colgar")).toBeTruthy();
    expect(screen.getByText("Intérprete: activo")).toBeTruthy();
    expect(screen.queryByText(/Mic on/)).toBeNull();
    expect(screen.queryByText(/Hang up/)).toBeNull();
  });
});

describe("Tom's phone, on the same call", () => {
  it("draws the same screen in English, because he hears English", async () => {
    await mount(["en", "es"]);

    expect(screen.getByText("Translated call")).toBeTruthy();
    expect(screen.getByText("Join call")).toBeTruthy();
    expect(screen.getByPlaceholderText("Room code")).toBeTruthy();
    expect(screen.queryByText(/Entrar a la llamada/)).toBeNull();
  });

  it("carries English through the controls too", async () => {
    await mount(["en", "es"]);
    await joinAndConnect("Room code", "Join call");

    expect(screen.getByText("🎙️ Mic on")).toBeTruthy();
    expect(screen.getByText("💬 Captions on")).toBeTruthy();
    expect(screen.getByText("Hang up")).toBeTruthy();
    expect(screen.getByText("Interpreter: on")).toBeTruthy();
  });
});

describe("a phone whose language nobody has written chrome for", () => {
  it("comes up in English rather than blank, and still interprets", async () => {
    // Italian has the home screen and nothing else, because nobody here can
    // check an Italian /call. The screen does not hold the language back over
    // it — it falls back key by key and the TRANSLATION, which is what they
    // came for, is unaffected.
    await mount(["it", "en"]);

    expect(screen.getByText("Translated call")).toBeTruthy();
    expect(screen.getByText("Join call")).toBeTruthy();
  });

  it("does the same for a language with no chrome entry of any kind", async () => {
    // Hawaiian: in the catalog, translated faithfully, and with not one word
    // of chrome written for it. It gets the whole English table.
    //
    // The ask that started this work was SAMOAN, and `sm` is not in
    // lib/languages/catalog.ts at all — so it cannot be a pair here, which is
    // a separate gap from this one and not something a copy table can fix.
    // When Samoan is added to the catalog it will behave exactly like this
    // line, with no edit to lib/chrome/copy.ts.
    await mount(["haw", "en"]);

    expect(screen.getByText("Translated call")).toBeTruthy();
    expect(screen.getByPlaceholderText("Room code")).toBeTruthy();
  });
});

describe("the countdown is a slot in a sentence, not a seam", () => {
  it("interpolates the countdown into the sentence on screen", async () => {
    // The one /call string that carries a value. Concatenating "…in about " +
    // n + "s to save money" would have pinned English word order onto every
    // translation of it.
    await mount(["es", "en"]);
    await joinAndConnect("Código de sala", "Entrar a la llamada");

    expect(screen.queryByText(/45s/)).toBeNull();
    await act(async () => {
      interpreterEvents?.onIdleWarning?.(45);
    });

    expect(screen.getByText(/45s/)).toBeTruthy();
    expect(screen.getByText(/el intérprete se detiene/)).toBeTruthy();
    // Not a token, and not the English sentence with a Spanish word in it.
    expect(screen.queryByText(/\{seconds\}/)).toBeNull();
    expect(screen.queryByText(/save money/)).toBeNull();
  });

  it("puts the number inside the translated sentence", async () => {
    const { copyFor, fill } = await import("@/lib/chrome/copy");
    for (const code of ["en", "es", "sm"]) {
      const filled = fill(copyFor(code).callIdleNotice, { seconds: 45 });
      expect(filled, code).toContain("45");
      expect(filled, code).not.toContain("{seconds}");
    }
  });
});
