// @vitest-environment jsdom
//
// The paywall reads in ONE language: the phone owner's.
//
// Tom's decision, 2026-10-04. After #83 put home in the owner's language, Liz
// read "Mejorar el plan", tapped it, and landed on a paywall that was English
// from the title down — plan names, features, buttons, the small print. The
// door was Spanish and the room was not, on the one screen where a word she
// cannot read costs money. This file is the fence, in the same shape as
// tests/home-labels-one-language.test.ts: mount the real paywall on an English
// phone and on a Spanish one, in every state it can be in, and assert each
// word is in that phone's language and none of the other's — text, titles and
// aria-labels alike.
//
// What it does NOT translate, on purpose: prices ("$5.99" is "$5.99"), the
// pack buttons ("+100 min · $9.99" — the dot there separates minutes from
// price, not two languages), and "Premium", which is the same word in both.
// Stripe's own pages are not ours; they get the owner's language as a
// `locale`, fenced at the bottom of this file against the real routes.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENGLISH, copyFor, fill, type ChromeKey } from "@/lib/chrome/copy";
import { stripeLocale } from "@/lib/stripeLocale";
import { PAIR_STORAGE_KEY } from "@/lib/translate/pair";
import type { LanguageCode } from "@/lib/languages/catalog";

const h = vi.hoisted(() => ({
  startCheckout: vi.fn(async (_plan: string, _lang?: string) => {}),
  startPackCheckout: vi.fn(async (_pack: string, _lang?: string) => {}),
  sessions: [] as Record<string, unknown>[]
}));

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

vi.mock("@/lib/supabase", () => ({
  startCheckout: h.startCheckout,
  startPackCheckout: h.startPackCheckout,
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) } },
  // What home needs to mount, for the one test that walks in from home.
  getMonthlyUsage: async () => ({ translations: 0, tutorSeconds: 0 }),
  getTier: () => "free",
  isSubscriber: () => false,
  saveTranslation: async () => {},
  translationsLeft: () => 0,
  listHistory: async () => [],
  deleteHistoryItem: async () => {},
  clearHistory: async () => {}
}));

vi.mock("@/lib/authClient", () => ({
  jsonAuthHeaders: async () => ({ "Content-Type": "application/json" }),
  authHeaders: async () => ({})
}));

vi.mock("@/lib/tts/speech", () => ({
  requestSpeech: async () => null,
  isTextOnlyLanguage: () => false,
  TEXT_ONLY_TITLE: "Text only"
}));

vi.mock("@/lib/wakeLock", () => ({ keepWake: () => () => {} }));

// The routes, for the Stripe-locale fence at the bottom.
vi.mock("@/lib/stripe", () => {
  const capture = async (args: Record<string, unknown>) => {
    h.sessions.push(args);
    return { url: "https://checkout.stripe.com/c/pay/test" };
  };
  return {
    stripe: {
      checkout: { sessions: { create: capture } },
      billingPortal: { sessions: { create: capture } },
      customers: { create: async () => ({ id: "cus_test" }) }
    },
    priceForPlan: (plan: string) => `price_${plan}`,
    STRIPE_PACKS: { "100": { price: "price_pack_100", minutes: 100, amount: "$9.99", label: "100" } }
  };
});

vi.mock("@/lib/supabaseAdmin", () => {
  const chain: Record<string, unknown> = {
    maybeSingle: async () => ({
      data: { stripe_customer_id: "cus_test", subscription_status: "active" }
    })
  };
  chain.select = () => chain;
  chain.update = () => chain;
  chain.eq = () => chain;
  return { supabaseAdmin: { from: () => chain } };
});

vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async () => ({ id: "user_1", email: "owner@example.com" })
}));

const TUTOR_FLAG = process.env.NEXT_PUBLIC_ENABLE_TUTOR;

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_ENABLE_TUTOR;
  h.startCheckout.mockReset().mockImplementation(async () => {});
  h.startPackCheckout.mockReset().mockImplementation(async () => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  if (TUTOR_FLAG === undefined) delete process.env.NEXT_PUBLIC_ENABLE_TUTOR;
  else process.env.NEXT_PUBLIC_ENABLE_TUTOR = TUTOR_FLAG;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Tier = "free" | "basic" | "premium";

async function mountPaywall(mine: string, currentTier: Tier) {
  const { Paywall } = await import("@/components/Paywall");
  render(
    createElement(Paywall, {
      email: "owner@example.com",
      mine,
      currentTier,
      onClose: () => {},
      onSignOut: () => {}
    })
  );
  await act(async () => {});
}

/** Every word a reader or a screen reader can meet: text, titles, aria-labels. */
function everything(): string {
  const attrs = Array.from(document.querySelectorAll("[title],[aria-label]")).flatMap((el) => [
    el.getAttribute("title") ?? "",
    el.getAttribute("aria-label") ?? ""
  ]);
  return [document.body.textContent ?? "", ...attrs].join("\n");
}

/** How many plan feature lines carry this text. */
function lines(text: string): number {
  return Array.from(document.querySelectorAll("li")).filter((li) => li.textContent?.includes(text)).length;
}

/** Every word the paywall can print, by key. */
const KEYS: ChromeKey[] = [
  "paywallTitle",
  "paywallFreeNow",
  "paywallFreeWithTutor",
  "paywallOnPlan",
  "paywallBasic",
  "paywallPerMonth",
  "paywallUnlimited",
  "paywallTutorBasic",
  "paywallTutorPremium",
  "paywallDrills",
  "paywallCurrentPlan",
  "paywallOpening",
  "paywallSwitchTo",
  "paywallGet",
  "paywallPacksSoon",
  "paywallPacksSoonBody",
  "paywallMoreMinutes",
  "paywallRollover",
  "paywallManageBilling",
  "paywallSignInAgain",
  "paywallCheckoutFailed",
  "paywallBillingFailed",
  "comingSoon",
  "close",
  "navSignOut"
];

/**
 * The searchable part of a word: a template up to its first slot ("Switch to
 * {plan}" → "Switch to "), so the other language's sentence is caught whatever
 * plan name fills it.
 */
function needle(word: string): string {
  const slot = word.indexOf("{");
  return slot === -1 ? word : word.slice(0, slot);
}

/** The doubled and English-only literals as they were before 2026-10-04. */
const OLD = [
  "Coming soon · Próximamente",
  "Plan minutes reset every month. Pack minutes are yours to keep and roll over.Los minutos"
];

const PHONES = [
  { owner: "en", other: "es", pair: ["en", "es"] as [LanguageCode, LanguageCode] },
  { owner: "es", other: "en", pair: ["es", "en"] as [LanguageCode, LanguageCode] }
] as const;

for (const phone of PHONES) {
  const mine = copyFor(phone.owner);
  const theirs = copyFor(phone.other);

  /** None of the other language's paywall words, anywhere on screen. */
  function expectNoneOfTheirs() {
    const all = everything();
    for (const key of KEYS) {
      expect(all, `${phone.owner} phone shows ${phone.other}.${key}`).not.toContain(needle(theirs[key]));
    }
    for (const old of OLD) expect(all).not.toContain(old);
  }

  describe(`the paywall on a ${phone.owner} phone`, () => {
    it("writes a free account's paywall in its own language only", async () => {
      await mountPaywall(phone.owner, "free");

      expect(screen.getByRole("heading", { name: mine.paywallTitle })).toBeTruthy();
      expect(screen.getByText(mine.paywallFreeNow)).toBeTruthy();
      // Both plans: name, price unchanged, the per-month suffix, every line.
      expect(screen.getByText(mine.paywallBasic)).toBeTruthy();
      expect(screen.getByText("Premium")).toBeTruthy();
      expect(screen.getByText("$5.99")).toBeTruthy();
      expect(screen.getByText("$19.99")).toBeTruthy();
      expect(document.body.textContent).toContain(`$5.99 ${mine.paywallPerMonth}`);
      expect(lines(mine.paywallUnlimited)).toBe(2);
      expect(lines(mine.paywallTutorBasic)).toBe(1);
      expect(lines(mine.paywallTutorPremium)).toBe(1);
      expect(lines(mine.paywallDrills)).toBe(2);
      // The tutor lines are badged while tutor is dark — in this language.
      expect(screen.getAllByText(mine.comingSoon)).toHaveLength(4);
      // The buy buttons, the close button's name and the sign-out link.
      expect(screen.getByRole("button", { name: fill(mine.paywallGet, { plan: mine.paywallBasic }) })).toBeTruthy();
      expect(screen.getByRole("button", { name: fill(mine.paywallGet, { plan: "Premium" }) })).toBeTruthy();
      expect(screen.getByRole("button", { name: mine.close })).toBeTruthy();
      expect(screen.getByRole("button", { name: mine.navSignOut })).toBeTruthy();

      expectNoneOfTheirs();
    });

    it("tells a free account its tutor minutes when tutor is on", async () => {
      process.env.NEXT_PUBLIC_ENABLE_TUTOR = "1";
      await mountPaywall(phone.owner, "free");
      expect(screen.getByText(mine.paywallFreeWithTutor)).toBeTruthy();
      expect(everything()).not.toContain(mine.comingSoon);
      expectNoneOfTheirs();
    });

    it("writes a subscriber's paywall — current plan, switch, packs, billing — in its own language", async () => {
      await mountPaywall(phone.owner, "basic");

      expect(screen.getByText(fill(mine.paywallOnPlan, { plan: mine.paywallBasic }))).toBeTruthy();
      expect(screen.getByRole("button", { name: mine.paywallCurrentPlan })).toBeTruthy();
      expect(screen.getByRole("button", { name: fill(mine.paywallSwitchTo, { plan: "Premium" }) })).toBeTruthy();
      // Tutor dark: the pack block is a promise, badged, with no buy buttons.
      expect(screen.getByText(mine.paywallPacksSoon)).toBeTruthy();
      expect(screen.getByText(mine.paywallPacksSoonBody)).toBeTruthy();
      expect(document.body.textContent).not.toContain("$9.99");
      expect(screen.getByRole("button", { name: mine.paywallManageBilling })).toBeTruthy();

      expectNoneOfTheirs();
    });

    it("writes the live pack offer and its small print once, in its own language", async () => {
      process.env.NEXT_PUBLIC_ENABLE_TUTOR = "1";
      await mountPaywall(phone.owner, "premium");

      expect(screen.getByText(fill(mine.paywallOnPlan, { plan: "Premium" }))).toBeTruthy();
      expect(screen.getByText(mine.paywallMoreMinutes)).toBeTruthy();
      // Prices untouched.
      expect(screen.getByRole("button", { name: "+100 min · $9.99" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "+200 min · $17.99" })).toBeTruthy();
      // The rollover sentence was printed in English AND Spanish, stacked.
      expect(screen.getAllByText(mine.paywallRollover)).toHaveLength(1);

      expectNoneOfTheirs();
    });

    it("says 'opening' in its own language while Stripe loads", async () => {
      h.startCheckout.mockImplementation(() => new Promise(() => {}));
      await mountPaywall(phone.owner, "free");
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: fill(mine.paywallGet, { plan: mine.paywallBasic }) }));
      });
      expect(screen.getByRole("button", { name: mine.paywallOpening })).toBeTruthy();
      expectNoneOfTheirs();
    });

    it("hands Stripe the owner's language, and nothing else changes about the purchase", async () => {
      await mountPaywall(phone.owner, "free");
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: fill(mine.paywallGet, { plan: "Premium" }) }));
      });
      expect(h.startCheckout).toHaveBeenCalledWith("premium", phone.owner);
      cleanup();

      process.env.NEXT_PUBLIC_ENABLE_TUTOR = "1";
      await mountPaywall(phone.owner, "premium");
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "+100 min · $9.99" }));
      });
      expect(h.startPackCheckout).toHaveBeenCalledWith("100", phone.owner);
      cleanup();

      const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 500 }));
      vi.stubGlobal("fetch", fetchMock);
      await mountPaywall(phone.owner, "basic");
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: mine.paywallManageBilling }));
      });
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("/api/stripe/portal");
      expect(JSON.parse(String(init.body))).toEqual({ lang: phone.owner });
    });

    it("reports a failed checkout in its own language, not the server's English", async () => {
      h.startCheckout.mockRejectedValue(new Error("No such price: 'price_basic'"));
      await mountPaywall(phone.owner, "free");
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: fill(mine.paywallGet, { plan: mine.paywallBasic }) }));
      });
      expect(screen.getByText(mine.paywallCheckoutFailed)).toBeTruthy();
      expect(everything()).not.toContain("No such price");
      expectNoneOfTheirs();
    });

    it("asks the reader to sign in again in its own language", async () => {
      h.startCheckout.mockRejectedValue(new Error(ENGLISH.paywallSignInAgain));
      await mountPaywall(phone.owner, "free");
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: fill(mine.paywallGet, { plan: "Premium" }) }));
      });
      expect(screen.getByText(mine.paywallSignInAgain)).toBeTruthy();
      expectNoneOfTheirs();
    });

    it("reports a billing portal that would not open in its own language", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ error: "No billing account yet." }), { status: 400 }))
      );
      await mountPaywall(phone.owner, "premium");
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: mine.paywallManageBilling }));
      });
      expect(screen.getByText(mine.paywallBillingFailed)).toBeTruthy();
      expect(everything()).not.toContain("No billing account yet.");
      expectNoneOfTheirs();
    });

    it("is what the home screen's upgrade button opens, in the same language", async () => {
      // The walk Liz took: home's banner, its "Mejorar el plan" button, and
      // the room behind the door. Home is mounted for real; the trial is used
      // up so the button is there.
      window.localStorage.clear();
      window.localStorage.setItem(PAIR_STORAGE_KEY, JSON.stringify(phone.pair));
      const { TranslatorShell } = await import("@/components/TranslatorShell");
      const { DevicePairProvider } = await import("@/lib/translate/useLanguagePair");
      render(
        createElement(
          DevicePairProvider,
          { pair: phone.pair },
          createElement(TranslatorShell, { email: "owner@example.com", profile: null, onSignOut: () => {} })
        )
      );
      await act(async () => {});
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: mine.upgrade }));
      });
      expect(screen.getByRole("heading", { name: mine.paywallTitle })).toBeTruthy();
      expectNoneOfTheirs();
    });
  });
}

describe("the copy behind it", () => {
  it("has a Spanish word for every paywall key, distinct from the English and never doubled", () => {
    for (const key of KEYS) {
      expect(copyFor("es")[key], key).not.toBe(copyFor("en")[key]);
      expect(copyFor("en")[key], key).not.toContain(" · ");
      expect(copyFor("es")[key], key).not.toContain(" · ");
    }
  });

  it("matches the sentence lib/supabase.ts throws when the session is gone", () => {
    // The paywall recognises "sign in again" by its English text, so the two
    // must stay the same string.
    const src = readFileSync(join(process.cwd(), "lib/supabase.ts"), "utf8");
    expect(src.match(/throw new Error\("([^"]+)"\)/g)?.filter((t) => t.includes("sign in"))).toEqual([
      `throw new Error("${ENGLISH.paywallSignInAgain}")`,
      `throw new Error("${ENGLISH.paywallSignInAgain}")`
    ]);
  });

  it("leaves languages nobody here reads in English, not guessed", () => {
    for (const code of ["bs", "it", "zh", "yue"]) {
      for (const key of KEYS.filter((k) => k.startsWith("paywall"))) {
        expect(copyFor(code)[key], `${code}.${key}`).toBe(ENGLISH[key]);
      }
    }
  });
});

// ── Stripe's own pages ──────────────────────────────────────────────────────
// Checkout and the billing portal are Stripe-hosted. They take a `locale`, and
// that is the whole of what this change does to them.

describe("the Stripe locale", () => {
  it("passes a language Stripe draws straight through", () => {
    expect(stripeLocale("es")).toBe("es");
    expect(stripeLocale("en")).toBe("en");
    expect(stripeLocale("it")).toBe("it");
    expect(stripeLocale("zh")).toBe("zh");
  });

  it("spells the ones Stripe spells differently Stripe's way", () => {
    expect(stripeLocale("yue")).toBe("zh-HK");
    expect(stripeLocale("tl")).toBe("fil");
    expect(stripeLocale("no")).toBe("nb");
  });

  it("falls back to 'auto' — what every session got before — for anything else", () => {
    // A locale Stripe does not know fails the session, so untrusted input
    // must never reach it as-is.
    for (const bad of ["sm", "haw", "", "es-MX", "__proto__", "toString", undefined, null, 42, {}]) {
      expect(stripeLocale(bad), String(bad)).toBe("auto");
    }
  });
});

describe("the routes that open Stripe", () => {
  beforeAll(() => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fence";
  });

  const ROUTES = [
    { path: "/api/stripe/checkout", load: () => import("@/app/api/stripe/checkout/route"), body: { plan: "premium" } },
    { path: "/api/stripe/pack", load: () => import("@/app/api/stripe/pack/route"), body: { pack: "100" } },
    { path: "/api/stripe/portal", load: () => import("@/app/api/stripe/portal/route"), body: {} }
  ];

  async function sessionFor(route: (typeof ROUTES)[number], lang?: unknown) {
    h.sessions.length = 0;
    const { POST } = await route.load();
    const res = await POST(
      new NextRequest(`https://taoslite.com${route.path}`, {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json", origin: "https://taoslite.com" },
        body: JSON.stringify(lang === undefined ? route.body : { ...route.body, lang })
      })
    );
    expect(res.status, route.path).toBe(200);
    return h.sessions.at(-1)!;
  }

  for (const route of ROUTES) {
    it(`${route.path} draws Stripe in the owner's language and changes nothing else`, async () => {
      const es = await sessionFor(route, "es");
      const en = await sessionFor(route, "en");
      const none = await sessionFor(route);
      const junk = await sessionFor(route, "not-a-locale");
      expect(es.locale).toBe("es");
      expect(en.locale).toBe("en");
      expect(none.locale).toBe("auto");
      expect(junk.locale).toBe("auto");
      // Same price, same mode, same customer, same URLs — only the locale moves.
      const { locale: _a, ...esRest } = es;
      const { locale: _b, ...noneRest } = none;
      expect(esRest).toEqual(noneRest);
    });
  }
});
