// @vitest-environment jsdom
//
// The captions, driven through the actual screen.
//
// The 8/31 field report (Tom and Liz, two phones, same house): the relay
// preflight passed, the call connected, audio and video were good, and there
// were NO CAPTIONS. Two hypotheses were live — the interpreter never started,
// or it started and the text never reached the screen — and the production
// logs answered it before a line of this file was written:
//
//   [taos-call-cost] room=AMOR mode=clone pair=en->es seconds=125 responses=7
//     speech_s=20.5 text_out_tok=96 tts_chars=244 usd=0.0251
//
// `tts_chars` is incremented in exactly one place, `speakTranslation` in
// lib/call/interpreter.ts, and it is reached only from `onTranslationDone`
// and only past the `if (muted) return` guard. 244 of them is proof that the
// interpreter ran, that translations completed, that the screen's own
// `onTranslationDone` handler fired — and that the voice was ON, so it spoke.
// The captions existed in React state. They were not on the screen.
//
// So this file mounts the real CallShell, walks it into a connected call, and
// fires the same `onTranslationDone` the interpreter fires. Every test below
// failed against the shipped screen for a reason the logs could not see:
// there was no way to be looking at the captions and no way to know why.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CallEvents } from "@/lib/call/session";
import type { InterpreterEvents, InterpreterState } from "@/lib/call/interpreter";

// ── The two modules a browserless test genuinely cannot have ───────────────
// Everything between them — CallShell's state, its gating, its markup — is the
// shipped code.

let callEvents: CallEvents | null = null;
const hangUp = vi.fn(async () => {});
const startCall = vi.fn(async (_config: unknown, events: CallEvents) => {
  callEvents = events;
  return {
    hangUp,
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

let interpreterEvents: InterpreterEvents | null = null;
const interpreterStop = vi.fn(async () => {});
const setInterpreterMuted = vi.fn();
/** Set to reject to simulate a session that cannot be minted. */
let mintOutcome: "ok" | "fail" = "ok";

const startCallInterpreter = vi.fn(async (_config: unknown, events: InterpreterEvents) => {
  interpreterEvents = events;
  if (mintOutcome === "fail") {
    events.onState?.("error");
    events.onError?.("Interpreter SDP exchange failed (502).");
    throw new Error("Interpreter SDP exchange failed (502).");
  }
  events.onState?.("minting");
  events.onState?.("connecting");
  events.onState?.("connected");
  return {
    stop: interpreterStop,
    setMuted: setInterpreterMuted,
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
    // Added with the input telemetry: endCall reads this to decide whether a
    // spend-free call was silence or a silent interpreter.
    inputStats: () => ({
      speechStarted: 0,
      speechCommitted: 0,
      level: null,
      energy: null,
      bridged: false
    })
  };
});

vi.mock("@/lib/call/interpreter", async () => {
  const actual = await vi.importActual<typeof import("@/lib/call/interpreter")>(
    "@/lib/call/interpreter"
  );
  return {
    ...actual,
    startCallInterpreter: (...args: unknown[]) =>
      (startCallInterpreter as unknown as (...a: unknown[]) => unknown)(...args)
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

let CallShell: () => JSX.Element;

/** A live audio track, in the shape CallShell's handler reads. */
function fakeTrack(): MediaStreamTrack {
  return { kind: "audio", readyState: "live", muted: false } as unknown as MediaStreamTrack;
}

/** Join a room and walk the call to `connected` with the partner's audio in hand. */
async function joinAndConnect(): Promise<void> {
  fireEvent.change(screen.getByPlaceholderText("Room code"), { target: { value: "AMOR" } });
  await act(async () => {
    fireEvent.click(screen.getByText("Join call"));
  });
  await act(async () => {
    callEvents?.onState?.("connected");
    // The pair defaults to ["es", "en"] (lib/translate/pair.ts), so this
    // phone's owner hears Spanish and the partner has to be on English —
    // otherwise the doubled-language rule (correctly) skips the session.
    callEvents?.onPeerLanguage?.("en");
    callEvents?.onRemoteAudioTrack?.(fakeTrack());
  });
  await act(async () => {});
}

/** What the interpreter emits when a translation finishes. */
async function translate(heard: string, text: string): Promise<void> {
  await act(async () => {
    interpreterEvents?.onHeard?.(heard);
    interpreterEvents?.onTranslationDone?.(text);
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  callEvents = null;
  interpreterEvents = null;
  mintOutcome = "ok";
  window.localStorage.clear();
  // The pair has to be EN/ES or the doubled-side rule skips the session.
  ({ CallShell } = await import("@/components/CallShell"));
});

afterEach(() => {
  cleanup();
  vi.resetModules();
});

describe("/call captions", () => {
  it("puts a finished translation on the screen", async () => {
    render(createElement(CallShell));
    await joinAndConnect();
    await translate("Hola mi amor, ya llegué a la casa.", "Hi my love, I just got home.");

    expect(screen.getByText("Hi my love, I just got home.")).toBeTruthy();
  });

  it("keeps the caption feed as more translations arrive", async () => {
    render(createElement(CallShell));
    await joinAndConnect();
    await translate("Hola.", "Hello.");
    await translate("¿Cenamos?", "Shall we have dinner?");

    expect(screen.getByText("Shall we have dinner?")).toBeTruthy();
    expect(screen.getByText("Hello.")).toBeTruthy();
  });
});

// ── The half the logs could not see ────────────────────────────────────────
// Everything above passes against the screen as it shipped on 8/31, because
// the captions really did reach the DOM. What follows is the other half of
// "no captions": every state in which they legitimately cannot arrive, each
// of which used to render as an empty panel reading "Captions appear here…"
// — the same thing a working call shows in the second before somebody speaks.

describe("/call says why there are no captions", () => {
  it("names the reason when the interpreter fails to start", async () => {
    mintOutcome = "fail";
    render(createElement(CallShell));
    await joinAndConnect();

    // Not silence, and not a bare "failed": the sentence that says what broke.
    expect(screen.getByText(/Intérprete: ✗ falló/)).toBeTruthy();
    // Twice on purpose: in the status pill's panel, where somebody looking for
    // captions is already looking, and in the notice.
    expect(screen.getAllByText(/SDP exchange failed/).length).toBeGreaterThan(0);
  });

  it("keeps the failure on screen after the session tears itself down", async () => {
    mintOutcome = "fail";
    render(createElement(CallShell));
    await joinAndConnect();
    // `stop()` runs on the way out of a failure and announces "idle". The
    // screen must not take that as "nothing is wrong, it simply is not on".
    await act(async () => {
      interpreterEvents?.onState?.("idle");
    });

    expect(screen.getByText(/Intérprete: ✗ falló/)).toBeTruthy();
    expect(screen.queryByText(/Intérprete: apagado/)).toBeNull();
  });

  it("distinguishes connected-but-deaf from connected-and-hearing", async () => {
    render(createElement(CallShell));
    await joinAndConnect();

    // Connected. The partner's forwarded audio track may still be carrying
    // nothing at all, and no error is ever raised for that.
    expect(screen.getByText("Intérprete: activo · on")).toBeTruthy();

    await act(async () => {
      interpreterEvents?.onHearing?.(true);
    });
    expect(screen.getByText("Intérprete: ✓ activo · on")).toBeTruthy();
  });

  it("says the interpreter is not needed when both sides share a language", async () => {
    render(createElement(CallShell));
    fireEvent.change(screen.getByPlaceholderText("Room code"), { target: { value: "AMOR" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Join call"));
    });
    await act(async () => {
      callEvents?.onState?.("connected");
      // Their phone announces the language this phone is already on.
      callEvents?.onPeerLanguage?.("es");
      callEvents?.onRemoteAudioTrack?.(fakeTrack());
    });

    expect(screen.getByText(/Intérprete: no hace falta/)).toBeTruthy();
    expect(startCallInterpreter).not.toHaveBeenCalled();
  });
});

describe("/call captions toggle", () => {
  it("leaves an unmistakable mark when captions are switched OFF", async () => {
    render(createElement(CallShell));
    await joinAndConnect();
    await translate("Hola.", "Hello.");

    await act(async () => {
      fireEvent.click(screen.getByText("💬 Captions on"));
    });

    // The old screen rendered NOTHING here, which is the same picture a
    // broken interpreter draws. Off has to look like a choice.
    expect(screen.getByText(/Captions are OFF/)).toBeTruthy();
    expect(screen.queryByText("Hello.")).toBeNull();
    expect(screen.getByText("💬 Captions off")).toBeTruthy();
  });

  it("comes back on when the mark is tapped", async () => {
    render(createElement(CallShell));
    await joinAndConnect();
    await translate("Hola.", "Hello.");
    await act(async () => {
      fireEvent.click(screen.getByText("💬 Captions on"));
    });
    await act(async () => {
      fireEvent.click(screen.getByText(/Captions are OFF/));
    });

    expect(screen.getByText("Hello.")).toBeTruthy();
  });

  it("does not share a word with the button that governs the VOICE", async () => {
    render(createElement(CallShell));
    await joinAndConnect();

    // These two sat side by side reading "💬 Captions only" and "💬 Captions",
    // governing different things. Either one looked like the way to get
    // captions, and one of them turned them off.
    const captions = screen.getByText("💬 Captions on").textContent ?? "";
    const voice = screen.getByText("🗣️ Voice on").textContent ?? "";
    expect(captions).toContain("Captions");
    expect(voice).not.toContain("Caption");
    expect(voice).not.toContain("💬");
  });

  it("turns captions back on for every new call", async () => {
    render(createElement(CallShell));
    await joinAndConnect();
    await act(async () => {
      fireEvent.click(screen.getByText("💬 Captions on"));
    });
    expect(screen.getByText(/Captions are OFF/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText("Hang up"));
    });
    await joinAndConnect();

    expect(screen.getByText("💬 Captions on")).toBeTruthy();
  });
});
