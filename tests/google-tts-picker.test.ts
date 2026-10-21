// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

vi.mock("@/lib/supabase", () => ({
  getMonthlyUsage: async () => ({ translations: 0, tutorSeconds: 0 }),
  getTier: () => "premium",
  isSubscriber: () => true,
  saveTranslation: async () => {},
  translationsLeft: () => Infinity,
  listHistory: async () => [],
  deleteHistoryItem: async () => {},
  clearHistory: async () => {},
  startCheckout: async () => {},
  startPackCheckout: async () => {}
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

afterEach(() => cleanup());

async function mount(email: string, googleTtsEnabled: boolean) {
  const { TranslatorShell } = await import("@/components/TranslatorShell");
  const { DevicePairProvider } = await import("@/lib/translate/useLanguagePair");
  render(
    createElement(
      DevicePairProvider,
      { pair: ["en", "es"] },
      createElement(TranslatorShell, {
        email,
        profile: null,
        onSignOut: () => {},
        googleTtsEnabled
      })
    )
  );
}

describe("the founder-only Google engine picker", () => {
  it("shows Google to a founder when the flag is on", async () => {
    await mount("xdrabbit@gmail.com", true);
    expect(screen.getByRole("button", { name: "Google" })).toBeTruthy();
  });

  it("does not show Google to a founder while the flag is off", async () => {
    await mount("xdrabbit@gmail.com", false);
    expect(screen.queryByRole("button", { name: "Google" })).toBeNull();
  });

  it("does not show Google to a non-founder even when the flag is on", async () => {
    await mount("guest@example.com", true);
    expect(screen.queryByRole("button", { name: "Google" })).toBeNull();
  });
});
