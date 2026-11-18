// @vitest-environment jsdom
//
// "Remind me every day" on the screen, and the email's source marker.
//
//   · the toggle is NOT DRAWN unless the server says the feature is available
//     for this person — no disabled switch, no placeholder;
//   · it starts OFF, and turning it on sends the browser's own time zone and
//     the person's own language;
//   · ?src=daily-email survives a sign-in bounce that drops the query string,
//     is counted once, and is taken off the URL.
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DailyReminder } from "@/components/DailyReminder";
import { rememberEmailSource, takeEmailSource } from "@/lib/email/client";
import { EMAIL_COPY } from "@/lib/email/copy";

let signedIn = true;
vi.mock("@/lib/authClient", () => ({
  jsonAuthHeaders: async () => ({ "Content-Type": "application/json", ...(signedIn ? { Authorization: "Bearer t" } : {}) }),
  authHeaders: async () => ({})
}));

type Prefs = { optedIn: boolean; hour: number; timeZone: string; paused: boolean; bounced: boolean };
let server: { available: boolean; prefs: Prefs };
let posts: Array<Record<string, unknown>> = [];

beforeEach(() => {
  signedIn = true;
  posts = [];
  server = { available: true, prefs: { optedIn: false, hour: 8, timeZone: "", paused: false, bounced: false } };
  window.sessionStorage.clear();
  window.history.replaceState({}, "", "/study");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      if (body.action === "set" && server.available) {
        if (typeof body.optedIn === "boolean") server.prefs.optedIn = body.optedIn;
        if (typeof body.hour === "number") server.prefs.hour = body.hour;
      }
      return new Response(JSON.stringify(server.available ? server : { available: false }), { status: 200 });
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mount(lang = "en", dest: "study" | "tutor" = "study") {
  const view = render(createElement(DailyReminder, { dest, lang }));
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
  return view;
}

describe("the toggle", () => {
  it("draws nothing at all when the server says it is not available", async () => {
    server.available = false;
    const { container } = await mount();
    expect(container.innerHTML).toBe("");
    expect(posts).toEqual([{ action: "visit", dest: "study" }]);
  });

  it("draws nothing for a signed-out visitor, and asks the server nothing", async () => {
    signedIn = false;
    const { container } = await mount();
    expect(container.innerHTML).toBe("");
    expect(posts).toEqual([]);
  });

  it("starts OFF, with no hour picker", async () => {
    const { container, getByLabelText } = await mount();
    const box = getByLabelText(EMAIL_COPY.en.toggle) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(container.querySelector("select")).toBeNull();
    expect(container.textContent).toContain(EMAIL_COPY.en.toggleHint);
  });

  it("turning it on sends the browser's time zone, the default hour and the person's language", async () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const { container, getByLabelText } = await mount("es", "tutor");
    const box = getByLabelText(EMAIL_COPY.es.toggle) as HTMLInputElement;
    await act(async () => {
      fireEvent.click(box);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(posts[0]).toEqual({ action: "visit", dest: "tutor" });
    expect(posts[1]).toEqual({ action: "set", optedIn: true, hour: 8, timeZone: zone, lang: "es" });
    expect(zone).toBeTruthy();
    expect((getByLabelText(EMAIL_COPY.es.toggle) as HTMLInputElement).checked).toBe(true);

    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("8");
    expect(select.options).toHaveLength(24);
    await act(async () => {
      fireEvent.change(select, { target: { value: "7" } });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(posts[2]).toMatchObject({ action: "set", hour: 7 });
    expect(posts[2]).not.toHaveProperty("optedIn");
  });

  it("a bounced address shows why it is off and cannot be switched on", async () => {
    server.prefs.bounced = true;
    const { container, getByLabelText } = await mount();
    expect((getByLabelText(EMAIL_COPY.en.toggle) as HTMLInputElement).disabled).toBe(true);
    expect(container.textContent).toContain(EMAIL_COPY.en.toggleBounced);
  });

  it("both screens mount it, and only on their landing views", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("components/StudyShell.tsx", "utf8")).toContain('<DailyReminder dest="study" lang={explain} />');
    const modules = readFileSync("components/tutor/ModulesShell.tsx", "utf8");
    expect(modules.match(/<DailyReminder /g)).toHaveLength(1);
    expect(modules).toContain('<DailyReminder dest="tutor" lang={mine} />');
  });
});

describe("the source marker", () => {
  it("is kept through a sign-in that drops the query, sent once, and removed from the URL", async () => {
    window.history.replaceState({}, "", "/study?src=daily-email&lesson=abc#top");
    rememberEmailSource();
    expect(window.location.search).toBe("?lesson=abc"); // other params are not ours to remove
    expect(window.location.hash).toBe("#top");

    // The Google bounce: back on the bare path, query gone.
    window.history.replaceState({}, "", "/study");
    rememberEmailSource();

    await mount();
    expect(posts).toEqual([{ action: "visit", dest: "study", src: "daily-email" }]);
    expect(takeEmailSource()).toBeNull();

    // A reload does not count a second open.
    cleanup();
    posts = [];
    await mount();
    expect(posts).toEqual([{ action: "visit", dest: "study" }]);
  });

  it("ignores any other src value", () => {
    window.history.replaceState({}, "", "/tutor?src=newsletter");
    rememberEmailSource();
    expect(window.location.search).toBe("?src=newsletter");
    expect(takeEmailSource()).toBeNull();
  });

  it("both shells remember it BEFORE the sign-in gate", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of ["components/StudyShell.tsx", "components/TutorShell.tsx"]) {
      const src = readFileSync(file, "utf8");
      const remember = src.indexOf("useEffect(rememberEmailSource, [])");
      expect(remember, file).toBeGreaterThan(-1);
      expect(remember).toBeLessThan(src.indexOf("<SignIn"));
    }
  });
});
