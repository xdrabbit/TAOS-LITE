// Fences the Google sign-in return address.
//
// Two failures are being held apart here, and they pull in opposite directions:
//
//  1. Too narrow, and you get the 8/18 bug back — signing in on a preview
//     deployment drops you on production, so a tester "reviewing the branch" is
//     reviewing prod and nothing on screen says so.
//  2. Too wide, and the sign-in button becomes an open redirect: hand an
//     attacker's host to Supabase and Google delivers someone's session there.
//     That is strictly worse than the bug being fixed.
//
// So the accept cases below are real hostnames observed on this Vercel project,
// and the reject cases are the string tricks that beat a careless hostname
// check. Adding a deployment host here means adding it to the Supabase
// dashboard too (docs/supabase-auth-redirects.md) — the allow-list in code
// cannot widen what Supabase will accept, only narrow it.
import { describe, expect, it } from "vitest";
import { authRedirectTarget, isAllowedAuthOrigin, PRODUCTION_ORIGIN } from "@/lib/authRedirect";

describe("origins sign-in may return to", () => {
  it("accepts production, with and without www", () => {
    expect(isAllowedAuthOrigin("https://taoslite.com")).toBe(true);
    expect(isAllowedAuthOrigin("https://www.taoslite.com")).toBe(true);
  });

  it("accepts every shape of preview host this project actually produces", () => {
    // Pulled from the Vercel deployment list for `taos-lite` on 8/18: the
    // unique deployment URL, the branch alias, and the truncated-plus-hash
    // alias a long branch name gets. If Vercel ever changes this naming, the
    // symptom is the 8/18 bug returning — start here.
    for (const host of [
      "https://taos-lite-64xtpacuh-xdrabbits-projects.vercel.app",
      "https://taos-lite-git-feat-trip-mode-xdrabbits-projects.vercel.app",
      "https://taos-lite-git-main-xdrabbits-projects.vercel.app",
      "https://taos-lite-git-claude-taoslite-load-fa-c65fb2-xdrabbits-projects.vercel.app",
      "https://taos-lite.vercel.app"
    ]) {
      expect(isAllowedAuthOrigin(host), host).toBe(true);
    }
  });

  it("accepts the dev machine on any port", () => {
    // Google sign-in against localhost was broken by the same missing
    // allow-list entry, which is why nobody caught the preview bug locally.
    expect(isAllowedAuthOrigin("http://localhost:3017")).toBe(true);
    expect(isAllowedAuthOrigin("http://localhost:3000")).toBe(true);
    expect(isAllowedAuthOrigin("http://127.0.0.1:3017")).toBe(true);
  });
});

describe("origins sign-in must refuse", () => {
  it("refuses an unrelated host", () => {
    expect(isAllowedAuthOrigin("https://evil.com")).toBe(false);
  });

  it("refuses a suffix that merely ends in our domain", () => {
    // The classic: `taoslite.com.evil.com` is a host evil.com controls.
    expect(isAllowedAuthOrigin("https://taoslite.com.evil.com")).toBe(false);
    expect(isAllowedAuthOrigin("https://taos-lite-x-xdrabbits-projects.vercel.app.evil.com")).toBe(
      false
    );
  });

  it("refuses a prefix that merely starts with our project name", () => {
    expect(isAllowedAuthOrigin("https://evil-taos-lite-x-xdrabbits-projects.vercel.app")).toBe(
      false
    );
    expect(isAllowedAuthOrigin("https://nottaoslite.com")).toBe(false);
  });

  it("refuses another team's vercel.app project", () => {
    // The scope slug is the whole reason the preview wildcard is safe: anyone
    // can name a Vercel project `taos-lite`, only Tom can deploy into
    // xdrabbits-projects.
    expect(isAllowedAuthOrigin("https://taos-lite-abc123-someone-elses-projects.vercel.app")).toBe(
      false
    );
    expect(isAllowedAuthOrigin("https://evil.vercel.app")).toBe(false);
  });

  it("refuses a subdomain of a preview host", () => {
    expect(isAllowedAuthOrigin("https://a.taos-lite-x-xdrabbits-projects.vercel.app")).toBe(false);
  });

  it("refuses embedded credentials — the host is what follows the @", () => {
    expect(isAllowedAuthOrigin("https://taoslite.com@evil.com")).toBe(false);
    expect(isAllowedAuthOrigin("https://user:pass@taoslite.com")).toBe(false);
  });

  it("refuses anything carrying a path, query or fragment", () => {
    // We only ever pass window.location.origin, so extra parts mean someone is
    // shaping the string — and a path is where `/@evil.com` hides.
    expect(isAllowedAuthOrigin("https://taoslite.com/@evil.com")).toBe(false);
    expect(isAllowedAuthOrigin("https://taoslite.com?next=https://evil.com")).toBe(false);
    expect(isAllowedAuthOrigin("https://taoslite.com#@evil.com")).toBe(false);
  });

  it("refuses a non-https scheme off the dev machine", () => {
    expect(isAllowedAuthOrigin("http://taoslite.com")).toBe(false);
    expect(isAllowedAuthOrigin("javascript:alert(1)")).toBe(false);
    expect(isAllowedAuthOrigin("data:text/html,x")).toBe(false);
  });

  it("refuses a non-default port on a real host", () => {
    expect(isAllowedAuthOrigin("https://taoslite.com:8443")).toBe(false);
  });

  it("refuses junk instead of throwing", () => {
    expect(isAllowedAuthOrigin("not a url")).toBe(false);
    expect(isAllowedAuthOrigin("")).toBe(false);
    expect(isAllowedAuthOrigin(null)).toBe(false);
    expect(isAllowedAuthOrigin(undefined)).toBe(false);
  });
});

describe("authRedirectTarget", () => {
  it("returns you to the preview you signed in from", () => {
    const preview = "https://taos-lite-git-feat-trip-mode-xdrabbits-projects.vercel.app";
    expect(authRedirectTarget(preview)).toBe(preview);
  });

  it("leaves production sign-in on production", () => {
    expect(authRedirectTarget("https://taoslite.com")).toBe("https://taoslite.com");
  });

  it("falls back to production for anything it does not recognize", () => {
    // Falling back rather than throwing is deliberate: a bad origin should cost
    // an unexpected landing page, never a broken sign-in button.
    expect(authRedirectTarget("https://evil.com")).toBe(PRODUCTION_ORIGIN);
    expect(authRedirectTarget("not a url")).toBe(PRODUCTION_ORIGIN);
    expect(authRedirectTarget(null)).toBe(PRODUCTION_ORIGIN);
  });

  it("returns the normalized origin, never the caller's string", () => {
    // Whatever came in, what goes out is what `new URL` vetted — so a host that
    // passed the check cannot smuggle its original spelling past Supabase.
    expect(authRedirectTarget("https://TAOSLITE.com")).toBe("https://taoslite.com");
    expect(authRedirectTarget("https://taoslite.com:443")).toBe("https://taoslite.com");
  });
});
