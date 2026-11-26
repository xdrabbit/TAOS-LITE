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
