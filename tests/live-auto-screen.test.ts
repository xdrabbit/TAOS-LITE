// @vitest-environment jsdom
//
// /live two-way Auto and "Save this conversation", on the screen and on the
// wire (Tom and Liz, 2026-11-17). tests/live-auto.test.ts pins the prompt, the
// session and the echo fences; tests/live-saved.test.ts pins the routes. This
// file drives the real shell and the real WebRTC client against a scripted
// provider — two languages alternating, one detect miss, one echo injection —
// and asserts on what was SENT and what is ON SCREEN.
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENGLISH, copyFor, fill } from "@/lib/chrome/copy";
import { LIVE_AUTO_STORAGE_KEY } from "@/lib/live/auto";
import { LIVE_SAVE_STORAGE_KEY } from "@/lib/live/saved";
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

// ── A stand-in for the phone's WebRTC stack, and for the servers ────────────

let sent: Array<Record<string, unknown>> = [];
let serverSays: (ev: Record<string, unknown>) => void = () => {};
let mintBodies: Array<Record<string, unknown>> = [];
let savedBodies: Array<Record<string, any>> = [];
let ttsBodies: Array<Record<string, unknown>> = [];
let saveStatus: { allowed: boolean; ready: boolean; hasSaved?: boolean } | null = null;
/** Set → the next /api/tts answer waits for it (a slow readout). */
let ttsHold: Promise<void> | null = null;
/** Set → the next mint waits for it (a session still connecting). */
let mintHold: Promise<void> | null = null;
/** True → the browser refuses to play (autoplay policy, a dead element). */
let playRefused = false;
let micTrack = { enabled: true, stop: () => {} };
/** Every <audio> the shell asked to play, so a test can end the readout. */
let playing: HTMLMediaElement[] = [];

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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  window.localStorage.clear();
  sent = [];
  mintBodies = [];
  savedBodies = [];
  ttsBodies = [];
  saveStatus = null;
  ttsHold = null;
  mintHold = null;
  playRefused = false;
  delete process.env.NEXT_PUBLIC_ENABLE_ONDEVICE_STT;
  playing = [];
  micTrack = { enabled: true, stop: () => {} };
  window.HTMLElement.prototype.scrollIntoView = () => {};
  // A readout stays "playing" until the test ends it (endReadout below).
  window.HTMLMediaElement.prototype.play = function play(this: HTMLMediaElement) {
    if (playRefused && this.src) return Promise.reject(new DOMException("refused", "NotAllowedError"));
    if (this.src) playing.push(this);
    return Promise.resolve();
  };
  window.HTMLMediaElement.prototype.pause = function pause(this: HTMLMediaElement) {
    (this.onpause as (() => void) | null)?.call(this);
  };
  URL.createObjectURL = () => "blob:readout";
  URL.revokeObjectURL = () => {};
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(window.navigator, "mediaDevices", {
    value: { getUserMedia: async () => ({ getTracks: () => [micTrack] }) },
    configurable: true
  });
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: { body?: unknown }) => {
      const u = String(url);
      const body = () => JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (u.includes("/api/live/realtime")) {
        mintBodies.push(body());
        if (mintHold) await mintHold;
        return json({ clientSecret: "ek_test", callUrl: "https://example.test/calls", styles: {} });
      }
      if (u.includes("/api/live/saved/status")) {
        return saveStatus ? json(saveStatus) : json({ error: "Please sign in." }, 401);
      }
      if (u.includes("/api/live/saved/lines")) {
        savedBodies.push(body());
        return json({ ok: true });
      }
      if (u.includes("/api/tts")) {
        ttsBodies.push(body());
        if (ttsHold) await ttsHold;
        // Bytes, not a Blob: jsdom's Blob has no .stream(), and Node 22 (CI)
        // refuses to build a Response from one.
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "audio/mpeg" } });
      }
      return new Response("v=0", { status: 200 });
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function mount(pair: [string, string] = ["en", "es"]): Promise<HTMLElement> {
  window.localStorage.setItem(PAIR_STORAGE_KEY, JSON.stringify(pair));
  const { LiveShell } = await import("@/components/LiveShell");
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(createElement(LiveShell)));
  });
  // The save-status answer arrives a tick later.
  await act(async () => {});
  return container;
}

async function tap(el: Element) {
  await act(async () => {
    fireEvent.click(el);
  });
}

const settle = async (n = 4) => {
  for (let i = 0; i < n; i += 1) await act(async () => {});
};

const autoChip = (c: HTMLElement) => c.querySelector<HTMLButtonElement>("[data-live-auto-chip]")!;
const saveChip = (c: HTMLElement) => c.querySelector<HTMLButtonElement>("[data-live-save-chip]");
const styleChips = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLButtonElement>("[data-live-style] button"));
const voiceChip = (c: HTMLElement) =>
  Array.from(c.querySelectorAll("button")).find((b) => /Voice/.test(b.textContent ?? ""))!;
const start = (c: HTMLElement) => c.querySelector<HTMLButtonElement>("[data-live-controls] button")!;
const lines = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>("[data-live-line]"));
const responseCreates = () => sent.filter((e) => e.type === "response.create");

/** One heard segment: committed, then transcribed. */
async function hear(itemId: string, transcript: string) {
  await act(async () => {
    serverSays({ type: "input_audio_buffer.speech_started" });
    serverSays({ type: "input_audio_buffer.speech_stopped" });
    serverSays({ type: "input_audio_buffer.committed", item_id: itemId });
    serverSays({ type: "conversation.item.input_audio_transcription.completed", item_id: itemId, transcript });
  });
}

/** The model's TEXT answer, in the pieces the API streams it in. */
async function answer(...deltas: string[]) {
  await act(async () => {
    for (const delta of deltas) serverSays({ type: "response.output_text.delta", delta });
    serverSays({ type: "response.output_text.done", text: deltas.join("") });
    serverSays({ type: "response.done" });
  });
  await settle();
}

async function endReadout() {
  await act(async () => {
    const a = playing.shift()!;
    (a.onended as (() => void) | null)?.call(a);
  });
  await settle();
}

/** What a line card says, as [label, text] pairs: heard first, then rendered. */
function read(card: HTMLElement): string[][] {
  return ["[data-live-heard]", "[data-live-rendered]"].map((sel) => {
    const half = card.querySelector(sel);
    return half ? [half.querySelector("span")!.textContent ?? "", half.querySelector("p")!.textContent ?? ""] : [];
  });
}

describe("/live: the Auto-detect chip", () => {
  it("is there, OFF, and a START without it sends the request /live has always sent", async () => {
    const c = await mount();
    expect(autoChip(c).textContent).toContain(ENGLISH.liveAutoChip);
    expect(autoChip(c).getAttribute("aria-pressed")).toBe("false");
    expect(window.localStorage.getItem(LIVE_AUTO_STORAGE_KEY)).toBeNull();
    // The style row is untouched: two chips, Summary on, both tappable.
    expect(styleChips(c).map((b) => [b.textContent, b.disabled])).toEqual([
      ["Summary", false],
      ["Word for word", false]
    ]);
    await tap(start(c));
    expect(mintBodies).toEqual([{ target: "en", source: "es", style: "summary" }]);
  });

  it("is its own wrapping row, outside the pinned Stop/Clear bar", async () => {
    const c = await mount();
    const row = c.querySelector("[data-live-auto]")!;
    expect(c.querySelector("[data-live-controls]")!.contains(row)).toBe(false);
    expect(row.querySelector("div")!.getAttribute("class")).toContain("flex-wrap");
  });

  it("on: remembered per device, word for word only (and says why), voice off, stored style left alone", async () => {
    window.localStorage.setItem(LIVE_STYLE_STORAGE_KEY, "summary");
    const c = await mount();
    await tap(autoChip(c));
    expect(autoChip(c).getAttribute("aria-pressed")).toBe("true");
    expect(window.localStorage.getItem(LIVE_AUTO_STORAGE_KEY)).toBe("1");
    expect(styleChips(c).map((b) => [b.getAttribute("aria-pressed"), b.disabled])).toEqual([
      ["false", true],
      ["true", true]
    ]);
    expect(c.textContent).toContain(ENGLISH.liveAutoVerbatimOnly);
    expect(c.textContent).toContain(fill(ENGLISH.liveAutoHint, { a: "English", b: "Español" }));
    expect(c.textContent).toContain("Español ⇄ English");
    expect(voiceChip(c).textContent).toContain("Voice off");
    expect(c.textContent).toContain(ENGLISH.liveAutoVoiceHint);
    expect(window.localStorage.getItem(LIVE_STYLE_STORAGE_KEY)).toBe("summary");

    cleanup();
    const again = await mount();
    expect(autoChip(again).getAttribute("aria-pressed")).toBe("true");
    await tap(autoChip(again));
    expect(window.localStorage.getItem(LIVE_AUTO_STORAGE_KEY)).toBe("0");
    expect(styleChips(again).map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
  });

  it("is written in the owner's language", async () => {
    const c = await mount(["es", "en"]);
    expect(autoChip(c).textContent).toContain(copyFor("es").liveAutoChip);
  });

  it("flipped while live, restarts the session the other way — Auto is minted, not patched", async () => {
    const c = await mount();
    await tap(start(c));
    await tap(autoChip(c));
    await settle();
    expect(mintBodies).toEqual([
      { target: "en", source: "es", style: "summary" },
      { target: "en", source: "es", style: "verbatim", auto: true }
    ]);
    expect(sent.filter((e) => e.type === "session.update")).toEqual([]);
  });
});

describe("/live Auto: two people, one phone, a scripted provider", () => {
  async function live(): Promise<HTMLElement> {
    const c = await mount();
    await tap(autoChip(c));
    await tap(start(c));
    await settle();
    expect(mintBodies).toEqual([{ target: "en", source: "es", style: "verbatim", auto: true }]);
    return c;
  }

  it("each segment is asked for on its own and lands as one card: heard + rendering, each under its language", async () => {
    const c = await live();

    await hear("i1", "¿Dónde está el baño?");
    expect(responseCreates()).toEqual([
      { type: "response.create", response: { input: [{ type: "item_reference", id: "i1" }] } }
    ]);
    await answer("[e", "n] Where", " is the bathroom?");

    await hear("i2", "Down the hall, on the left.");
    await answer("[es]", " Al fondo,", " a la izquierda.");

    // Newest first, like the rest of /live's feed.
    expect(lines(c).map(read)).toEqual([
      [
        ["English", "Down the hall, on the left."],
        ["Español", "Al fondo, a la izquierda."]
      ],
      [
        ["Español", "¿Dónde está el baño?"],
        ["English", "Where is the bathroom?"]
      ]
    ]);
    expect(lines(c).map((l) => l.getAttribute("data-detect"))).toEqual(["hit", "hit"]);
    // The tag is plumbing: it never reaches the screen, whole or in pieces.
    expect(c.textContent).not.toMatch(/\[e|\[es\]|\[en\]/);
    expect(c.querySelector("[data-live-auto-counts]")).toBeNull();
    // Nothing was spoken, so nothing can have been heard back.
    expect(ttsBodies).toEqual([]);
    expect(micTrack.enabled).toBe(true);
  });

  it("a miss keeps its words, names no language, and is counted on the screen", async () => {
    const c = await live();
    await hear("i1", "Gracias, muy amable.");
    await answer("Thank you,", " very kind.");
    const [card] = lines(c);
    expect(card.getAttribute("data-detect")).toBe("miss");
    expect(read(card)).toEqual([
      ["?", "Gracias, muy amable."],
      [`? · ${ENGLISH.liveAutoMissTag}`, "Thank you, very kind."]
    ]);
    expect(c.querySelector("[data-live-auto-counts]")!.textContent).toBe(fill(ENGLISH.liveAutoMisses, { count: 1 }));

    // A tag for a language that is not at this table is a miss too, shown as it came.
    await hear("i2", "Bonjour.");
    await answer("[fr] Bonjour.");
    expect(lines(c)[0].getAttribute("data-detect")).toBe("miss");
    expect(read(lines(c)[0])[1][1]).toBe("[fr] Bonjour.");
    expect(c.querySelector("[data-live-auto-counts]")!.textContent).toBe(fill(ENGLISH.liveAutoMisses, { count: 2 }));
  });

  it("voice on: the mic is shut while the line is read, and the readout coming back is dropped, counted, never translated", async () => {
    const c = await live();
    await tap(voiceChip(c));
    expect(voiceChip(c).textContent).toContain("Voice");
    expect(voiceChip(c).getAttribute("aria-pressed")).toBe("true");

    await hear("i1", "¿Dónde está el baño, por favor?");
    await answer("[en] Where is the bathroom, please?");
    // The readout is a fetch, a blob and a play() away: wait for it rather
    // than count ticks (a slower machine takes more of them).
    await act(async () => {
      await vi.waitFor(() => expect(playing.length).toBe(1), { timeout: 5000 });
    });
    // Read through /api/tts, in the direction the tag gave.
    expect(ttsBodies).toEqual([
      { text: "Where is the bathroom, please?", latency: "flash", sourceLanguage: "es", targetLanguage: "en" }
    ]);
    expect(playing.length).toBe(1);
    // Fence one: while it plays, the session is sent silence.
    expect(micTrack.enabled).toBe(false);
    await endReadout();
    // …and for the 300 ms tail after.
    expect(micTrack.enabled).toBe(false);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    expect(micTrack.enabled).toBe(true);

    // Fence two — the echo injection: the provider reports hearing what this
    // phone just said. No response is asked for it.
    const asked = responseCreates().length;
    await hear("i2", "Where is the bathroom, please?");
    expect(responseCreates().length).toBe(asked);
    expect(lines(c).length).toBe(1);
    expect(c.querySelector("[data-live-auto-counts]")!.textContent).toBe(fill(ENGLISH.liveAutoEchoes, { count: 1 }));

    // The actual reply still goes through.
    await hear("i3", "Down the hall, on the left.");
    expect(responseCreates().length).toBe(asked + 1);
    await answer("[es] Al fondo, a la izquierda.");
    expect(lines(c).length).toBe(2);
  });

  it("a miss is not read aloud — there is no direction to pick a voice for", async () => {
    const c = await live();
    await tap(voiceChip(c));
    await hear("i1", "Gracias, muy amable.");
    await answer("Thank you, very kind.");
    expect(ttsBodies).toEqual([]);
    expect(micTrack.enabled).toBe(true);
  });

  it("outside Auto the feed is what it was: one card of the rendering, no labels", async () => {
    const c = await mount();
    await tap(start(c));
    await hear("i1", "¿Dónde está el baño?");
    await act(async () => {
      serverSays({ type: "response.output_audio_transcript.done", transcript: "Asking where the bathroom is." });
      serverSays({ type: "response.done" });
    });
    expect(lines(c)).toEqual([]);
    expect(c.querySelector("ol")!.textContent).toContain("Asking where the bathroom is.");
  });
});

// ── Copilot's review of #137 ────────────────────────────────────────────────

/** A promise the test resolves when it is ready. */
function hold(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

describe("/live Auto voice: a readout belongs to the session that produced it", () => {
  async function liveWithVoice(): Promise<HTMLElement> {
    const c = await mount();
    await tap(autoChip(c));
    await tap(start(c));
    await settle();
    await tap(voiceChip(c));
    return c;
  }

  it("STOP while /api/tts is still answering: the line is not read into a stopped room", async () => {
    const c = await liveWithVoice();
    const tts = hold();
    ttsHold = tts.promise;
    await hear("i1", "¿Dónde está el baño, por favor?");
    await answer("[en] Where is the bathroom, please?");
    expect(ttsBodies).toHaveLength(1);
    await tap(start(c)); // STOP
    await settle();
    await act(async () => tts.release());
    await settle(8);
    expect(playing).toEqual([]);
  });

  it("STOP then START: the old readout neither plays nor touches the new session's mic", async () => {
    const c = await liveWithVoice();
    const tts = hold();
    ttsHold = tts.promise;
    await hear("i1", "¿Dónde está el baño, por favor?");
    await answer("[en] Where is the bathroom, please?");
    await tap(start(c)); // STOP
    await settle();
    ttsHold = null;
    await tap(start(c)); // START — a new session, voice still on
    await settle();
    expect(mintBodies).toHaveLength(2);
    const micOfNew = micTrack;
    const flips: boolean[] = [];
    Object.defineProperty(micOfNew, "enabled", {
      get: () => true,
      set: (v: boolean) => flips.push(v),
      configurable: true
    });
    await act(async () => tts.release());
    await settle(8);
    expect(playing).toEqual([]);
    expect(flips).toEqual([]);

    // The new session's own lines are still read.
    await hear("i2", "Gracias, muy amable.");
    await answer("[en] Thank you, very kind.");
    await act(async () => {
      await vi.waitFor(() => expect(playing.length).toBe(1), { timeout: 5000 });
    });
    expect(flips).toEqual([false]);
  });
});

describe("/live Auto voice: the echo entry is for words that were actually spoken", () => {
  it("a refused play() records nothing: somebody really saying that sentence is translated, and the mic comes back", async () => {
    const c = await mount();
    await tap(autoChip(c));
    await tap(start(c));
    await settle();
    await tap(voiceChip(c));
    playRefused = true;
    await hear("i1", "¿Dónde está el baño, por favor?");
    await answer("[en] Where is the bathroom, please?");
    await act(async () => {
      await vi.waitFor(() => expect(ttsBodies).toHaveLength(1), { timeout: 5000 });
    });
    await settle(8);
    expect(playing).toEqual([]);
    // The gate opened again (after the tail), though nothing ever "ended".
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    expect(micTrack.enabled).toBe(true);

    // The phone made no sound, so this is a person, not an echo.
    const asked = responseCreates().length;
    await hear("i2", "Where is the bathroom, please?");
    expect(responseCreates().length).toBe(asked + 1);
    expect(c.querySelector("[data-live-auto-counts]")).toBeNull();
  });
});

describe("/live: the Voice button on the on-device engine", () => {
  it("a remembered Auto does not capture it — it toggles the voice that engine shows", async () => {
    process.env.NEXT_PUBLIC_ENABLE_ONDEVICE_STT = "1";
    window.localStorage.setItem(LIVE_AUTO_STORAGE_KEY, "1");
    const c = await mount();
    const onDevice = Array.from(c.querySelectorAll("button")).find((b) => b.textContent === "On-device")!;
    await tap(onDevice);
    // Auto is ambient-only: no chip, and the button shows the device voice (on).
    expect(c.querySelector("[data-live-auto-chip]")).toBeNull();
    expect(voiceChip(c).getAttribute("aria-pressed")).toBe("true");
    await tap(voiceChip(c));
    expect(voiceChip(c).getAttribute("aria-pressed")).toBe("false");
    expect(voiceChip(c).textContent).toContain("Voice off");
    await tap(voiceChip(c));
    expect(voiceChip(c).getAttribute("aria-pressed")).toBe("true");

    // Back on Ambient with Auto still remembered: Auto's own switch, still off.
    const ambient = Array.from(c.querySelectorAll("button")).find((b) => /Ambient AI/.test(b.textContent ?? ""))!;
    await tap(ambient);
    expect(autoChip(c).getAttribute("aria-pressed")).toBe("true");
    expect(voiceChip(c).textContent).toContain("Voice off");
  });
});

describe("/live: Auto tapped while the session is still connecting", () => {
  it("the session that comes up is bounced into what the chip says", async () => {
    const c = await mount();
    const mint = hold();
    mintHold = mint.promise;
    await tap(start(c));
    expect(mintBodies).toEqual([{ target: "en", source: "es", style: "summary" }]);
    await tap(autoChip(c)); // no session yet to restart
    expect(autoChip(c).getAttribute("aria-pressed")).toBe("true");
    expect(mintBodies).toHaveLength(1);
    mintHold = null;
    await act(async () => mint.release());
    await settle(8);
    expect(mintBodies).toEqual([
      { target: "en", source: "es", style: "summary" },
      { target: "en", source: "es", style: "verbatim", auto: true }
    ]);
    // And it IS an Auto session: a tagged line lands as a line card.
    await hear("i1", "¿Dónde está el baño?");
    await answer("[en] Where is the bathroom?");
    expect(lines(c)).toHaveLength(1);
  });

  it("tapped on and off again before it connects: nothing to reconcile, one session", async () => {
    const c = await mount();
    const mint = hold();
    mintHold = mint.promise;
    await tap(start(c));
    await tap(autoChip(c));
    await tap(autoChip(c));
    mintHold = null;
    await act(async () => mint.release());
    await settle(8);
    expect(mintBodies).toEqual([{ target: "en", source: "es", style: "summary" }]);
  });
});

describe("/live: the way to what was saved", () => {
  const link = (c: HTMLElement) => c.querySelector<HTMLAnchorElement>("[data-live-saved-link]");

  it("is there for someone who has saved text but may no longer save — with no Save chip", async () => {
    saveStatus = { allowed: false, ready: false, hasSaved: true };
    const c = await mount();
    expect(saveChip(c)).toBeNull();
    expect(link(c)!.getAttribute("href")).toBe("/live/saved");
    expect(link(c)!.textContent).toBe(ENGLISH.liveSavedLink);
  });

  it("is there for someone who can save, and not for someone with neither", async () => {
    saveStatus = { allowed: true, ready: true, hasSaved: false };
    expect(link(await mount())).not.toBeNull();
    cleanup();
    saveStatus = { allowed: false, ready: false, hasSaved: false };
    expect(link(await mount())).toBeNull();
    cleanup();
    saveStatus = null; // signed out, or the answer never came
    expect(link(await mount())).toBeNull();
  });
});

describe("/live: Save this conversation", () => {
  it("no toggle at all for someone who may not save (or when the answer never comes)", async () => {
    const c = await mount();
    expect(saveChip(c)).toBeNull();
    cleanup();
    saveStatus = { allowed: false, ready: true };
    expect(saveChip(await mount())).toBeNull();
  });

  it("tables not there yet: shown, disabled, with the reason — and a stored ON saves nothing", async () => {
    saveStatus = { allowed: true, ready: false };
    window.localStorage.setItem(LIVE_SAVE_STORAGE_KEY, "1");
    const c = await mount();
    expect(saveChip(c)!.disabled).toBe(true);
    expect(saveChip(c)!.getAttribute("aria-pressed")).toBe("false");
    expect(c.querySelector("[data-live-save-hint]")!.textContent).toBe(ENGLISH.liveSaveNotReady);
    await tap(autoChip(c));
    await tap(start(c));
    await settle();
    await hear("i1", "¿Dónde está el baño?");
    await answer("[en] Where is the bathroom?");
    expect(savedBodies).toEqual([]);
  });

  it("is OFF by default and then nothing is sent, in either mode", async () => {
    saveStatus = { allowed: true, ready: true };
    const c = await mount();
    expect(saveChip(c)!.disabled).toBe(false);
    expect(saveChip(c)!.getAttribute("aria-pressed")).toBe("false");
    expect(window.localStorage.getItem(LIVE_SAVE_STORAGE_KEY)).toBeNull();
    await tap(autoChip(c));
    await tap(start(c));
    await settle();
    await hear("i1", "¿Dónde está el baño?");
    await answer("[en] Where is the bathroom?");
    expect(savedBodies).toEqual([]);
  });

  it("only lines produced while it is ON are sent — text, languages and the detect result, one session id", async () => {
    saveStatus = { allowed: true, ready: true };
    const c = await mount();
    await tap(autoChip(c));
    await tap(start(c));
    await settle();

    await hear("i1", "Buenas tardes.");
    await answer("[en] Good afternoon.");
    expect(savedBodies).toEqual([]);

    await tap(saveChip(c)!);
    expect(window.localStorage.getItem(LIVE_SAVE_STORAGE_KEY)).toBe("1");
    expect(c.querySelector("[data-live-save-hint]")!.textContent).toBe(ENGLISH.liveSaveOnHint);
    await hear("i2", "¿Dónde está el baño?");
    await answer("[en] Where is the bathroom?");
    await hear("i3", "Gracias.");
    await answer("Thanks.");

    await tap(saveChip(c)!);
    await hear("i4", "Down the hall.");
    await answer("[es] Al fondo.");

    expect(savedBodies.map((b) => b.line)).toEqual([
      { seq: 1, heard: "¿Dónde está el baño?", heardLang: "es", text: "Where is the bathroom?", textLang: "en", detect: "hit" },
      { seq: 2, heard: "Gracias.", heardLang: null, text: "Thanks.", textLang: null, detect: "miss" }
    ]);
    const ids = new Set(savedBodies.map((b) => b.session.id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(savedBodies[0].session).toMatchObject({ mine: "en", theirs: "es", style: "verbatim", auto: true });
    // No audio travels with a saved line: the body is these two objects.
    expect(Object.keys(savedBodies[0]).sort()).toEqual(["line", "session"]);
  });

  it("saves one-direction /live too, with the session's own direction", async () => {
    saveStatus = { allowed: true, ready: true };
    window.localStorage.setItem(LIVE_SAVE_STORAGE_KEY, "1");
    const c = await mount();
    expect(saveChip(c)!.getAttribute("aria-pressed")).toBe("true");
    await tap(start(c));
    await hear("i1", "¿Dónde está el baño?");
    await act(async () => {
      serverSays({ type: "response.output_audio_transcript.done", transcript: "Asking where the bathroom is." });
      serverSays({ type: "response.done" });
    });
    await settle();
    expect(savedBodies.map((b) => b.line)).toEqual([
      {
        seq: 1,
        heard: "¿Dónde está el baño?",
        heardLang: "es",
        text: "Asking where the bathroom is.",
        textLang: "en",
        detect: null
      }
    ]);
    expect(savedBodies[0].session).toMatchObject({ style: "summary", auto: false });
  });

  it("a failed write is counted on the screen and interrupts nothing", async () => {
    saveStatus = { allowed: true, ready: true };
    window.localStorage.setItem(LIVE_SAVE_STORAGE_KEY, "1");
    const c = await mount();
    const real = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) =>
        String(url).includes("/api/live/saved/lines")
          ? new Response("{}", { status: 502 })
          : (real as typeof fetch)(url as RequestInfo, init)
      )
    );
    await tap(autoChip(c));
    await tap(start(c));
    await settle();
    await hear("i1", "¿Dónde está el baño?");
    await answer("[en] Where is the bathroom?");
    expect(lines(c).length).toBe(1);
    expect(c.textContent).toContain(fill(ENGLISH.liveSaveFailed, { count: 1 }));
  });
});
