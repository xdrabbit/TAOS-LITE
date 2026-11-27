// @vitest-environment jsdom
// /dictate's screen: which request each control sends, and what it shows.
//
// The route is mocked at `fetch`, so every assertion here is on what the
// screen SENT (multipart with audio vs JSON without) and what it then drew.
// The microphone is a fake MediaRecorder: jsdom has none, and the real one on
// an iPhone is the thing only a phone can confirm.
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyFor } from "@/lib/chrome/copy";
import {
  DICTATE_MODE_STORAGE_KEY,
  DICTATE_STYLE_STORAGE_KEY,
  DICTATE_TARGET_STORAGE_KEY
} from "@/lib/dictate/style";
import { PAIR_STORAGE_KEY } from "@/lib/translate/pair";

vi.mock("@/lib/authClient", () => ({
  jsonAuthHeaders: async () => ({ "Content-Type": "application/json", Authorization: "Bearer t" }),
  authHeaders: async () => ({ Authorization: "Bearer t" })
}));

vi.mock("@/lib/wakeLock", () => ({ keepWake: () => () => {} }));

interface Sent {
  url: string;
  body: BodyInit | null | undefined;
}
let sent: Sent[] = [];
let reply: { status: number; body: Record<string, unknown> } = { status: 200, body: {} };

class FakeRecorder {
  static isTypeSupported = () => true;
  static last: FakeRecorder | null = null;
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeRecorder.last = this;
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["sound"], { type: "audio/webm" }) });
    this.onstop?.();
  }
}

let now = 0;
let clipboard: { writeText: ReturnType<typeof vi.fn>; readText: ReturnType<typeof vi.fn> };
let track: { stop: ReturnType<typeof vi.fn>; onended: (() => void) | null };

beforeEach(() => {
  window.localStorage.clear();
  sent = [];
  reply = { status: 200, body: {} };
  now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      sent.push({ url, body: init?.body });
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "Content-Type": "application/json" }
      });
    })
  );
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  track = { stop: vi.fn(), onended: null };
  clipboard = { writeText: vi.fn(async () => {}), readText: vi.fn(async () => "") };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track], getAudioTracks: () => [track] })) }
  });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
  Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount(mine: "en" | "es" = "en"): Promise<HTMLElement> {
  window.localStorage.setItem(PAIR_STORAGE_KEY, JSON.stringify([mine, mine === "en" ? "es" : "en"]));
  const { DictateShell } = await import("@/components/DictateShell");
  const { container } = render(createElement(DictateShell));
  await act(async () => {});
  await act(async () => {});
  return container;
}

const q = (root: HTMLElement, selector: string) => root.querySelector(selector) as HTMLElement | null;
const tap = async (el: HTMLElement | null) => {
  expect(el).not.toBeNull();
  await act(async () => {
    fireEvent.click(el!);
  });
  await act(async () => {});
};

/** Tap, "speak" for `ms`, tap again. */
async function dictate(root: HTMLElement, ms = 3000) {
  await tap(q(root, "[data-dictate-mic]"));
  now += ms;
  await tap(q(root, "[data-dictate-mic]"));
  await act(async () => {});
}

describe("Speak — tap, talk, tap", () => {
  it("is tap-to-toggle: one tap starts the recorder, the next stops it and sends the audio", async () => {
    reply.body = { raw: "um the meeting is Wednesday", styled: "The meeting is on Wednesday.", style: "professional", lang: "en" };
    const root = await mount();
    const mic = q(root, "[data-dictate-mic]")!;
    expect(mic.textContent).toContain(copyFor("en").dictateTapToStart);

    await tap(mic);
    expect(FakeRecorder.last?.state).toBe("recording");
    expect(mic.getAttribute("aria-pressed")).toBe("true");
    expect(mic.textContent).toContain(copyFor("en").dictateTapToStop);
    expect(sent).toHaveLength(0);

    now += 3000;
    await tap(mic);
    await act(async () => {});
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("/api/dictate");
    const form = sent[0].body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("audio")).toBeInstanceOf(File);
    expect(form.get("style")).toBe("professional");
    expect(form.get("source")).toBe("en");
    expect(form.get("target")).toBe("same");
    // The mic is let go once the recording is in hand.
    expect(track.stop).toHaveBeenCalled();

    expect(q(root, "[data-dictate-result]")!.textContent).toContain("The meeting is on Wednesday.");
  });

  it("keeps the raw transcript behind a toggle", async () => {
    reply.body = { raw: "um the meeting is Wednesday", styled: "The meeting is on Wednesday." };
    const root = await mount();
    await dictate(root);
    expect(q(root, "[data-dictate-raw]")).toBeNull();
    await tap(q(root, "[data-dictate-raw-toggle]"));
    expect(q(root, "[data-dictate-raw]")!.textContent).toBe("um the meeting is Wednesday");
  });

  it("drops an accidental double-tap without sending anything", async () => {
    const root = await mount();
    await dictate(root, 200);
    expect(sent).toHaveLength(0);
    expect(q(root, "[role=alert]")!.textContent).toBe(copyFor("en").tooShort);
  });

  it("finishes the dictation when iOS ends the mic track mid-recording", async () => {
    reply.body = { raw: "what was said", styled: "What was said." };
    const root = await mount();
    await tap(q(root, "[data-dictate-mic]"));
    now += 4000;
    await act(async () => {
      track.onended?.();
    });
    await act(async () => {});
    expect(sent).toHaveLength(1);
    expect(q(root, "[data-dictate-result]")!.textContent).toContain("What was said.");
  });

  it("shows the route's own words when nothing was heard", async () => {
    reply = { status: 422, body: { error: "Nothing was heard — try again. · No se escuchó nada — intenta de nuevo." } };
    const root = await mount();
    await dictate(root);
    expect(q(root, "[role=alert]")!.textContent).toContain("Nothing was heard");
    expect(q(root, "[data-dictate-result]")).toBeNull();
  });

  it("says so when the microphone is refused", async () => {
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("denied"));
    const root = await mount();
    await tap(q(root, "[data-dictate-mic]"));
    expect(q(root, "[role=alert]")!.textContent).toBe(copyFor("en").micDenied);
    // And the button works again afterwards.
    expect((q(root, "[data-dictate-mic]") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("Re-style — the same words, no second recording", () => {
  it("tapping another style sends JSON with the transcript, not audio", async () => {
    reply.body = { raw: "um the meeting is Wednesday", styled: "The meeting is on Wednesday." };
    const root = await mount();
    await dictate(root);

    reply.body = { raw: "um the meeting is Wednesday", styled: "meeting's Wednesday!" };
    await tap(q(root, '[data-dictate-style="casual"]'));
    expect(sent).toHaveLength(2);
    expect(typeof sent[1].body).toBe("string");
    expect(JSON.parse(sent[1].body as string)).toEqual({
      raw: "um the meeting is Wednesday",
      style: "casual",
      source: "en",
      target: "same"
    });
    expect(q(root, "[data-dictate-result]")!.textContent).toContain("meeting's Wednesday!");
  });

  it("changing the output language re-writes it too", async () => {
    reply.body = { raw: "the meeting is Wednesday", styled: "The meeting is on Wednesday." };
    const root = await mount();
    await dictate(root);
    reply.body = { raw: "the meeting is Wednesday", styled: "La reunión es el miércoles." };
    await act(async () => {
      fireEvent.change(q(root, "[data-dictate-target]")!, { target: { value: "es" } });
    });
    await act(async () => {});
    expect(JSON.parse(sent[1].body as string).target).toBe("es");
    expect(q(root, "[data-dictate-result]")!.textContent).toContain("La reunión es el miércoles.");
  });

  it("with no result yet, choosing a style sends nothing", async () => {
    const root = await mount();
    await tap(q(root, '[data-dictate-style="formal"]'));
    expect(sent).toHaveLength(0);
    expect(q(root, '[data-dictate-style="formal"]')!.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("the choices are remembered per device", () => {
  it("stores the style, the output language and the mode", async () => {
    const root = await mount();
    await tap(q(root, '[data-dictate-style="casual"]'));
    await act(async () => {
      fireEvent.change(q(root, "[data-dictate-target]")!, { target: { value: "it" } });
    });
    await tap(q(root, '[data-dictate-mode="decode"]'));
    expect(window.localStorage.getItem(DICTATE_STYLE_STORAGE_KEY)).toBe("casual");
    expect(window.localStorage.getItem(DICTATE_TARGET_STORAGE_KEY)).toBe("it");
    expect(window.localStorage.getItem(DICTATE_MODE_STORAGE_KEY)).toBe("decode");
  });

  it("comes back in what was last used", async () => {
    window.localStorage.setItem(DICTATE_STYLE_STORAGE_KEY, "formal");
    window.localStorage.setItem(DICTATE_TARGET_STORAGE_KEY, "es");
    reply.body = { raw: "hello", styled: "Hola." };
    const root = await mount();
    expect(q(root, '[data-dictate-style="formal"]')!.getAttribute("aria-pressed")).toBe("true");
    await dictate(root);
    const form = sent[0].body as FormData;
    expect(form.get("style")).toBe("formal");
    expect(form.get("target")).toBe("es");
  });

  it("opens on the Decoder if that is where this phone left it", async () => {
    window.localStorage.setItem(DICTATE_MODE_STORAGE_KEY, "decode");
    const root = await mount();
    expect(q(root, "[data-dictate-paste-box]")).not.toBeNull();
    expect(q(root, "[data-dictate-mic]")).toBeNull();
  });
});

describe("Decoder — paste a message, read it", () => {
  const MESSY = "oye ya sali voy x la farmacia llego tipo 7";
  const DECODED = {
    mode: "decode",
    cleaned: "Oye, ya salí. Voy por la farmacia. Llego tipo 7.",
    translation: "Hey, I just left. I'm stopping by the pharmacy. I'll be there around 7.",
    notes: ['"tipo 7": morning or evening is not said.']
  };

  async function openDecoder(mine: "en" | "es" = "en") {
    const root = await mount(mine);
    await tap(q(root, '[data-dictate-mode="decode"]'));
    return root;
  }

  it("swaps the mic for a paste box", async () => {
    const root = await openDecoder();
    expect(q(root, "[data-dictate-mic]")).toBeNull();
    expect(q(root, "[data-dictate-style]")).toBeNull();
    expect(q(root, "[data-dictate-paste-box]")).not.toBeNull();
    expect((q(root, "[data-dictate-decode]") as HTMLButtonElement).disabled).toBe(true);
  });

  it("the Paste button fills the box from the clipboard", async () => {
    clipboard.readText.mockResolvedValueOnce(MESSY);
    const root = await openDecoder();
    await tap(q(root, "[data-dictate-paste]"));
    expect((q(root, "[data-dictate-paste-box]") as HTMLTextAreaElement).value).toBe(MESSY);
  });

  it("says how to paste by hand when the browser refuses the clipboard", async () => {
    clipboard.readText.mockRejectedValueOnce(new Error("NotAllowedError"));
    const root = await openDecoder();
    await tap(q(root, "[data-dictate-paste]"));
    expect(q(root, "[role=alert]")!.textContent).toBe(copyFor("en").dictatePasteBlocked);
  });

  it("sends JSON in decode mode with the owner as the reader — and no audio", async () => {
    reply.body = DECODED;
    const root = await openDecoder();
    await act(async () => {
      fireEvent.change(q(root, "[data-dictate-paste-box]")!, { target: { value: MESSY } });
    });
    await tap(q(root, "[data-dictate-decode]"));
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0].body as string)).toEqual({
      mode: "decode",
      raw: MESSY,
      reader: "en",
      other: "es"
    });
    expect(q(root, "[data-dictate-translation]")!.textContent).toContain("I'll be there around 7.");
    expect(q(root, "[data-dictate-cleaned]")!.textContent).toContain("Oye, ya salí.");
    expect(q(root, "[data-dictate-notes]")!.textContent).toContain("morning or evening is not said");
  });

  it("on Liz's phone the reader is Spanish", async () => {
    reply.body = DECODED;
    const root = await openDecoder("es");
    await act(async () => {
      fireEvent.change(q(root, "[data-dictate-paste-box]")!, { target: { value: "running late" } });
    });
    await tap(q(root, "[data-dictate-decode]"));
    expect(JSON.parse(sent[0].body as string)).toMatchObject({ reader: "es", other: "en" });
  });

  it("draws no notes box for a message that was clear", async () => {
    reply.body = { ...DECODED, notes: [] };
    const root = await openDecoder();
    await act(async () => {
      fireEvent.change(q(root, "[data-dictate-paste-box]")!, { target: { value: MESSY } });
    });
    await tap(q(root, "[data-dictate-decode]"));
    expect(q(root, "[data-dictate-translation]")).not.toBeNull();
    expect(q(root, "[data-dictate-notes]")).toBeNull();
  });
});

describe("Copy and Share", () => {
  async function withResult() {
    reply.body = { raw: "the meeting is Wednesday", styled: "The meeting is on Wednesday." };
    const root = await mount();
    await dictate(root);
    return root;
  }

  it("copies the styled text on the tap, and never on its own", async () => {
    const root = await withResult();
    // A result arriving is not a gesture: iOS would refuse the write.
    expect(clipboard.writeText).not.toHaveBeenCalled();
    await tap(q(root, '[data-dictate-copy="styled"]'));
    expect(clipboard.writeText).toHaveBeenCalledWith("The meeting is on Wednesday.");
    expect(q(root, '[data-dictate-copy="styled"]')!.textContent).toBe(copyFor("en").dictateCopied);
  });

  it("hides Share where the browser has no share sheet", async () => {
    const root = await withResult();
    expect(q(root, "[data-dictate-share]")).toBeNull();
  });

  it("shares the text through the Web Share API where there is one", async () => {
    const share = vi.fn(async () => {});
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    const root = await withResult();
    await tap(q(root, '[data-dictate-share="styled"]'));
    expect(share).toHaveBeenCalledWith({ text: "The meeting is on Wednesday." });
  });
});

describe("the chrome follows the phone's owner", () => {
  it("is Spanish on a phone whose side of the pair is Spanish, with no English doubled in", async () => {
    const root = await mount("es");
    const es = copyFor("es");
    expect(root.querySelector("h1")!.textContent).toBe(es.dictateTitle);
    expect(q(root, "[data-dictate-mic]")!.textContent).toContain(es.dictateTapToStart);
    expect(q(root, '[data-dictate-style="casual"]')!.textContent).toBe("Informal");
    expect(q(root, '[data-dictate-style="formal"]')!.textContent).toBe("Formal");
    expect(q(root, '[data-dictate-mode="decode"]')!.textContent).toBe(es.dictateModeDecode);
    expect(root.textContent).not.toContain(copyFor("en").dictateTapToStart);
    expect(root.textContent).toContain("Español");
  });

  it("marks every Spanish Dictate string for Liz's review", async () => {
    const { readFileSync } = await import("node:fs");
    const lines = readFileSync("lib/chrome/copy.ts", "utf8")
      .split("\n")
      .filter((line) => /^\s{4}(dictate[A-Z]\w*|navDictate):/.test(line));
    expect(lines.length).toBeGreaterThan(25);
    for (const line of lines) {
      expect(line, line).toContain("// pendiente de revisión por Liz");
    }
  });
});
