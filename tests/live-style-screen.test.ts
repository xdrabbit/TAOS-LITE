// @vitest-environment jsdom
//
// The /live style toggle on the screen and on the wire (Tom, 2026-11-15).
//
// tests/live-style.test.ts pins the prompt, the session and the route. This
// file pins the two halves a pure test cannot reach:
//
//   · the chips — there, defaulting to Summary, remembered per device, in the
//     owner's language, and NOT in the pinned Stop/Clear bar;
//   · the WebRTC client — that a flip on an open session goes down the data
//     channel as the SERVER's patch (no restart, no second mint), and that
//     word for word asks for one response per heard segment.
//
// The second half asserts on what was SENT, read back off a fake data
// channel — not on the fact that setStyle was called.
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENGLISH, copyFor } from "@/lib/chrome/copy";
import { LIVE_STYLE_STORAGE_KEY } from "@/lib/live/style";
import { PAIR_STORAGE_KEY } from "@/lib/translate/pair";

vi.mock("next/navigation", () => ({
  usePathname: () => "/live",
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams()
}));

vi.mock("@/lib/authClient", () => ({
  jsonAuthHeaders: async () => ({ "Content-Type": "application/json" }),
  authHeaders: async () => ({})
}));

vi.mock("@/lib/wakeLock", () => ({ keepWake: () => () => {} }));

// ── A stand-in for the phone's WebRTC stack ─────────────────────────────────

/** Everything the client sent down the data channel, parsed, in order. */
let sent: Array<Record<string, unknown>> = [];
/** Deliver a server event to the client, as the data channel would. */
let serverSays: (ev: Record<string, unknown>) => void = () => {};
/** Every body POSTed to the mint route. */
let mintBodies: Array<Record<string, unknown>> = [];

const PATCHES = {
  summary: { type: "realtime", instructions: "SUMMARY PROMPT", max_output_tokens: 120 },
  verbatim: { type: "realtime", instructions: "VERBATIM PROMPT", max_output_tokens: 1200 }
};

class FakePeerConnection {
  connectionState = "new";
  ontrack: unknown = null;
  onconnectionstatechange: (() => void) | null = null;
  addTrack() {}
  getSenders() {
    return [];
  }
  close() {}
  createDataChannel() {
    const dc = {
      readyState: "open",
      onmessage: null as ((e: { data: string }) => void) | null,
      onerror: null,
      onopen: null as (() => void) | null,
      send: (raw: string) => sent.push(JSON.parse(raw) as Record<string, unknown>),
      close: () => {}
    };
    serverSays = (ev) => dc.onmessage?.({ data: JSON.stringify(ev) });
    return dc;
  }
  async createOffer() {
    return { type: "offer", sdp: "v=0" };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
}

beforeEach(() => {
  window.localStorage.clear();
  sent = [];
  mintBodies = [];
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLMediaElement.prototype.play = async () => {};
  window.HTMLMediaElement.prototype.pause = () => {};
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(window.navigator, "mediaDevices", {
    value: { getUserMedia: async () => ({ getTracks: () => [] }) },
    configurable: true
  });
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: { body?: unknown }) => {
      if (String(url).includes("/api/live/realtime")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        mintBodies.push(body);
        return new Response(
          JSON.stringify({
            clientSecret: "ek_test",
            callUrl: "https://example.test/calls",
            model: "gpt-realtime",
            voice: "marin",
            style: body.style,
            styles: PATCHES
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("v=0", { status: 200 });
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // The language pair lives in a module-level store; without this the Spanish
  // test's pair would still be the pair in the test after it.
  vi.resetModules();
});

/** Mount /live on a phone whose owner reads `pair[0]` and is listening to `pair[1]`. */
async function mount(pair: [string, string] = ["en", "es"]): Promise<HTMLElement> {
  window.localStorage.setItem(PAIR_STORAGE_KEY, JSON.stringify(pair));
  const { LiveShell } = await import("@/components/LiveShell");
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(createElement(LiveShell)));
  });
  return container;
}

function chips(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("[data-live-style] button"));
}

const pressed = (container: HTMLElement) =>
  chips(container)
    .filter((b) => b.getAttribute("aria-pressed") === "true")
    .map((b) => b.textContent);

async function tap(el: Element) {
  await act(async () => {
    fireEvent.click(el);
  });
}

/** One heard segment, the way the server reports it: committed, then transcribed. */
async function hear(itemId: string, transcript: string) {
  await act(async () => {
    serverSays({ type: "input_audio_buffer.committed", item_id: itemId });
    serverSays({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: itemId,
      transcript
    });
  });
}

/** The response finished generating and its audio finished playing. */
async function finishResponse() {
  await act(async () => {
    serverSays({ type: "response.done" });
  });
}

const responseCreates = () => sent.filter((e) => e.type === "response.create");
const sessionUpdates = () => sent.filter((e) => e.type === "session.update");

describe("/live: the style chips", () => {
  it("shows Summary and Word for word, with Summary on — nothing changes for anyone who ignores it", async () => {
    const container = await mount();
    expect(chips(container).map((b) => b.textContent)).toEqual(["Summary", "Word for word"]);
    expect(pressed(container)).toEqual(["Summary"]);
    expect(container.textContent).toContain(ENGLISH.liveStyleSummaryHint);
    expect(window.localStorage.getItem(LIVE_STYLE_STORAGE_KEY)).toBeNull();
  });

  it("is its own row, not crowded into the pinned Stop/Clear bar, and wraps instead of overflowing", async () => {
    const container = await mount();
    const row = container.querySelector("[data-live-style]")!;
    const bar = container.querySelector("[data-live-controls]")!;
    expect(bar.contains(row)).toBe(false);
    expect(bar.querySelectorAll("button").length).toBe(1); // START only, as before
    // A row that cannot wrap is a row that can widen the page (#53).
    expect(row.querySelector("[role=group]")!.getAttribute("class")).toContain("flex-wrap");
  });

  it("remembers the choice on this device and says what it costs the listener", async () => {
    const container = await mount();
    await tap(chips(container)[1]);
    expect(pressed(container)).toEqual(["Word for word"]);
    expect(container.textContent).toContain(ENGLISH.liveStyleVerbatimHint);
    expect(window.localStorage.getItem(LIVE_STYLE_STORAGE_KEY)).toBe("verbatim");

    cleanup();
    const again = await mount();
    expect(pressed(again)).toEqual(["Word for word"]);

    await tap(chips(again)[0]);
    expect(window.localStorage.getItem(LIVE_STYLE_STORAGE_KEY)).toBe("summary");
  });

  it("falls back to Summary for a stored value it does not know", async () => {
    window.localStorage.setItem(LIVE_STYLE_STORAGE_KEY, "poetry");
    expect(pressed(await mount())).toEqual(["Summary"]);
  });

  it("speaks the owner's language — Spanish for Liz, and never the English words", async () => {
    const es = copyFor("es");
    const container = await mount(["es", "en"]);
    expect(chips(container).map((b) => b.textContent)).toEqual(["Resumen", "Palabra por palabra"]);
    expect(container.textContent).toContain(es.liveStyleSummaryHint);
    for (const key of [
      "liveStyleLabel",
      "liveStyleSummary",
      "liveStyleVerbatim",
      "liveStyleSummaryHint",
      "liveStyleVerbatimHint",
      "liveSkippedAhead"
    ] as const) {
      expect(es[key], key).not.toBe(ENGLISH[key]);
    }
  });
});

describe("/live: the style on the wire", () => {
  async function start(container: HTMLElement) {
    const startButton = Array.from(container.querySelectorAll("button")).find((b) =>
      /START LISTENING/.test(b.textContent ?? "")
    )!;
    await tap(startButton);
    // mic → mint → SDP are three awaits deep.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  it("mints with the style the chip shows", async () => {
    const container = await mount();
    await tap(chips(container)[1]);
    await start(container);
    expect(mintBodies).toEqual([{ target: "en", source: "es", style: "verbatim" }]);
    // Minted in that style already: nothing to re-point.
    expect(sessionUpdates()).toEqual([]);
  });

  it("summary still asks the way it always has: one bare response.create for everything waiting", async () => {
    const container = await mount();
    await start(container);
    expect(mintBodies[0].style).toBe("summary");

    await hear("item_1", "Oye, vamos a la playa");
    expect(responseCreates()).toEqual([{ type: "response.create" }]);

    // Two more land while that summary is still being spoken…
    await hear("item_2", "El sábado hay mucha gente");
    await hear("item_3", "Entonces el domingo");
    expect(responseCreates().length).toBe(1);
    // …and ONE response covers both.
    await finishResponse();
    expect(responseCreates()).toEqual([{ type: "response.create" }, { type: "response.create" }]);
    await finishResponse();
    expect(responseCreates().length).toBe(2);
  });

  it("a flip while live is a session.update with the server's patch — no restart, no second mint", async () => {
    const container = await mount();
    await start(container);
    await tap(chips(container)[1]);

    expect(sessionUpdates()).toEqual([{ type: "session.update", session: PATCHES.verbatim }]);
    expect(mintBodies.length).toBe(1);
    // Still running: the primary button is STOP, not START.
    expect(container.querySelector("[data-live-controls]")!.textContent).toContain("STOP");

    await tap(chips(container)[0]);
    expect(sessionUpdates()[1]).toEqual({ type: "session.update", session: PATCHES.summary });
    expect(mintBodies.length).toBe(1);
  });

  it("word for word asks once per heard segment, oldest first, each by reference", async () => {
    const container = await mount();
    await tap(chips(container)[1]);
    await start(container);

    await hear("item_1", "Ah, y por cierto, ayer vi a tu prima");
    await hear("item_2", "Bueno, a lo que iba, salimos a las ocho");
    await hear("item_3", "No se te olvide el protector solar");
    // The first is being rendered; the other two wait their turn.
    expect(responseCreates()).toEqual([
      { type: "response.create", response: { input: [{ type: "item_reference", id: "item_1" }] } }
    ]);

    await finishResponse();
    await finishResponse();
    await finishResponse();
    expect(
      responseCreates().map((e) => (e.response as { input: Array<{ id: string }> }).input[0].id)
    ).toEqual(["item_1", "item_2", "item_3"]);
  });

  it("the flip applies from the next thing said: the patch goes out before the response that uses it", async () => {
    const container = await mount();
    await start(container);
    await hear("item_1", "Oye, vamos a la playa");
    await finishResponse();

    await tap(chips(container)[1]);
    await hear("item_2", "El sábado hay mucha gente");

    expect(sent.map((e) => e.type)).toEqual(["response.create", "session.update", "response.create"]);
    expect(sent[2]).toEqual({
      type: "response.create",
      response: { input: [{ type: "item_reference", id: "item_2" }] }
    });
  });

  it("still ignores a noise-triggered turn in either style", async () => {
    const container = await mount();
    await tap(chips(container)[1]);
    await start(container);
    await hear("item_1", "…");
    await hear("item_2", "");
    expect(responseCreates()).toEqual([]);
  });
});
