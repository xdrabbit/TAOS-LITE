// @vitest-environment jsdom
//
// The Install button must never be a dead click.
//
// Tom, 2026-11-25, on production 1489fcb from his iPhone: "the Install button
// does nothing". The handler was `if (!deferred) return;` — no stashed
// `beforeinstallprompt`, no effect, no message — and iOS never fires that
// event in any browser, so an iPhone got no button at all, only a five-word
// hint. Decided the same day: a tap always ends in something on screen.
//   * a Chromium install prompt   → replay it
//   * iPhone / iPad, Safari       → a sheet: Share → Add to Home Screen
//   * iPhone / iPad, anything else → the same sheet + "open it in Safari"
//   * already on the Home Screen  → no banner
//   * no prompt to replay         → a sheet pointing at the browser's menu
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InstallPrompt } from "@/components/InstallPrompt";
import { copyFor } from "@/lib/chrome/copy";
import { installAction, isIosSafariUserAgent, isIosUserAgent } from "@/lib/install/action";

const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  iphoneChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1",
  iphoneFirefox:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/143.0 Mobile/15E148 Safari/605.1.15",
  iphoneGoogleApp:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/390.0.811331708 Mobile/15E148 Safari/604.1",
  // A bare WKWebView — WhatsApp, Gmail and most in-app browsers look like this.
  iphoneWebview:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  iphoneInstagram:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.30.109",
  // iPadOS Safari claims to be a Mac.
  ipadSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
  desktopFirefox: "Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0"
};

const env = (userAgent: string, over: Partial<Parameters<typeof installAction>[0]> = {}) => ({
  standalone: false,
  userAgent,
  maxTouchPoints: 5,
  hasPrompt: false,
  ...over
});

describe("installAction — what a tap on Install does", () => {
  it("replays the browser's prompt where Chromium offered one", () => {
    expect(installAction(env(UA.androidChrome, { hasPrompt: true }))).toBe("prompt");
  });

  it("walks Share → Add to Home Screen on iPhone Safari", () => {
    expect(installAction(env(UA.iphoneSafari))).toBe("ios-safari");
  });

  it("knows an iPad in its Mac disguise by its touch points", () => {
    expect(installAction(env(UA.ipadSafari))).toBe("ios-safari");
    // The same UA on a real Mac (no touch) is not iOS.
    expect(installAction(env(UA.ipadSafari, { maxTouchPoints: 0 }))).toBe("generic");
  });

  it("adds the open-in-Safari line for every other iOS browser", () => {
    for (const ua of [UA.iphoneChrome, UA.iphoneFirefox, UA.iphoneGoogleApp, UA.iphoneWebview, UA.iphoneInstagram]) {
      expect(installAction(env(ua)), ua).toBe("ios-other");
    }
  });

  it("never trusts a prompt on iOS — no iOS browser fires one", () => {
    expect(installAction(env(UA.iphoneSafari, { hasPrompt: true }))).toBe("ios-safari");
  });

  it("says installed once it runs from the Home Screen, whatever the browser", () => {
    for (const ua of Object.values(UA)) {
      expect(installAction(env(ua, { standalone: true, hasPrompt: true })), ua).toBe("installed");
    }
  });

  it("falls back to generic instructions, never to nothing", () => {
    expect(installAction(env(UA.androidChrome))).toBe("generic");
    expect(installAction(env(UA.desktopFirefox, { maxTouchPoints: 0 }))).toBe("generic");
  });

  it("splits iOS Safari from the rest by what the UA announces", () => {
    expect(isIosUserAgent(UA.iphoneSafari, 5)).toBe(true);
    expect(isIosUserAgent(UA.androidChrome, 5)).toBe(false);
    expect(isIosSafariUserAgent(UA.iphoneSafari)).toBe(true);
    expect(isIosSafariUserAgent(UA.iphoneChrome)).toBe(false);
    expect(isIosSafariUserAgent(UA.iphoneWebview)).toBe(false);
  });
});

for (const lang of ["en", "es"] as const) {
  const copy = copyFor(lang);
  const other = copyFor(lang === "en" ? "es" : "en");

  describe(`the banner on a phone whose owner reads ${lang}`, () => {
    beforeEach(() => {
      window.localStorage.clear();
    });
    afterEach(() => {
      cleanup();
      vi.restoreAllMocks();
    });

    function mount(userAgent?: string) {
      if (userAgent) vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
      return render(createElement(InstallPrompt, { copy }));
    }

    function announceInstallable(prompt: () => Promise<void>) {
      const ev = Object.assign(new Event("beforeinstallprompt"), {
        prompt,
        userChoice: Promise.resolve({ outcome: "accepted" as const })
      });
      return act(async () => {
        window.dispatchEvent(ev);
      });
    }

    it("gives an iPhone an Install button, and the tap opens the Safari steps", () => {
      mount(UA.iphoneSafari);
      expect(screen.queryByRole("dialog")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: copy.install }));

      const sheet = screen.getByRole("dialog", { name: copy.installSheetTitle });
      expect(sheet.getAttribute("data-install-sheet")).toBe("ios-safari");
      for (const step of [copy.installIosStep1, copy.installIosStep2, copy.installIosStep3]) {
        expect(sheet.textContent).toContain(step);
      }
      // Safari can do it; it is not told to go to Safari.
      expect(sheet.textContent).not.toContain(copy.installIosNotSafari);
      // One language, end to end.
      expect(sheet.textContent).not.toContain(other.installIosStep2);
    });

    it("tells Chrome on an iPhone the same steps, and where to go if they are missing", () => {
      mount(UA.iphoneChrome);
      fireEvent.click(screen.getByRole("button", { name: copy.install }));
      const sheet = screen.getByRole("dialog");
      expect(sheet.getAttribute("data-install-sheet")).toBe("ios-other");
      expect(sheet.textContent).toContain(copy.installIosStep2);
      expect(sheet.textContent).toContain(copy.installIosNotSafari);
    });

    it("closes the sheet from Close, and leaves the banner for another try", () => {
      mount(UA.iphoneSafari);
      fireEvent.click(screen.getByRole("button", { name: copy.install }));
      fireEvent.click(screen.getByRole("button", { name: copy.close }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByRole("button", { name: copy.install })).toBeTruthy();
    });

    it("replays Chromium's prompt and shows no sheet", async () => {
      mount();
      const prompt = vi.fn(async () => {});
      await announceInstallable(prompt);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: copy.install }));
      });
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("dialog")).toBeNull();
      // Answered: the banner has said its piece.
      expect(screen.queryByText(copy.installTitle)).toBeNull();
    });

    it("shows generic instructions when the prompt cannot be replayed", async () => {
      mount();
      await announceInstallable(async () => {
        throw new DOMException("already used", "InvalidStateError");
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: copy.install }));
      });
      const sheet = screen.getByRole("dialog");
      expect(sheet.getAttribute("data-install-sheet")).toBe("generic");
      expect(sheet.textContent).toContain(copy.installGeneric);
    });

    it("shows nothing at all once it runs from the Home Screen", () => {
      Object.defineProperty(window.navigator, "standalone", { value: true, configurable: true });
      try {
        const { container } = mount(UA.iphoneSafari);
        expect(container.innerHTML).toBe("");
      } finally {
        delete (window.navigator as Navigator & { standalone?: boolean }).standalone;
      }
    });
  });
}

describe("the Spanish sheet", () => {
  it("has its own words for every new key, and names both of iOS's menu labels", () => {
    const en = copyFor("en");
    const es = copyFor("es");
    for (const key of [
      "installSheetTitle",
      "installIosStep1",
      "installIosStep2",
      "installIosStep3",
      "installIosNotSafari",
      "installGeneric"
    ] as const) {
      expect(es[key], key).not.toBe(en[key]);
    }
    // iOS says "Agregar a Inicio" in Latin American Spanish and "Añadir a
    // pantalla de inicio" in Spain's; the reader should find theirs.
    expect(es.installIosStep2).toContain("Agregar a Inicio");
    expect(es.installIosStep2).toContain("Añadir a pantalla de inicio");
  });
});
