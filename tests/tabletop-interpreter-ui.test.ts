// @vitest-environment jsdom
//
// Tabletop Interpreter mode, mounted (Tom, 2026-11-09). The rules live in
// tests/tabletop-interpreter.test.ts; this file is the SCREEN:
//
//   - the chip that opens the mode exists only for a founder with
//     TAOS_INTERPRETER_ENABLED on — everyone else's table is untouched;
//   - one tap starts a continuous session; there is no per-turn button;
//   - captions of both sides, OLDEST FIRST, each pane in its reader's
//     language, in a follow-the-tail scroll box (#101);
//   - the big Stop is in the middle strip, which is outside both scroll boxes
//     and so can never scroll away (#117);
//   - the cap and the idle stop end the session by themselves;
//   - the founder picker switches engines per device, no redeploy;
//   - what leaves the phone at the end is NUMBERS.
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement, type ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAIR_STORAGE_KEY } from "@/lib/translate/pair";
import { emptyInterpreterTally } from "@/lib/interpreter/cost";
import { ENGINE_STORAGE_KEY, engineTakesBriefing, type InterpreterEngine } from "@/lib/interpreter/engine";
import { STYLE_STORAGE_KEY, type InterpreterStyle } from "@/lib/interpreter/mediator";
import type { InterpreterHandlers } from "@/lib/interpreter/client";
import type { InterpreterModeProps } from "@/components/tabletop/InterpreterMode";

const world = vi.hoisted(() => ({ email: "xdrabbit@gmail.com" }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/tabletop",
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams()
}));

vi.mock("@/lib/supabase", async () => {
  const actual = await vi.importActual<typeof import("@/lib/supabase")>("@/lib/supabase");
  return {
    ...actual,
    supabase: {
      auth: {
        getSession: async () => ({
          data: { session: { access_token: "t", user: { id: "u", email: world.email } } }
        }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } })
      }
    }
  };
});

vi.mock("@/lib/authClient", () => ({
  jsonAuthHeaders: async () => ({ "Content-Type": "application/json" }),
  authHeaders: async () => ({})
}));

// ── a fake engine: everything the real one hands the screen, no microphone ──

interface FakeSession {
  engine: InterpreterEngine;
  mine: string;
  theirs: string;
  style?: InterpreterStyle;
  handlers: InterpreterHandlers;
}
const fake = {
  sessions: [] as FakeSession[],
  stop: vi.fn(async () => emptyInterpreterTally("openai-realtime", "m", 0)),
  maxSeconds: 1800,
  idleSeconds: 60,
  briefing: { applied: true, contextChars: 120, contextStatus: "ok" as const },
  fail: null as string | null
};

const fakeStart: NonNullable<InterpreterModeProps["start"]> = async (opts) => {
  if (fake.fail) throw new Error(fake.fail);
  fake.sessions.push(opts);
  const startedAt = Date.now();
  return {
    engine: opts.engine,
    model: "gpt-realtime-2.1",
    // What the server would answer: an unbriefable engine is never a mediator.
    style: engineTakesBriefing(opts.engine) ? (opts.style ?? "interpreter") : "interpreter",
    legs: 2,
    maxSeconds: fake.maxSeconds,
    idleSeconds: fake.idleSeconds,
    briefing: fake.briefing,
    tally: () => ({
      ...emptyInterpreterTally(opts.engine, "gpt-realtime-2.1", startedAt, 2),
      responses: 4,
      audioInTokens: 500,
      audioOutTokens: 900,
      bargeIns: 1
    }),
    stop: fake.stop
  };
};

interface Posted {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}
let posted: Posted[] = [];
let contextOnServer = { context: "", status: "ok" as string };

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(PAIR_STORAGE_KEY, JSON.stringify(["en", "es"]));
  world.email = "xdrabbit@gmail.com";
  fake.sessions = [];
  fake.stop.mockClear();
  fake.maxSeconds = 1800;
  fake.idleSeconds = 60;
  fake.briefing = { applied: true, contextChars: 120, contextStatus: "ok" };
  fake.fail = null;
  posted = [];
  contextOnServer = { context: "", status: "ok" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      posted.push({ url, method, body });
      const json = (o: unknown, status = 200) =>
        new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/interpreter/context")) {
        if (method === "PUT") {
          if (contextOnServer.status === "missing_table") return json({ error: "x", status: "missing_table" }, 409);
          contextOnServer.context = String(body?.context ?? "");
          return json({ context: contextOnServer.context, status: "ok", maxChars: 4000 });
        }
        return json({ ...contextOnServer, maxChars: 4000 });
      }
      return json({});
    })
  );
  window.HTMLElement.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mountMode(props: Partial<InterpreterModeProps> = {}): Promise<{
  container: HTMLElement;
  onExit: ReturnType<typeof vi.fn>;
  unmount: () => void;
}> {
  const { InterpreterMode } = await import("@/components/tabletop/InterpreterMode");
  const onExit = vi.fn();
  const { container, unmount } = render(
    createElement(InterpreterMode, {
      mine: "en",
      theirs: "es",
      defaultEngine: "openai-realtime",
      onExit,
      start: fakeStart,
      ...props
    })
  );
  await act(async () => {});
  return { container, onExit, unmount };
}

const toggle = (c: HTMLElement) => c.querySelector<HTMLButtonElement>("[data-interpreter-toggle]")!;
const cls = (el: Element) => el.getAttribute("class") ?? "";

async function tapStart(container: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(toggle(container));
  });
  await act(async () => {});
}

const usagePosts = () => posted.filter((p) => p.url.endsWith("/interpreter/usage"));

// ── the chip on /tabletop ──────────────────────────────────────────────────

describe("the Interpreter chip on /tabletop", () => {
  async function mountTable(props: Record<string, unknown>): Promise<HTMLElement> {
    const { TabletopShell } = await import("@/components/TabletopShell");
    const { container } = render(createElement(TabletopShell as ComponentType<Record<string, unknown>>, props));
    await act(async () => {});
    await act(async () => {});
    return container;
  }

  it("is there for a founder when the flag is on", async () => {
    const c = await mountTable({ interpreterEnabled: true });
    const chip = c.querySelector<HTMLButtonElement>("[data-tabletop-interpreter]");
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("Interpreter");
    // Not inside a scroll box: it sits in the table's middle strip.
    expect(chip!.closest("[data-tabletop-controls]")).not.toBeNull();
  });

  it("is absent with the flag off — a founder's table is exactly today's", async () => {
    const c = await mountTable({});
    expect(c.querySelector("[data-tabletop-interpreter]")).toBeNull();
    expect(c.querySelector("[data-interpreter]")).toBeNull();
    expect(c.querySelectorAll("[data-tabletop-talk]")).toHaveLength(2);
  });

  it("is absent for a non-founder even with the flag on", async () => {
    world.email = "someone@example.com";
    const c = await mountTable({ interpreterEnabled: true });
    expect(c.querySelector("[data-tabletop-interpreter]")).toBeNull();
    expect(c.querySelectorAll("[data-tabletop-talk]")).toHaveLength(2);
  });

  it("opens the mode in place of the talk panes, on the deployment's default engine", async () => {
    const c = await mountTable({ interpreterEnabled: true, interpreterEngine: "openai-translate" });
    await act(async () => {
      fireEvent.click(c.querySelector("[data-tabletop-interpreter]")!);
    });
    await act(async () => {});
    expect(c.querySelector("[data-interpreter]")).not.toBeNull();
    // No per-turn button anywhere in the mode.
    expect(c.querySelectorAll("[data-tabletop-talk]")).toHaveLength(0);
    expect(c.querySelector('[data-interpreter-engine="openai-translate"]')!.getAttribute("aria-pressed")).toBe("true");
    // …and back again.
    await act(async () => {
      fireEvent.click(c.querySelector("[data-interpreter-back]")!);
    });
    expect(c.querySelector("[data-interpreter]")).toBeNull();
    expect(c.querySelectorAll("[data-tabletop-talk]")).toHaveLength(2);
  });
});

// ── the mode ───────────────────────────────────────────────────────────────

describe("Interpreter mode", () => {
  it("one tap starts a continuous session on the table's pair; the same button becomes Stop", async () => {
    const { container } = await mountMode();
    expect(toggle(container).textContent).toContain("Start interpreter");
    await tapStart(container);
    expect(fake.sessions).toHaveLength(1);
    expect(fake.sessions[0]).toMatchObject({ engine: "openai-realtime", mine: "en", theirs: "es" });
    expect(toggle(container).textContent).toContain("Stop");
    expect(toggle(container).getAttribute("aria-pressed")).toBe("true");
    // Both ends are told it is listening — each in its own language.
    const far = container.querySelector('[data-interpreter-pane="far"]')!;
    const near = container.querySelector('[data-interpreter-pane="near"]')!;
    expect(far.textContent).toContain("Escuchando a los dos");
    expect(near.textContent).toContain("Listening to both of you");
    // The far pane is turned to face the person across the table.
    expect(cls(far)).toMatch(/\brotate-180\b/);
    expect(cls(near)).not.toMatch(/\brotate-180\b/);
  });

  it("shows captions of both sides, oldest first, each pane in its reader's language", async () => {
    const { container } = await mountMode();
    await tapStart(container);
    const h = fake.sessions[0].handlers;
    await act(async () => {
      h.onCaption({ id: "0:a", source: "en", target: "es", heard: "How was your day?", said: "¿Cómo estuvo tu día?", live: false, at: 1 });
      h.onCaption({ id: "1:b", source: "es", target: "en", heard: "Más o menos.", said: "So-so.", live: false, at: 2 });
      h.onCaption({ id: "0:c", source: "en", target: "es", heard: "Dinner tomorrow?", said: "¿Cenamos mañana?", live: true, at: 3 });
    });
    const lines = (which: string) =>
      Array.from(container.querySelectorAll(`[data-interpreter-pane="${which}"] [data-caption]`)).map(
        (el) => `${el.getAttribute("data-caption")}:${(el.textContent ?? "").replace("▍", "")}`
      );
    // The Spanish reader (far): the other person's words interpreted, their own as heard.
    expect(lines("far")).toEqual([
      "incoming:¿Cómo estuvo tu día?",
      "outgoing:Más o menos.",
      "incoming:¿Cenamos mañana?"
    ]);
    expect(lines("near")).toEqual(["outgoing:How was your day?", "incoming:So-so.", "outgoing:Dinner tomorrow?"]);
    // An update lands in place; nothing is re-ordered or moved to the top.
    await act(async () => {
      h.onCaption({ id: "0:a", source: "en", target: "es", heard: "How was your day, love?", said: "¿Cómo estuvo tu día, amor?", live: false, at: 1 });
    });
    expect(lines("far")[0]).toBe("incoming:¿Cómo estuvo tu día, amor?");
    expect(lines("far")).toHaveLength(3);
  });

  it("keeps #101: each feed is a follow-the-tail box that scrolls to the line being written", async () => {
    const { container } = await mountMode();
    await tapStart(container);
    const feeds = Array.from(container.querySelectorAll<HTMLElement>("[data-interpreter-feed]"));
    expect(feeds).toHaveLength(2);
    for (const feed of feeds) {
      expect(cls(feed)).toContain("overflow-y-auto");
      expect(cls(feed)).toContain("[overflow-anchor:none]");
      Object.defineProperty(feed, "scrollHeight", { configurable: true, value: 900 });
      Object.defineProperty(feed, "clientHeight", { configurable: true, value: 300 });
      feed.scrollTop = 0;
    }
    await act(async () => {
      fake.sessions[0].handlers.onCaption({ id: "0:a", source: "en", target: "es", heard: "Hi", said: "Hola", live: true, at: 1 });
    });
    for (const feed of feeds) expect(feed.scrollTop).toBe(900);
    expect(container.querySelector("[data-jump-to-tail]")).toBeNull();
  });

  it("keeps #117: Stop is in the middle strip, outside both scroll boxes, on a page that does not scroll", async () => {
    const { container } = await mountMode();
    await tapStart(container);
    const main = container.querySelector("[data-interpreter]")!;
    expect(cls(main)).toContain("h-[100dvh]");
    expect(cls(main)).toContain("overflow-hidden");
    const strip = container.querySelector("[data-interpreter-controls]")!;
    expect(strip.contains(toggle(container))).toBe(true);
    expect(toggle(container).closest("[data-interpreter-feed]")).toBeNull();
    expect(cls(strip)).not.toMatch(/overflow-y-(auto|scroll)/);
    // The strip sits BETWEEN the two panes, like the table's own.
    const kids = Array.from(main.children);
    expect(kids.indexOf(strip)).toBe(1);
    expect(kids[0].getAttribute("data-interpreter-pane")).toBe("far");
    expect(kids[2].getAttribute("data-interpreter-pane")).toBe("near");
    // A BIG Stop.
    expect(cls(toggle(container))).toMatch(/\bpy-5\b/);
    expect(cls(toggle(container))).toMatch(/\btext-xl\b/);
    // The one way out is still on the screen.
    expect(container.querySelector("[data-exit-home]")).not.toBeNull();
  });

  it("Stop ends the session and posts one line of numbers — no text", async () => {
    const { container } = await mountMode();
    await tapStart(container);
    await act(async () => {
      fake.sessions[0].handlers.onCaption({ id: "0:a", source: "en", target: "es", heard: "SECRET-HEARD", said: "SECRET-SAID", live: true, at: 1 });
    });
    await act(async () => {
      fireEvent.click(toggle(container));
    });
    await act(async () => {});
    expect(fake.stop).toHaveBeenCalledTimes(1);
    expect(toggle(container).textContent).toContain("Start interpreter");
    const posts = usagePosts();
    expect(posts).toHaveLength(1);
    const body = posts[0].body!;
    expect(body).toMatchObject({ engine: "openai-realtime", stop: "user", legs: 2, barge_ins: 1, audio_out_tokens: 900 });
    for (const [key, value] of Object.entries(body)) {
      if (key === "engine" || key === "stop" || key === "style") continue;
      expect(typeof value, key).toBe("number");
    }
    expect(JSON.stringify(posted)).not.toContain("SECRET");
    // The captions stay on screen after Stop, settled.
    expect(container.textContent).toContain("SECRET-SAID");
  });

  it("stops by itself after a quiet minute", async () => {
    vi.useFakeTimers();
    const { container } = await mountMode();
    await tapStart(container);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    // Somebody spoke at 0:40 — the minute starts again.
    fake.sessions[0].handlers.onActivity();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    expect(fake.stop).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_000);
    });
    expect(fake.stop).toHaveBeenCalledTimes(1);
    expect(usagePosts().map((p) => p.body!.stop)).toEqual(["idle"]);
    expect(container.querySelector("[data-interpreter-notice]")!.textContent).toContain("quiet minute");
    expect(toggle(container).textContent).toContain("Start interpreter");
  });

  it("stops at the session cap even while people are talking", async () => {
    vi.useFakeTimers();
    fake.maxSeconds = 120;
    const { container } = await mountMode();
    await tapStart(container);
    const talk = window.setInterval(() => fake.sessions[0].handlers.onActivity(), 10_000);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(118_000);
    });
    expect(fake.stop).not.toHaveBeenCalled();
    expect(container.querySelector("[data-interpreter-status]")!.textContent).toContain("/ 2:00");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    window.clearInterval(talk);
    expect(fake.stop).toHaveBeenCalledTimes(1);
    expect(usagePosts().map((p) => p.body!.stop)).toEqual(["cap"]);
    expect(container.querySelector("[data-interpreter-notice]")!.textContent).toContain("2 min");
  });

  it("a lost connection ends the session and says so", async () => {
    const { container } = await mountMode();
    await tapStart(container);
    await act(async () => {
      fake.sessions[0].handlers.onLegLost();
    });
    await act(async () => {});
    expect(fake.stop).toHaveBeenCalledTimes(1);
    expect(usagePosts().map((p) => p.body!.stop)).toEqual(["error"]);
    expect(container.querySelector("[data-interpreter-notice]")!.textContent).toContain("lost its connection");
  });

  it("leaving the screen hangs up: a hands-free mic never outlives its page", async () => {
    const { container, unmount } = await mountMode();
    await tapStart(container);
    unmount();
    await act(async () => {});
    expect(fake.stop).toHaveBeenCalledTimes(1);
    expect(usagePosts().map((p) => p.body!.stop)).toEqual(["left"]);
  });

  it("a failed start shows the reason and leaves the button ready", async () => {
    fake.fail = "Gemini is not configured on this deployment.";
    const { container } = await mountMode();
    await tapStart(container);
    expect(container.querySelector("[data-interpreter-error]")!.textContent).toContain("not configured");
    expect(toggle(container).textContent).toContain("Start interpreter");
    expect(toggle(container).disabled).toBe(false);
  });
});

describe("the founder engine picker", () => {
  it("offers all six engines and remembers the choice on this device", async () => {
    const { container } = await mountMode();
    const chips = Array.from(container.querySelectorAll("[data-interpreter-engine]"));
    expect(chips.map((c) => c.getAttribute("data-interpreter-engine"))).toEqual([
      "openai-realtime",
      "openai-live",
      "openai-translate",
      "gemini-live",
      "grok-voice",
      "elevenlabs-realtime"
    ]);
    expect(container.querySelector('[data-interpreter-engine="openai-realtime"]')!.getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      fireEvent.click(container.querySelector('[data-interpreter-engine="gemini-live"]')!);
    });
    expect(window.localStorage.getItem(ENGINE_STORAGE_KEY)).toBe("gemini-live");
    await tapStart(container);
    expect(fake.sessions[0].engine).toBe("gemini-live");
    // The picker is put away while a session runs — an engine cannot change under a sentence.
    expect(container.querySelectorAll("[data-interpreter-engine]")).toHaveLength(0);
  });

  it("the stored choice beats the deployment default on the next visit", async () => {
    window.localStorage.setItem(ENGINE_STORAGE_KEY, "openai-live");
    const { container } = await mountMode({ defaultEngine: "openai-translate" });
    expect(container.querySelector('[data-interpreter-engine="openai-live"]')!.getAttribute("aria-pressed")).toBe("true");
    await tapStart(container);
    expect(fake.sessions[0].engine).toBe("openai-live");
  });

  it("says so when the chosen engine cannot be briefed", async () => {
    const { container } = await mountMode();
    expect(container.querySelector("[data-interpreter-unbriefed]")).toBeNull();
    await act(async () => {
      fireEvent.click(container.querySelector('[data-interpreter-engine="openai-translate"]')!);
    });
    expect(container.querySelector("[data-interpreter-unbriefed]")!.textContent).toContain("cannot be briefed");
    fake.briefing = { applied: false, contextChars: 0, contextStatus: "ok" };
    await tapStart(container);
    expect(container.querySelector("[data-interpreter-unbriefed]")).not.toBeNull();
  });
});

describe("the experimental Mediator flag", () => {
  it("is absent by default and always starts the plain interpreter", async () => {
    window.localStorage.setItem(STYLE_STORAGE_KEY, "mediator");
    const { container } = await mountMode();
    await act(async () => {
      fireEvent.click(container.querySelector("[data-interpreter-context-open]")!);
    });
    expect(container.querySelector("[data-interpreter-style]")).toBeNull();
    await act(async () => {
      fireEvent.click(container.querySelector("[data-interpreter-context] button")!);
    });
    await tapStart(container);
    expect(fake.sessions[0].style).toBe("interpreter");
  });

  it("appears only when enabled, remembers an explicit choice, and starts Mediator", async () => {
    const { container } = await mountMode({ mediatorEnabled: true });
    await act(async () => {
      fireEvent.click(container.querySelector("[data-interpreter-context-open]")!);
    });
    const option = container.querySelector<HTMLButtonElement>('[data-interpreter-style-option="mediator"]')!;
    expect(option).not.toBeNull();
    await act(async () => {
      fireEvent.click(option);
    });
    expect(window.localStorage.getItem(STYLE_STORAGE_KEY)).toBe("mediator");
    await act(async () => {
      fireEvent.click(container.querySelector("[data-interpreter-context] button")!);
    });
    await tapStart(container);
    expect(fake.sessions[0].style).toBe("mediator");
  });
});

describe("the context edit box", () => {
  it("loads the block from the server, saves it back, and keeps none of it in the browser's storage", async () => {
    contextOnServer.context = "CONTEXT-FROM-DB";
    const { container } = await mountMode();
    expect(container.querySelector("[data-interpreter-context]")).toBeNull();
    await act(async () => {
      fireEvent.click(container.querySelector("[data-interpreter-context-open]")!);
    });
    await act(async () => {});
    const box = container.querySelector<HTMLTextAreaElement>("[data-interpreter-context] textarea")!;
    expect(box.value).toBe("CONTEXT-FROM-DB");
    await act(async () => {
      fireEvent.change(box, { target: { value: "CONTEXT-EDITED" } });
    });
    await act(async () => {
      fireEvent.click(container.querySelector("[data-interpreter-context-save]")!);
    });
    await act(async () => {});
    const put = posted.find((p) => p.method === "PUT")!;
    expect(put.url).toBe("/api/tabletop/interpreter/context");
    expect(put.body).toEqual({ context: "CONTEXT-EDITED" });
    expect(container.querySelector("[data-interpreter-context]")!.textContent).toContain("Saved");
    expect(JSON.stringify({ ...window.localStorage })).not.toContain("CONTEXT");
  });

  it("tells a founder the truth when the table has not been created yet", async () => {
    contextOnServer.status = "missing_table";
    const { container } = await mountMode();
    await act(async () => {
      fireEvent.click(container.querySelector("[data-interpreter-context-open]")!);
    });
    await act(async () => {});
    expect(container.querySelector("[data-interpreter-context-missing]")!.textContent).toContain("has not been created");
    await act(async () => {
      fireEvent.click(container.querySelector("[data-interpreter-context-save]")!);
    });
    await act(async () => {});
    expect(container.querySelector("[data-interpreter-context]")!.textContent).toContain("Could not save");
  });
});

describe("the phone owner's language", () => {
  it("writes the whole strip in Spanish on Liz's phone, from the copy table", async () => {
    const { container } = await mountMode({ mine: "es", theirs: "en" });
    expect(toggle(container).textContent).toContain("Iniciar intérprete");
    const strip = container.querySelector("[data-interpreter-controls]")!;
    expect(strip.textContent).toContain("Volver a la mesa");
    expect(strip.textContent).toContain("Motor");
    expect(strip.textContent).toContain("Lo que sabe el intérprete");
    await tapStart(container);
    expect(toggle(container).textContent).toContain("Detener");
  });

  it("every Spanish interpreter string is in the copy table and marked for Liz", async () => {
    const { copyFor } = await import("@/lib/chrome/copy");
    const { readFileSync } = await import("node:fs");
    const en = copyFor("en");
    const es = copyFor("es");
    // This mode's keys (/call has older `interpreter…` keys of its own).
    const keys = [
      "interpreterMode",
      "interpreterStart",
      "interpreterStop",
      "interpreterHint",
      "interpreterListening",
      "interpreterBackToTable",
      "interpreterEngine",
      "interpreterContext",
      "interpreterContextHint",
      "interpreterContextSave",
      "interpreterContextSaved",
      "interpreterContextSaveFailed",
      "interpreterContextMissing",
      "interpreterContextNotUsed",
      "interpreterEndedCap",
      "interpreterEndedIdle",
      "interpreterEndedError"
    ] as const;
    for (const k of keys) expect(es[k], k).not.toBe(en[k]);
    const src = readFileSync("lib/chrome/copy.ts", "utf8");
    const block = src.slice(src.indexOf("    interpreterMode:"), src.indexOf("    interpreterEndedError:") + 200);
    const valueLines = block.split("\n").filter((l) => /^\s+(interpreter\w+: )?".*",?( \/\/.*)?$/.test(l) && l.includes('"'));
    expect(valueLines.length).toBeGreaterThanOrEqual(keys.length);
    for (const line of valueLines) expect(line).toContain("pendiente de revisión por Liz");
    // The screen itself declares no words of its own.
    const screen = readFileSync("components/tabletop/InterpreterMode.tsx", "utf8");
    expect(screen).toContain('from "@/lib/chrome/copy"');
    expect(screen).not.toMatch(/Start interpreter|Iniciar int/);
  });
});
