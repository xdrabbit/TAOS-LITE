// What a tap on "Install" should DO on this browser. Pure, so the branching is
// testable without a phone: components/InstallPrompt.tsx reads the browser and
// asks here.
//
// Why this exists: until 2026-11-25 the handler was `if (!deferred) return;` —
// a tap with no stashed `beforeinstallprompt` did nothing at all, and an
// iPhone (which never fires that event, in any browser: they are all WebKit)
// got no button, only a five-word hint. Every branch below ends in something
// the person can see.

export type InstallAction =
  /** Running from the Home Screen already: nothing to offer. */
  | "installed"
  /** Chromium handed us an install prompt: replay it from the tap. */
  | "prompt"
  /** iOS Safari: Share → Add to Home Screen. Show the steps. */
  | "ios-safari"
  /**
   * iOS, but not Safari (Chrome, Firefox, an in-app browser). Newer Chrome has
   * Add to Home Screen under Share too; in-app browsers do not. Same steps,
   * plus "not there? open it in Safari".
   */
  | "ios-other"
  /** Anything else with no prompt to replay: point at the browser's menu. */
  | "generic";

export interface InstallEnvironment {
  standalone: boolean;
  userAgent: string;
  maxTouchPoints: number;
  hasPrompt: boolean;
}

/** iPadOS 13+ claims to be a Mac; the touch points give it away. */
export function isIosUserAgent(userAgent: string, maxTouchPoints: number): boolean {
  return /iphone|ipad|ipod/i.test(userAgent) || (/macintosh/i.test(userAgent) && maxTouchPoints > 1);
}

// Browsers and in-app webviews that are NOT Safari on iOS but mostly carry its
// tokens. Chrome, Firefox, Edge, Opera, the Google app, DuckDuckGo, Brave
// announce themselves; so do the social apps' built-in browsers.
const IOS_NOT_SAFARI =
  /CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|GSA\/|DuckDuckGo|YaBrowser|Brave|FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|WhatsApp|Snapchat|LinkedInApp|Twitter|TikTok|musical_ly|Pinterest/i;

/**
 * Real Safari on iOS. It sends both `Version/x` and `Safari/x`; a bare
 * WKWebView (most in-app browsers) sends neither, so an unnamed webview is
 * treated as "not Safari" and gets the open-it-in-Safari line.
 */
export function isIosSafariUserAgent(userAgent: string): boolean {
  if (IOS_NOT_SAFARI.test(userAgent)) return false;
  return /Version\/[\d.]+/.test(userAgent) && /Safari\//.test(userAgent);
}

export function installAction(env: InstallEnvironment): InstallAction {
  if (env.standalone) return "installed";
  // iOS first: no iOS browser fires beforeinstallprompt, so a "prompt" there
  // could only be a test double or a lie.
  if (isIosUserAgent(env.userAgent, env.maxTouchPoints)) {
    return isIosSafariUserAgent(env.userAgent) ? "ios-safari" : "ios-other";
  }
  return env.hasPrompt ? "prompt" : "generic";
}

// ── Where Share actually is ───────────────────────────────────────────────
// Liz, 2026-11-25, on the first version of the sheet: "Tap Share" does not
// help if you cannot find Share. So the sheet points at it, and that needs to
// know where it is:
//
// - iPhone, Safari 26 and later: the default "Compact" bar shows only Back,
//   the address and a ••• button at the bottom RIGHT. Share is a row inside
//   •••. (Settings → Apps → Safari → Tabs can switch to "Bottom" or "Top",
//   which keep Share in the bottom toolbar; a page cannot tell which is set,
//   so the first card also shows the Share icon as the alternative.)
// - iPhone, Safari 18 and earlier: Share is in the bottom toolbar, CENTER.
// - iPad: Share is in the toolbar at the TOP, towards the right.
//
// The version comes from `Version/x`, not from `OS x_y`: Safari 26 freezes
// the OS token at 18_x (WebKit bug 298260), so `OS` reads 18 on iOS 26.
export interface ShareGuide {
  device: "iphone" | "ipad";
  /** Share is behind the ••• button: tap that first. */
  viaMore: boolean;
}

export function safariMajorVersion(userAgent: string): number | null {
  const m = /Version\/(\d+)/.exec(userAgent);
  return m ? Number(m[1]) : null;
}

export function iosShareGuide(userAgent: string): ShareGuide {
  // An iPad says "iPad" or, since iPadOS 13, pretends to be a Mac. Only call
  // this for a UA already known to be iOS (isIosUserAgent).
  if (!/iphone|ipod/i.test(userAgent)) return { device: "ipad", viaMore: false };
  const major = safariMajorVersion(userAgent);
  return { device: "iphone", viaMore: major !== null && major >= 26 };
}
