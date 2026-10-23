// @vitest-environment jsdom
// One obvious way out, on every screen but home.
//
// Tom, 2026-10-23: "a couple of screens are hard to figure out how to get out
// of — Table is one. Every screen needs the same color, different from the
// rest of the screen, that your eyes go to, that says this is how to get out."
//
// So every screen MOUNTS here, signed in, and must show exactly one
// <ExitHome/> — the same green pill, labelled in the phone owner's language
// from lib/chrome/copy.ts — first in its header row. Home shows none: it IS
// home. A new screen added under app/ without a row below fails the
// "every route is covered" test on the day it lands.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { act, cleanup, render } from "@testing-library/react";
import { createElement, type ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyFor } from "@/lib/chrome/copy";
import { PAIR_STORAGE_KEY } from "@/lib/translate/pair";

vi.mock("next/navigation", () => ({
  usePathname: () => "/x",
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams()
}));

// Signed in, with an empty database: every query resolves to no rows.
vi.mock("@/lib/supabase", async () => {
  const actual = await vi.importActual<typeof import("@/lib/supabase")>("@/lib/supabase");
  const session = { access_token: "t", user: { id: "u1", email: "test@example.com" } };
  const empty = { data: [], error: null, count: 0 };
  const query: unknown = new Proxy(() => {}, {
    get: (_t, key) =>
      key === "then" ? (resolve: (v: unknown) => void) => resolve(empty) : () => query,
    apply: () => query
  });
  const channel: unknown = new Proxy(() => {}, {
    get: () => () => channel,
    apply: () => channel
  });
  return {
    ...actual,
    getProfile: async () => null,
    getMonthlyUsage: async () => ({ translations: 0, tutorSeconds: 0 }),
    listHistory: async () => [],
    listStudyLessons: async () => [],
    supabase: {
      auth: {
        getSession: async () => ({ data: { session } }),
        getUser: async () => ({ data: { user: session.user } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
        signOut: async () => {}
      },
      from: () => query,
      rpc: () => query,
      channel: () => channel,
      removeChannel: () => {},
      storage: { from: () => query }
    }
  };
});

vi.mock("@/lib/authClient", () => ({
  jsonAuthHeaders: async () => ({ "Content-Type": "application/json" }),
  authHeaders: async () => ({})
}));

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }))
  );
  window.HTMLElement.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Loader = () => Promise<ComponentType>;

/** Every route under app/ that is a screen, and what it mounts. */
const SCREENS: Record<string, Loader> = {
  live: async () => (await import("@/components/LiveShell")).LiveShell,
  chat: async () => (await import("@/components/ChatShell")).ChatShell,
  tabletop: async () => (await import("@/components/TabletopShell")).TabletopShell,
  translate: async () => (await import("@/components/TranslateShell")).TranslateShell,
  vision: async () => (await import("@/components/VisionShell")).VisionShell,
  video: async () => (await import("@/components/VideoShell")).VideoShell,
  fast: async () => (await import("@/components/FastShell")).FastShell,
  call: async () => (await import("@/components/CallShell")).CallShell,
  study: async () => (await import("@/components/StudyShell")).StudyShell,
  tutor: async () => (await import("@/components/TutorShell")).TutorShell,
  try: async () => (await import("@/components/AtomShell")).AtomShell,
  about: async () => (await import("@/app/about/page")).default,
  guide: async () => (await import("@/app/guide/page")).default,
  "love-in-translation": async () => (await import("@/app/love-in-translation/page")).default
};

/**
 * Routes that are not a screen of their own: the invite link is a one-card
 * hand-off that sends you straight into /chat, and api/ is not a page.
 */
const NOT_A_SCREEN = new Set(["api", "chat/join/[token]"]);

function pageRoutes(dir = "app", prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = `${dir}/${name}`;
    if (!statSync(path).isDirectory()) continue;
    const route = prefix ? `${prefix}/${name}` : name;
    if (NOT_A_SCREEN.has(route)) continue;
    if (readdirSync(path).includes("page.tsx")) out.push(route);
    out.push(...pageRoutes(path, route));
  }
  return out;
}

async function mount(load: Loader, mine: string): Promise<HTMLElement> {
  window.localStorage.setItem(PAIR_STORAGE_KEY, JSON.stringify([mine, mine === "en" ? "es" : "en"]));
  const Screen = await load();
  const { container } = render(createElement(Screen));
  // Sessions and the stored pair both arrive in effects.
  await act(async () => {});
  await act(async () => {});
  return container;
}

describe("every screen but home has one green way out", () => {
  it("every route under app/ is covered", () => {
    expect(pageRoutes().sort()).toEqual(Object.keys(SCREENS).sort());
  });

  for (const [route, load] of Object.entries(SCREENS)) {
    for (const mine of ["en", "es"]) {
      it(`/${route} (${mine}): exactly one, labelled ${JSON.stringify(copyFor(mine).home)}`, async () => {
        const container = await mount(load, mine);
        const exits = container.querySelectorAll("[data-exit-home]");
        expect(exits).toHaveLength(1);
        const exit = exits[0] as HTMLAnchorElement;
        expect(exit.textContent).toBe(copyFor(mine).home);
        expect(exit.getAttribute("href")).toBe("/");
        // The same green as TAP TO TALK, solid, dark text — not a variant.
        expect(exit.className).toContain("bg-emerald-400");
        expect(exit.className).toContain("text-stone-950");
        expect(exit.className).toContain("min-h-[44px]");
      });
    }
  }

  it("top-left: the first thing in the header row", async () => {
    for (const [route, load] of Object.entries(SCREENS)) {
      if (route === "tabletop") continue;
      const container = await mount(load, "en");
      const exit = container.querySelector("[data-exit-home]")!;
      const header = exit.closest("header");
      expect(header, route).not.toBeNull();
      // First element in the header, or first in the header's first group.
      let first: Element | null = header!.firstElementChild;
      while (first && first !== exit && first.contains(exit)) first = first.firstElementChild;
      expect(first, route).toBe(exit);
      cleanup();
    }
  });

  it("/tabletop: first in the shared middle strip, not in either pane", async () => {
    const container = await mount(SCREENS.tabletop, "en");
    const strip = container.querySelector("[data-tabletop-controls]")!;
    expect(strip.firstElementChild?.hasAttribute("data-exit-home")).toBe(true);
  });

  it("home shows none", () => {
    for (const file of ["components/AppShell.tsx", "components/TranslatorShell.tsx", "components/Landing.tsx"]) {
      expect(readFileSync(file, "utf8")).not.toContain("ExitHome");
    }
  });

  it("no screen keeps its old dim exit alongside the new one", () => {
    const files = [
      ...readdirSync("components").filter((f) => f.endsWith("Shell.tsx")).map((f) => `components/${f}`),
      "app/about/page.tsx",
      "app/guide/page.tsx",
      "app/love-in-translation/page.tsx"
    ];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const old of ["← Home", "← TAOS", "← Translator", "Back to TAOS · Volver\">", "← Back to TAOS"]) {
        expect(src, `${file}: ${old}`).not.toContain(old);
      }
    }
  });
});
