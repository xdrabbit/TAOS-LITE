// @vitest-environment jsdom
// /taokie's invite link, after the first production session (Tom + Liz,
// 2026-11-02, iPhone + Android): "when either founder sends the other the
// invite and the partner taps it, the code is NOT filled in."
//
// The cause, from the code and the auth audit: the link was /taokie?room=,
// and both founders signed in fresh on the phone that opened it. Google
// sign-in bounces through Supabase, which comes back to the PATH the app
// handed it (lib/authRedirect.ts refuses a query on purpose) with its own
// ?code= appended — so ?room= was gone before the lobby rendered. Now the
// link is /taokie/<code>: the gate carries that path through sign-in, and a
// room that came from a link goes on air by itself. No typing.
//
// These mount the real screen (gate + shell) with a sign-in that can be
// flipped, and walk all three arrivals: the path link, the old ?room= link,
// and the sign-in bounce.
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAIR_STORAGE_KEY } from "@/lib/translate/pair";

type Listener = (event: string, session: unknown) => void;
const rig = vi.hoisted(() => ({
  session: null as null | { access_token: string; user: { id: string; email: string } },
  listeners: [] as Array<(event: string, session: unknown) => void>,
  signInProps: [] as Array<Record<string, unknown>>,
  joins: [] as Array<{ room: string; name: string }>,
  channel: {
    setHolding: vi.fn(),
    setLanguage: vi.fn(),
    sendReady: vi.fn(),
    sendGot: vi.fn(),
    sendPlayed: vi.fn(),
    resync: vi.fn(() => true),
    isJoined: vi.fn(() => true),
    leave: vi.fn(async () => {})
  }
}));

const TOM = { access_token: "t", user: { id: "u-tom", email: "xdrabbit@gmail.com" } };

vi.mock("next/navigation", () => ({
  usePathname: () => "/taokie",
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams()
}));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: rig.session } }),
      onAuthStateChange: (cb: Listener) => {
        rig.listeners.push(cb);
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
      refreshSession: async () => ({ data: { session: rig.session } })
    },
    getChannels: () => [],
    removeChannel: async () => {}
  }
}));
vi.mock("@/lib/authClient", () => ({
  jsonAuthHeaders: async () => ({ "Content-Type": "application/json" }),
  authHeaders: async () => ({})
}));
vi.mock("@/components/SignIn", () => ({
  SignIn: (props: Record<string, unknown>) => {
    rig.signInProps.push(props);
    return createElement(
      "button",
      {
        "data-test-google": "",
        onClick: () => {
          // What the real button does, from the app's side: leave for
          // Google, come back to redirectPath with ?code= appended, and let
          // supabase-js turn that into a session + an auth event.
          window.history.replaceState(null, "", `${String(props.redirectPath)}?code=oauth-pkce-code`);
          rig.session = TOM;
          for (const cb of rig.listeners) cb("SIGNED_IN", TOM);
        }
      },
      "Continue with Google"
    );
  }
}));
vi.mock("@/lib/walkie/chirps", () => ({
  createWalkieChirps: () => ({ unlock: async () => true, keyDown: () => {}, roger: () => {}, busy: () => {}, close: () => {} })
}));
vi.mock("@/lib/walkie/channel", () => ({
  joinWalkieChannel: async (c: { room: string; name: string }) => {
    rig.joins.push({ room: c.room, name: c.name });
    return rig.channel;
  }
}));
vi.mock("@/lib/wakeLock", () => ({ keepWake: () => () => {} }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  rig.session = null;
  rig.listeners.length = 0;
  rig.signInProps.length = 0;
  rig.joins.length = 0;
  process.env.TAOS_WALKIE_ENABLED = "1";
  window.localStorage.clear();
  window.localStorage.setItem(PAIR_STORAGE_KEY, JSON.stringify(["en", "es"]));
  vi.stubGlobal(
    "Audio",
    class {
      playsInline = false;
      src = "";
      play = async () => {};
      pause = () => {};
    }
  );
  Object.defineProperty(window, "matchMedia", { writable: true, value: () => ({ matches: false }) });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/api/walkie/messages")) return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      if (u.includes("/api/walkie/settings")) return new Response(JSON.stringify({ notifyText: true }), { status: 200 });
      return new Response("{}", { status: 200 });
    })
  );
  window.HTMLElement.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete process.env.TAOS_WALKIE_ENABLED;
  window.history.replaceState(null, "", "/");
});

async function mountScreen(pathRoom?: string): Promise<HTMLElement> {
  const { TaokieScreen } = await import("@/components/walkie/TaokieScreen");
  const { container } = render(createElement(TaokieScreen, { room: pathRoom }));
  await act(async () => {
    await sleep(30);
  });
  return container;
}

describe("the invite link lands the partner IN the channel", () => {
  it("the shared link is /taokie/<code>, and the on-air address is the same", async () => {
    const { walkiePath, roomFromLocation } = await import("@/components/walkie/WalkieShell");
    expect(walkiePath("ABCDE")).toBe("/taokie/ABCDE");
    expect(walkiePath("")).toBe("/taokie");
    expect(roomFromLocation("/taokie/ABCDE", "")).toBe("ABCDE");
    expect(roomFromLocation("/taokie/abcde/", "?code=oauth")).toBe("ABCDE"); // the bounce's ?code= is not a room
    expect(roomFromLocation("/taokie", "?room=ABCDE")).toBe("ABCDE"); // the old link still works
    expect(roomFromLocation("/taokie", "?room=ABCDE1")).toBe(""); // 1 is not in the alphabet
    expect(roomFromLocation("/taokie/ABCDE", "?room=ZZZZZ")).toBe("ABCDE"); // the path wins
    expect(roomFromLocation("/taokie", "")).toBe("");
    const { walkieRedirectPath, roomParam } = await import("@/components/walkie/TaokieScreen");
    expect(walkieRedirectPath("ABCDE")).toBe("/taokie/ABCDE");
    expect(roomParam("abcde")).toBe("ABCDE");
    expect(roomParam("../etc")).toBe("");
    expect(roomParam(undefined)).toBe("");
  });

  it("sign-in is allowed to come back to the invite path, and never to a query", async () => {
    const { authRedirectTarget } = await import("@/lib/authRedirect");
    expect(authRedirectTarget("https://taoslite.com", "/taokie/ABCDE")).toBe("https://taoslite.com/taokie/ABCDE");
    expect(authRedirectTarget("https://taoslite.com", "/taokie?room=ABCDE")).toBe("https://taoslite.com/");
  });

  it("path link, already signed in: joined, no typing, and the speaker asks for one tap", async () => {
    rig.session = TOM;
    window.history.replaceState(null, "", "/taokie/ABCDE");
    const c = await mountScreen("ABCDE");
    expect(rig.joins).toEqual([{ room: "ABCDE", name: "xdrabbit" }]);
    expect(c.querySelector("[data-walkie-hold]")).not.toBeNull();
    expect(c.querySelector("#walkie-room")).toBeNull(); // the lobby is gone: on air
    expect(c.querySelector("[data-walkie-error]")).toBeNull();
    expect(c.querySelector("[data-walkie-sound-off]")).not.toBeNull();
    await act(async () => {
      fireEvent.pointerDown(c.querySelector("main") as HTMLElement, { pointerId: 1, button: 0 });
    });
    expect(c.querySelector("[data-walkie-sound-off]")).toBeNull();
    expect(window.location.pathname).toBe("/taokie/ABCDE");
  });

  it("the old ?room= link, already signed in: joined the same way", async () => {
    rig.session = TOM;
    window.history.replaceState(null, "", "/taokie?room=abcde");
    const c = await mountScreen();
    expect(rig.joins).toEqual([{ room: "ABCDE", name: "xdrabbit" }]);
    expect(c.querySelector("[data-walkie-hold]")).not.toBeNull();
    expect(window.location.pathname).toBe("/taokie/ABCDE");
  });

  it("the sign-in bounce: link → Google → back on the invite path with ?code= → joined", async () => {
    window.history.replaceState(null, "", "/taokie/ABCDE");
    const c = await mountScreen("ABCDE");
    // Signed out: the gate, not the lobby.
    expect(rig.joins).toHaveLength(0);
    expect(c.textContent).toMatch(/sign in/i);
    await act(async () => {
      fireEvent.click(Array.from(c.querySelectorAll("button")).find((b) => /sign in/i.test(b.textContent ?? "")) as HTMLElement);
    });
    // The sign-in was told to come back to the INVITE, code and all.
    expect(rig.signInProps.at(-1)?.redirectPath).toBe("/taokie/ABCDE");
    await act(async () => {
      fireEvent.click(c.querySelector("[data-test-google]") as HTMLElement);
      await sleep(30);
    });
    expect(window.location.pathname).toBe("/taokie/ABCDE");
    expect(rig.joins).toEqual([{ room: "ABCDE", name: "xdrabbit" }]);
    expect(c.querySelector("[data-walkie-hold]")).not.toBeNull();
  });

  it("a path that is not one of ours is the plain lobby, not a join", async () => {
    rig.session = TOM;
    window.history.replaceState(null, "", "/taokie/not-a-room-code-at-all");
    const c = await mountScreen("not-a-room-code-at-all");
    expect(rig.joins).toHaveLength(0);
    expect(c.querySelector("#walkie-room")).not.toBeNull();
    expect((c.querySelector("#walkie-room") as HTMLInputElement).value).toBe("");
  });

  it("leaving the channel takes the code out of the address, so a reload does not rejoin", async () => {
    rig.session = TOM;
    window.history.replaceState(null, "", "/taokie/ABCDE");
    const c = await mountScreen("ABCDE");
    expect(rig.joins).toHaveLength(1);
    await act(async () => {
      fireEvent.click(Array.from(c.querySelectorAll("button")).find((b) => /leave channel/i.test(b.textContent ?? "")) as HTMLElement);
      await sleep(20);
    });
    expect(window.location.pathname).toBe("/taokie");
    expect(c.querySelector("#walkie-room")).not.toBeNull();
    expect(rig.joins).toHaveLength(1); // and not joined again
  });
});
