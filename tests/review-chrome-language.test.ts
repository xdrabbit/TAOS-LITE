// @vitest-environment jsdom
//
// /review reads in the phone owner's language — Spanish for Liz.
//
// #118 shipped the review screen with its words in lib/chrome/copy.ts, but
// its gate still greeted a Spanish phone with "Inicia sesión · Sign in", the
// count line was English glued to a number, and the language under each
// column ("Heard · English") came from the catalog's ENGLISH name. Tom asked
// on 2026-11-04 for the page to follow the same rule as every other screen:
// one language, the owner's, keyed on `mine` from the stored pair.
//
// This file mounts the REAL shell and the REAL gate — not the table — on a
// Spanish phone and on an English one, and asserts each shows none of the
// other's chrome. Every review key in the table is checked, so a key added
// to English and forgotten in Spanish fails here, not on Liz's phone.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import type { Session } from "@supabase/supabase-js";
import { PAIR_STORAGE_KEY } from "@/lib/translate/pair";
import type { LanguageCode } from "@/lib/languages/catalog";
import { ENGLISH, copyFor, fill, type ChromeKey } from "@/lib/chrome/copy";

vi.mock("next/navigation", () => ({ usePathname: () => "/review", useRouter: () => ({ replace: () => {} }) }));

vi.mock("@/lib/authClient", () => ({
  jsonAuthHeaders: async () => ({ "Content-Type": "application/json" }),
  authHeaders: async () => ({})
}));

/** What the gate's session read answers; null is signed out. */
let currentSession: Session | null = null;
vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: currentSession } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } })
    }
  }
}));

/** One kept turn: Tom said something in English, it came out in Spanish. */
const TURN = {
  id: "r1",
  user_id: "tom-id",
  surface: "home",
  mode: "pair",
  source_lang: "en",
  target_lang: "es",
  original_text: "xyzzy one",
  translation_text: "xyzzy dos",
  transcribe_model: "gpt-4o-transcribe",
  translate_model: "gpt-4.1",
  rec_ms: 2100,
  timings: { transcribe_ms: 800, translate_ms: 600, tts_ms: 400, total_ms: 1900 },
  created_at: "2026-11-04T17:30:00.000Z",
  expires_at: "2026-11-18T17:30:00.000Z",
  flag_reason: null,
  flag_note: null,
  audio_url: "https://signed.example/r1"
};

function answer(url: string): Response {
  const body = url.includes("/api/review/settings")
    ? { keepAudio: false }
    : { turns: [TURN], speakers: [{ id: "tom-id", email: "tom@example.com" }], retentionDays: 14 };
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  window.localStorage.clear();
  currentSession = null;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => answer(String(input))));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mountShell(pair: [LanguageCode, LanguageCode]) {
  window.localStorage.setItem(PAIR_STORAGE_KEY, JSON.stringify(pair));
  const { ReviewShell } = await import("@/components/review/ReviewShell");
  const { DevicePairProvider } = await import("@/lib/translate/useLanguagePair");
  render(createElement(DevicePairProvider, { pair }, createElement(ReviewShell, { retentionDays: 14 })));
  await act(async () => {});
  await act(async () => {});
}

async function mountGate(pair: [LanguageCode, LanguageCode]) {
  window.localStorage.setItem(PAIR_STORAGE_KEY, JSON.stringify(pair));
  const { ReviewGate } = await import("@/components/review/ReviewGate");
  const { DevicePairProvider } = await import("@/lib/translate/useLanguagePair");
  render(createElement(DevicePairProvider, { pair }, createElement(ReviewGate, null, createElement("div", null, "inside"))));
  await act(async () => {});
}

/** Every word a reader or a screen reader can meet: text, placeholders, aria-labels. */
function everything(): string {
  const attrs = Array.from(document.querySelectorAll("[title],[aria-label],[placeholder]")).flatMap((el) => [
    el.getAttribute("title") ?? "",
    el.getAttribute("aria-label") ?? "",
    el.getAttribute("placeholder") ?? ""
  ]);
  return [document.body.textContent ?? "", ...attrs].join("\n");
}

/** Every review key the table declares, found from the table — not a hand list. */
const REVIEW_KEYS = (Object.keys(ENGLISH) as ChromeKey[]).filter((k) => /^(review|navReview)/.test(k));

/** A key's text as the screen would print it, slots filled the way the shell fills them. */
function printed(copy: Record<ChromeKey, string>, key: ChromeKey): string {
  return fill(copy[key], { days: 14, count: 1, flagged: 0 });
}

const PHONES = [
  { owner: "es", other: "en", pair: ["es", "en"] as [LanguageCode, LanguageCode], heard: "Inglés", translated: "Español" },
  { owner: "en", other: "es", pair: ["en", "es"] as [LanguageCode, LanguageCode], heard: "English", translated: "Spanish" }
] as const;

describe("the copy table carries the whole screen in Spanish", () => {
  it("every review key has its own Spanish, different from the English", () => {
    expect(REVIEW_KEYS.length).toBeGreaterThan(30);
    const es = copyFor("es");
    for (const key of REVIEW_KEYS) expect(es[key], key).not.toBe(ENGLISH[key]);
  });

  it("the four flag buttons wrap to a second row on a narrow phone rather than truncate", async () => {
    // Tom's rule (2026-11-04): short enough for one row on a 375px phone if
    // they can be, and two rows if they can't — never cut off. At text-sm
    // with 12px of padding a side and 8px gaps, four labels of ~11-13
    // characters come to ~400px, so on a 375 they go two-and-two in BOTH
    // languages; that is the wrap below doing its job. The cap keeps a
    // future label from pushing them to three rows.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("components/review/ReviewShell.tsx", "utf8");
    const group = src.slice(src.indexOf('aria-label={s.reviewFlag}'), src.indexOf("reasonLabel[reason]"));
    expect(src.slice(src.lastIndexOf("<div", src.indexOf('aria-label={s.reviewFlag}')), src.indexOf('aria-label={s.reviewFlag}'))).toContain("flex-wrap");
    expect(group).not.toMatch(/truncate|overflow-hidden|whitespace-nowrap|text-ellipsis/);
    for (const code of ["en", "es"]) {
      const c = copyFor(code);
      for (const key of ["reviewFlagWords", "reviewFlagMeaning", "reviewFlagTone", "reviewFlagOther"] as const) {
        expect(c[key].length, `${code}.${key}`).toBeLessThanOrEqual(14);
      }
    }
  });
});

for (const phone of PHONES) {
  const mine = copyFor(phone.owner);
  const theirs = copyFor(phone.other);

  describe(`a ${phone.owner} phone (${phone.pair.join("⇄")})`, () => {
    it("writes the review screen in its own language and none of the other's", async () => {
      await mountShell(phone.pair);
      const all = everything();
      // The turn is on the page — the mount really loaded.
      expect(all).toContain("xyzzy one");
      // Its own words, where the screen shows them in this state.
      for (const key of [
        "reviewTitle",
        "reviewTagline",
        "reviewKeepAudio",
        "reviewKeepAudioHint",
        "reviewKeepAudioOff",
        "reviewDay",
        "reviewAllDays",
        "reviewSpeaker",
        "reviewAllSpeakers",
        "reviewFlaggedOnly",
        "reviewHeard",
        "reviewTranslated",
        "reviewModels",
        "reviewTiming",
        "reviewTimingTotal",
        "reviewFlagWords",
        "reviewFlagMeaning",
        "reviewFlagTone",
        "reviewFlagOther",
        "reviewFlagNote",
        "reviewRefresh",
        "reviewExport",
        "reviewExportHint",
        "reviewCount"
      ] as const) {
        expect(all, `${phone.owner}.${key}`).toContain(printed(mine, key));
      }
      // None of the other language's, for any review key at all.
      for (const key of REVIEW_KEYS) {
        expect(all, `${phone.owner} phone shows ${phone.other}.${key}`).not.toContain(printed(theirs, key));
      }
      // The language under each column is named in the owner's language too.
      expect(all).toContain(`${mine.reviewHeard} · ${phone.heard}`);
      expect(all).toContain(`${mine.reviewTranslated} · ${phone.translated}`);
      // The old glued count line is gone in both languages.
      expect(all).not.toMatch(/\d+ · (flagged|marcada) \d+/);
    });

    it("shows the empty state in its own language", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) =>
          String(input).includes("/api/review/settings")
            ? answer(String(input))
            : new Response(JSON.stringify({ turns: [], speakers: [], retentionDays: 14 }), { status: 200 })
        )
      );
      await mountShell(phone.pair);
      const all = everything();
      expect(all).toContain(mine.reviewNothing);
      expect(all).not.toContain(theirs.reviewNothing);
    });

    it("greets a signed-out visitor in its own language, with no doubled card", async () => {
      await mountGate(phone.pair);
      const all = everything();
      expect(all).toContain(mine.reviewSignIn);
      expect(all).toContain(mine.reviewSignInHint);
      expect(all).not.toContain(theirs.reviewSignIn);
      expect(all).not.toContain(theirs.reviewSignInHint);
      expect(all).not.toContain("inside");
      expect(all).not.toContain(" · ");
    });

    it("tells a signed-in stranger 'not found' in its own language", async () => {
      currentSession = { user: { email: "stranger@example.com" }, access_token: "tok" } as unknown as Session;
      await mountGate(phone.pair);
      const all = everything();
      expect(all).toContain(`404 · ${mine.reviewNotFound}`);
      expect(all).toContain(mine.reviewBackHome);
      expect(all).not.toContain(theirs.reviewNotFound);
      expect(all).not.toContain(theirs.reviewBackHome);
      expect(all).not.toContain("inside");
    });
  });
}

describe("the gate reads the same language the shell does", () => {
  it("both take `mine` from useLanguagePair and their words from the shared table", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of ["components/review/ReviewGate.tsx", "components/review/ReviewShell.tsx"]) {
      const src = readFileSync(file, "utf8");
      expect(src, file).toContain('from "@/lib/chrome/copy"');
      expect(src, file).toContain("useLanguagePair()");
      // No English-with-a-Spanish-tail literals left in either (the comments
      // may name the old one; the code may not).
      const code = src
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      expect(code, file).not.toMatch(/·\s*(Sign in|Volver|No encontrado)/);
    }
  });
});
