// @vitest-environment jsdom
//
// /live/saved on the screen — the two things Copilot's review of #137 found
// that tests/live-saved.test.ts (the routes) cannot see from the server side:
//
//   · the list is paged, and "Show older" walks it to the end, so the 201st
//     conversation can be opened and deleted like the first;
//   · a conversation the server could not hand over whole is SAID to be
//     partial, with both numbers, and one that is whole says nothing.
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENGLISH, copyFor, fill } from "@/lib/chrome/copy";
import { PAIR_STORAGE_KEY } from "@/lib/translate/pair";

vi.mock("next/navigation", () => ({
  usePathname: () => "/live/saved",
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams()
}));
vi.mock("@/lib/authClient", () => ({
  jsonAuthHeaders: async () => ({ "Content-Type": "application/json" }),
  authHeaders: async () => ({})
}));

const PAGE = 50;
const idOf = (n: number) => `cccccccc-cccc-4ccc-8ccc-${String(n).padStart(12, "0")}`;
const session = (n: number) => ({
  id: idOf(n),
  lang_mine: "en",
  lang_theirs: "es",
  style: "verbatim",
  auto: true,
  started_at: new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString(),
  ended_at: new Date(Date.UTC(2026, 10, 1, 0, n + 1)).toISOString(),
  line_count: n
});
const line = (seq: number) => ({
  seq,
  heard_text: `oído ${seq}`,
  heard_lang: "es",
  translation: `heard ${seq}`,
  translation_lang: "en",
  detect: "hit",
  created_at: ""
});

/** Newest first, as the server keeps them. */
let stored: ReturnType<typeof session>[] = [];
let listCalls: string[] = [];
let oneAnswer: (id: string) => unknown = () => null;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(PAIR_STORAGE_KEY, JSON.stringify(["en", "es"]));
  listCalls = [];
  stored = [];
  oneAnswer = () => null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: { method?: string }) => {
      const u = new URL(String(url), "http://localhost");
      if (u.pathname === "/api/live/saved") {
        listCalls.push(u.search);
        const offset = Number(u.searchParams.get("offset") ?? "0");
        const rows = stored.slice(offset, offset + PAGE);
        return json({ ready: true, canSave: true, sessions: rows, more: offset + PAGE < stored.length });
      }
      const id = u.pathname.split("/").pop()!;
      if (init?.method === "DELETE") {
        stored = stored.filter((s) => s.id !== id);
        return json({ deleted: true });
      }
      const body = oneAnswer(id);
      return body ? json(body) : json({ error: "Not found." }, 404);
    })
  );
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount(): Promise<HTMLElement> {
  const { SavedLiveShell } = await import("@/components/live/SavedLiveShell");
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(createElement(SavedLiveShell)));
  });
  await act(async () => {});
  return container;
}
async function tap(el: Element) {
  await act(async () => {
    fireEvent.click(el);
  });
  await act(async () => {});
}
const rows = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLButtonElement>("[data-saved-list] button"));
const moreButton = (c: HTMLElement) => c.querySelector<HTMLButtonElement>("[data-saved-more]");

describe("/live/saved: the list goes all the way back", () => {
  it("201 saved: a page at a time, and Show older reaches the oldest — which then opens and deletes", async () => {
    stored = Array.from({ length: 201 }, (_, i) => session(201 - i));
    const c = await mount();
    expect(rows(c)).toHaveLength(50);
    expect(moreButton(c)!.textContent).toBe(ENGLISH.liveSavedMore);

    let taps = 0;
    while (moreButton(c)) {
      await tap(moreButton(c)!);
      taps += 1;
      expect(taps).toBeLessThan(10);
    }
    expect(taps).toBe(4);
    expect(listCalls).toEqual(["", "?offset=50", "?offset=100", "?offset=150", "?offset=200"]);
    expect(rows(c)).toHaveLength(201);

    // The oldest is the last row. Open it, delete it.
    oneAnswer = (id) => ({ session: stored.find((s) => s.id === id), lines: [line(1)], total: 1, complete: true });
    await tap(rows(c)[200]);
    expect(c.querySelector("[data-saved-open]")).not.toBeNull();
    expect(c.querySelectorAll("[data-saved-line]")).toHaveLength(1);
    const del = Array.from(c.querySelectorAll("button")).find((b) => b.textContent === ENGLISH.liveSavedDelete)!;
    await tap(del);
    expect(stored.map((s) => s.id)).not.toContain(idOf(1));
    expect(rows(c)).toHaveLength(200);
  });

  it("no button when one page is all there is", async () => {
    stored = [session(2), session(1)];
    const c = await mount();
    expect(rows(c)).toHaveLength(2);
    expect(moreButton(c)).toBeNull();
  });

  it("a conversation saved in the meantime shifts the pages by one: no row is shown twice", async () => {
    stored = Array.from({ length: 60 }, (_, i) => session(60 - i));
    const c = await mount();
    stored = [session(61), ...stored]; // saved from another phone
    await tap(moreButton(c)!);
    const ids = rows(c).length;
    // 50 on screen + the 11 from offset 50, one of which (#11) was already shown.
    expect(ids).toBe(60);
    expect(moreButton(c)).toBeNull();
  });

  it("the button is in the owner's language", async () => {
    window.localStorage.setItem(PAIR_STORAGE_KEY, JSON.stringify(["es", "en"]));
    stored = Array.from({ length: 51 }, (_, i) => session(51 - i));
    const c = await mount();
    expect(moreButton(c)!.textContent).toBe(copyFor("es").liveSavedMore);
  });
});

describe("/live/saved: a conversation is whole, or the screen says it is not", () => {
  beforeEach(() => {
    stored = [session(1)];
  });

  it("whole: every line, and no notice", async () => {
    oneAnswer = () => ({
      session: stored[0],
      lines: Array.from({ length: 2345 }, (_, i) => line(i + 1)),
      total: 2345,
      complete: true
    });
    const c = await mount();
    await tap(rows(c)[0]);
    expect(c.querySelectorAll("[data-saved-line]")).toHaveLength(2345);
    expect(c.querySelector("[data-saved-partial]")).toBeNull();
  });

  it("partial: says how many of how many", async () => {
    oneAnswer = () => ({ session: stored[0], lines: [line(1), line(2)], total: 9, complete: false });
    const c = await mount();
    await tap(rows(c)[0]);
    expect(c.querySelector("[data-saved-partial]")!.textContent).toBe(
      fill(ENGLISH.liveSavedPartial, { shown: 2, total: 9 })
    );
  });

  it("does not take the server's word for `complete` when the numbers disagree", async () => {
    oneAnswer = () => ({ session: stored[0], lines: [line(1)], total: 4, complete: true });
    const c = await mount();
    await tap(rows(c)[0]);
    expect(c.querySelector("[data-saved-partial]")!.textContent).toBe(
      fill(ENGLISH.liveSavedPartial, { shown: 1, total: 4 })
    );
  });
});
