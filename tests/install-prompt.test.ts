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
//   * iPhone / iPad, Safari       → a picture guide: Share → Add to Home Screen
//   * iPhone / iPad, anything else → "open it in Safari" + a Copy link button
//   * already on the Home Screen  → no banner
//   * no prompt to replay         → a sheet pointing at the browser's menu
//
// Liz, the same day, on the first sheet: she did not like the Install button,
// and "Tap Share" is no help if you cannot find Share. Decided: the guide
// DRAWS each button and points at where the first one is —
//   * iPhone, Safari 26+  → ••• at the bottom right, then Share inside it
//                           (the Share drawing is offered too: the Bottom and
//                           Top layouts keep it in the bar, and a page cannot
//                           tell which layout is set)
//   * iPhone, Safari ≤ 18 → Share, bottom center
//   * iPad                → Share, top right
// Version comes from `Version/x`; Safari 26 freezes `OS` at 18_x.
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InstallPrompt } from "@/components/InstallPrompt";
import { copyFor } from "@/lib/chrome/copy";
import {
  installAction,
  iosShareGuide,
  isIosSafariUserAgent,
  isIosUserAgent,
  safariMajorVersion
} from "@/lib/install/action";

const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  // Safari 26 on iOS 26: the OS token is frozen at 18_x, Version/ tells the truth.
  iphoneSafari26:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  iphoneSafari27:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.1 Mobile/15E148 Safari/604.1",
  ipadSafari26:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  ipadOld:
    "Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1",
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

describe("iosShareGuide — where the first button to tap is", () => {
  it("reads the Safari version from Version/, not from the frozen OS token", () => {
    expect(safariMajorVersion(UA.iphoneSafari26)).toBe(26); // OS says 18_6
    expect(safariMajorVersion(UA.iphoneSafari)).toBe(18);
    expect(safariMajorVersion(UA.iphoneChrome)).toBeNull();
  });

  it("sends Safari 26 and later through the ••• button", () => {
    expect(iosShareGuide(UA.iphoneSafari26)).toEqual({ device: "iphone", viaMore: true });
    expect(iosShareGuide(UA.iphoneSafari27)).toEqual({ device: "iphone", viaMore: true });
  });

  it("sends Safari 18 and earlier straight to Share", () => {
    expect(iosShareGuide(UA.iphoneSafari)).toEqual({ device: "iphone", viaMore: false });
  });

  it("knows an iPad, named or in its Mac disguise, at any version", () => {
    for (const ua of [UA.ipadSafari, UA.ipadSafari26, UA.ipadOld]) {
      expect(iosShareGuide(ua), ua).toEqual({ device: "ipad", viaMore: false });
    }
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

    const stepsOf = (sheet: HTMLElement) =>
      Array.from(sheet.querySelectorAll("[data-install-step]")).map((li) => li.getAttribute("data-install-step"));
    const pointerOf = (sheet: HTMLElement) =>
      sheet.querySelector("[data-install-pointer]")?.getAttribute("data-install-pointer") ?? null;

    it("names the banner after the app, with its icon, and offers to show the way", () => {
      const { container } = mount(UA.iphoneSafari26);
      expect(screen.getByText(copy.installTitle)).toBeTruthy();
      expect(container.querySelector('img[src="/icons/icon-192.png"]')).toBeTruthy();
      expect(screen.getByRole("button", { name: copy.installShowMe })).toBeTruthy();
      // Dismissible, and nothing opens until asked.
      expect(screen.getByRole("button", { name: copy.installDismiss })).toBeTruthy();
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("on Safari 26+, points bottom right at ••• and draws ••• → Share → Add to Home Screen → Add", () => {
      mount(UA.iphoneSafari26);
      fireEvent.click(screen.getByRole("button", { name: copy.installShowMe }));

      const sheet = screen.getByRole("dialog", { name: copy.installSheetTitle });
      expect(sheet.getAttribute("data-install-sheet")).toBe("ios-safari");
      expect(stepsOf(sheet)).toEqual(["more", "share", "add-square", "add-word"]);
      expect(pointerOf(sheet)).toBe("bottom-right");
      expect(sheet.textContent).toContain(copy.installPointerDown);
      for (const text of [
        copy.installStepMore,
        copy.installStepShare,
        copy.installStepAdd,
        copy.installStepAddHint, // "scroll down if you don't see it"
        copy.installStepConfirm
      ]) {
        expect(sheet.textContent).toContain(text);
      }
      // Both paths: the Bottom/Top layouts show Share in the bar, so the •••
      // card also draws the Share icon as the thing to tap instead.
      const first = sheet.querySelector('[data-install-step="more"]')!;
      expect(first.textContent).toContain(copy.installStepMoreHint);
      expect(first.querySelector('[data-install-icon="share"]')).toBeTruthy();
      // A drawing on every card, and none of them an emoji.
      for (const li of Array.from(sheet.querySelectorAll("[data-install-step]"))) {
        expect(li.querySelector("[data-install-icon]"), li.textContent ?? "").toBeTruthy();
      }
      expect(sheet.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
      // Safari can do it; it is not sent to Safari.
      expect(sheet.textContent).not.toContain(copy.installStepOpenSafari);
      // One language, end to end.
      expect(sheet.textContent).not.toContain(other.installStepAdd);
    });

    it("on Safari 18 and earlier, points bottom center straight at Share", () => {
      mount(UA.iphoneSafari);
      fireEvent.click(screen.getByRole("button", { name: copy.installShowMe }));
      const sheet = screen.getByRole("dialog");
      expect(stepsOf(sheet)).toEqual(["share", "add-square", "add-word"]);
      expect(pointerOf(sheet)).toBe("bottom-center");
      expect(sheet.textContent).not.toContain(copy.installStepMore);
    });

    it("on an iPad, points top right at Share, and says what to do if it is not there", () => {
      // The Mac disguise: only the touch points say iPad.
      Object.defineProperty(navigator, "maxTouchPoints", { value: 5, configurable: true });
      onTestFinished(() => {
        delete (navigator as unknown as { maxTouchPoints?: number }).maxTouchPoints;
      });
      mount(UA.ipadSafari26);
      fireEvent.click(screen.getByRole("button", { name: copy.installShowMe }));
      const sheet = screen.getByRole("dialog");
      expect(sheet.getAttribute("data-install-sheet")).toBe("ios-safari");
      expect(stepsOf(sheet)).toEqual(["share", "add-square", "add-word"]);
      expect(pointerOf(sheet)).toBe("top-right");
      expect(sheet.textContent).toContain(copy.installPointerUp);
      expect(sheet.textContent).toContain(copy.installStepShareHint);
    });

    it("keeps every step to six words or fewer", () => {
      for (const key of [
        "installStepMore",
        "installStepShare",
        "installStepAdd",
        "installStepConfirm",
        "installStepCopy",
        "installStepOpenSafari",
        "installStepPaste"
      ] as const) {
        expect(copy[key].split(/\s+/).length, copy[key]).toBeLessThanOrEqual(6);
      }
    });

    it("sends Chrome on an iPhone to Safari, with no arrow at a button it does not have", () => {
      mount(UA.iphoneChrome);
      fireEvent.click(screen.getByRole("button", { name: copy.installShowMe }));
      const sheet = screen.getByRole("dialog", { name: copy.installNotSafariTitle });
      expect(sheet.getAttribute("data-install-sheet")).toBe("ios-other");
      expect(stepsOf(sheet)).toEqual(["copy", "safari", "paste"]);
      expect(pointerOf(sheet)).toBeNull();
      expect(sheet.textContent).toContain(copy.installNotSafariWhy);
    });

    it("copies the link in one tap, and says so", async () => {
      const writeText = vi.fn(async (_text: string) => {});
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      try {
        mount(UA.iphoneInstagram);
        fireEvent.click(screen.getByRole("button", { name: copy.installShowMe }));
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: copy.installCopyLink }));
        });
        // The address they are on — taoslite.com in production.
        expect(writeText).toHaveBeenCalledTimes(1);
        expect(writeText.mock.calls[0][0]).toBe(window.location.origin);
        expect(screen.getByRole("button", { name: copy.installCopied })).toBeTruthy();
      } finally {
        delete (navigator as unknown as { clipboard?: unknown }).clipboard;
      }
    });

    it("shows the address to type when the browser refuses the clipboard", async () => {
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: vi.fn(async () => Promise.reject(new DOMException("denied", "NotAllowedError"))) },
        configurable: true
      });
      try {
        mount(UA.iphoneWebview);
        fireEvent.click(screen.getByRole("button", { name: copy.installShowMe }));
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: copy.installCopyLink }));
        });
        const status = screen.getByRole("status");
        expect(status.textContent).toContain(copy.installCopyFailed);
        expect(status.textContent).toContain(window.location.host);
      } finally {
        delete (navigator as unknown as { clipboard?: unknown }).clipboard;
      }
    });

    it("closes the sheet from Close, and leaves the banner for another try", () => {
      mount(UA.iphoneSafari);
      fireEvent.click(screen.getByRole("button", { name: copy.installShowMe }));
      fireEvent.click(screen.getByRole("button", { name: copy.close }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByRole("button", { name: copy.installShowMe })).toBeTruthy();
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

describe("the Spanish guide", () => {
  it("has its own words for every key, and names both of iOS's menu labels", () => {
    const en = copyFor("en");
    const es = copyFor("es");
    for (const key of [
      "installTitle",
      "installHowIos",
      "installShowMe",
      "installSheetTitle",
      "installPointerDown",
      "installPointerUp",
      "installStepMore",
      "installStepMoreHint",
      "installStepShare",
      "installStepShareHint",
      "installStepAdd",
      "installStepAddHint",
      "installStepConfirm",
      "installStepConfirmHint",
      "installAddWord",
      "installNotSafariTitle",
      "installNotSafariWhy",
      "installStepCopy",
      "installCopyLink",
      "installCopied",
      "installCopyFailed",
      "installStepOpenSafari",
      "installStepPaste",
      "installGeneric"
    ] as const) {
      expect(es[key], key).not.toBe(en[key]);
    }
    // iOS says "Agregar a Inicio" in Latin American Spanish and "Añadir a
    // pantalla de inicio" in Spain's; the step says the first and its hint
    // names the second, so the reader finds theirs.
    expect(es.installStepAdd).toContain("Agregar a Inicio");
    expect(es.installStepAddHint).toContain("Añadir a pantalla de inicio");
  });
});
