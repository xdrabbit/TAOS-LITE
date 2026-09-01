import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  callEnabled,
  callVisibleTo,
  founderEmails,
  HELD_BACK_V1,
  isFounder,
  onDeviceSttEnabled,
  tutorComingSoon,
  tutorEnabled
} from "@/lib/release";
import { buildCallSession } from "@/lib/call/realtimeSession";

// The v1 release scope, decided 8/18 (Tom: "take us to minimum first release
// candidate"). Customers see Translate, Live, Chat, Table, and the Photo
// translator; Call and Video are founders-only.
//
// Tabletop was founders-only until 8/19, when Tom walked RC1 on the Droid and
// found Table had no way in at all. It came out of the held-back set on his
// say-so — see the /tabletop note in lib/release.ts. What stops the reverse
// mistake now is tests/nav-completeness.test.ts, which pins the nav rather
// than the scope list.
//
// Tutor USED to be pinned here as in-scope, on the grounds that the paid plans
// sell tutor minutes and holding it back would make the pricing page a lie.
// Tom pulled it from RC1 on 8/18: it is unfinished and is planned as a premium
// feature, so it now hides behind tutorEnabled() (off by default) rather than
// behind the founders gate — nobody sees it, founders included. That left the
// pricing objection open, and v1.0.0 (8/19) is the release that answers it:
// every tutor promise on Landing.tsx, Paywall.tsx and layout.tsx now reads
// from tutorComingSoon(), so the storefront labels what it cannot yet deliver
// and un-labels it the moment the flag flips. The block at the bottom of this
// file pins that, because the failure it prevents is a live Stripe charge for
// a screen the customer cannot open.
//
// Changing any of this is a product decision: get Tom's say-so and update
// lib/release.ts and this test in the same PR.

const ORIGINAL_ENV = process.env.NEXT_PUBLIC_FOUNDER_EMAILS;
const ORIGINAL_TUTOR = process.env.NEXT_PUBLIC_ENABLE_TUTOR;
const ORIGINAL_ONDEVICE = process.env.NEXT_PUBLIC_ENABLE_ONDEVICE_STT;
const ORIGINAL_CALL = process.env.NEXT_PUBLIC_ENABLE_CALL;

function restore(name: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = original;
  }
}

afterEach(() => {
  restore("NEXT_PUBLIC_FOUNDER_EMAILS", ORIGINAL_ENV);
  restore("NEXT_PUBLIC_ENABLE_TUTOR", ORIGINAL_TUTOR);
  restore("NEXT_PUBLIC_ENABLE_ONDEVICE_STT", ORIGINAL_ONDEVICE);
  restore("NEXT_PUBLIC_ENABLE_CALL", ORIGINAL_CALL);
});

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("v1 held-back set", () => {
  it("holds back exactly call, fast and video", () => {
    // /fast joined on 8/30. Not for cost or readiness — it is a literal
    // word-for-word screen in an app whose whole voice is the opposite, and
    // two translation screens that disagree on purpose get a founders' wave
    // before a stranger's. See fastVisibleTo() in lib/release.ts.
    expect([...HELD_BACK_V1].sort()).toEqual(["call", "fast", "video"]);
  });

  it("never holds back the customer-facing screens", () => {
    const held = new Set<string>(HELD_BACK_V1);
    for (const screen of ["translate", "live", "chat", "tabletop", "vision"]) {
      expect(held.has(screen)).toBe(false);
    }
  });

  it("leaves /tabletop un-gated in the page itself, not just in the list", () => {
    // Removing a screen from HELD_BACK_V1 and forgetting to un-wrap its page
    // is the silent half of this change: the list would say customer-facing
    // while the route still showed "Coming soon". The import is the tell —
    // the page's comment still names the gate it used to sit behind.
    expect(read("app/tabletop/page.tsx")).not.toContain('from "@/components/FounderGate"');
  });

  it("does not route tutor through the founders gate — it has its own flag", () => {
    // Founders do NOT get tutor back. Anyone tempted to "fix" tutor's absence
    // by adding it to HELD_BACK_V1 would hand it to Tom and Liz while leaving
    // it hidden from customers, which is the opposite of a premium feature.
    expect(new Set<string>(HELD_BACK_V1).has("tutor")).toBe(false);
  });
});

describe("tutorEnabled (RC1: tutor is off)", () => {
  it("is off when the flag is unset — the RC1 default, and what production ships", () => {
    delete process.env.NEXT_PUBLIC_ENABLE_TUTOR;
    expect(tutorEnabled()).toBe(false);
  });

  it("is off for every value that is not an explicit opt-in", () => {
    for (const value of ["", " ", "0", "false", "no", "off", "undefined", "please"]) {
      process.env.NEXT_PUBLIC_ENABLE_TUTOR = value;
      expect(tutorEnabled()).toBe(false);
    }
  });

  it("turns on with 1 or true, tolerating case and stray whitespace", () => {
    for (const value of ["1", " 1 ", "true", "TRUE", " True "]) {
      process.env.NEXT_PUBLIC_ENABLE_TUTOR = value;
      expect(tutorEnabled()).toBe(true);
    }
  });
});

describe("isFounder", () => {
  it("recognizes Tom and Liz, case- and whitespace-insensitively", () => {
    delete process.env.NEXT_PUBLIC_FOUNDER_EMAILS;
    expect(isFounder("xdrabbit@gmail.com")).toBe(true);
    expect(isFounder("  XDRabbit@Gmail.com ")).toBe(true);
    // Liz — added by Tom's 8/18 direction.
    expect(isFounder("lizmariett@gmail.com")).toBe(true);
    expect(isFounder("LizMariett@gmail.com")).toBe(true);
  });

  it("rejects everyone else, including empty and null", () => {
    delete process.env.NEXT_PUBLIC_FOUNDER_EMAILS;
    expect(isFounder("customer@example.com")).toBe(false);
    expect(isFounder("")).toBe(false);
    expect(isFounder(null)).toBe(false);
    expect(isFounder(undefined)).toBe(false);
  });

  it("adds founders from NEXT_PUBLIC_FOUNDER_EMAILS (comma-separated, trimmed, case-folded)", () => {
    process.env.NEXT_PUBLIC_FOUNDER_EMAILS = " Liz@Example.com , second@example.com ,";
    expect(isFounder("liz@example.com")).toBe(true);
    expect(isFounder("second@example.com")).toBe(true);
    expect(isFounder("xdrabbit@gmail.com")).toBe(true);
    expect(isFounder("customer@example.com")).toBe(false);
  });

  it("founderEmails always contains the hardcoded founders", () => {
    expect(founderEmails(undefined).has("xdrabbit@gmail.com")).toBe(true);
    expect(founderEmails(undefined).has("lizmariett@gmail.com")).toBe(true);
    expect(founderEmails("a@b.com").has("a@b.com")).toBe(true);
  });
});

// /live's "On-device" engine (Web Speech API) is off for RC1 — Tom, 8/18: it
// has never worked for him, and the API it needs is missing on iOS and
// unreliable in PWA standalone, so its failure mode is a screen that looks
// broken. Ambient AI covers the same use case everywhere we ship. The code
// stays; only the door is hidden. Same env-flag shape as tutor above, and the
// same rule: turning it on is a product decision, not a refactor.
describe("onDeviceSttEnabled (RC1: /live has one engine)", () => {
  it("is off when the flag is unset — the RC1 default, and what production ships", () => {
    delete process.env.NEXT_PUBLIC_ENABLE_ONDEVICE_STT;
    expect(onDeviceSttEnabled()).toBe(false);
  });

  it("is off for every value that is not an explicit opt-in", () => {
    for (const value of ["", " ", "0", "false", "no", "off", "undefined", "maybe"]) {
      process.env.NEXT_PUBLIC_ENABLE_ONDEVICE_STT = value;
      expect(onDeviceSttEnabled()).toBe(false);
    }
  });

  it("turns on with 1 or true, tolerating case and stray whitespace", () => {
    for (const value of ["1", " 1 ", "true", "TRUE", " True "]) {
      process.env.NEXT_PUBLIC_ENABLE_ONDEVICE_STT = value;
      expect(onDeviceSttEnabled()).toBe(true);
    }
  });

  it("reads the literal process.env expression, so Next can inline it client-side", () => {
    // A computed key (process.env[name]) is invisible to Next's build-time
    // replacement and would come back undefined in the browser bundle — the
    // flag would then read as "off" even when Vercel has it set to 1.
    expect(read("lib/release.ts")).toContain("process.env.NEXT_PUBLIC_ENABLE_ONDEVICE_STT");
  });

  it("is what hides /live's engine toggle — not a stray import", () => {
    // Source-read on purpose: the failure this guards against is someone
    // deleting the `onDeviceAllowed ?` wrapper around the toggle and leaving
    // the flag in place, which puts a dead mode back in front of customers.
    const live = read("components/LiveShell.tsx");
    expect(live).toContain("onDeviceSttEnabled");
    expect(live).toContain("onDeviceAllowed ? (");
    // And the mode stays unreachable even if some other path calls into it.
    expect(live).toContain('if (next === "device" && !onDeviceAllowed) return;');
  });

  it("never restores a persisted engine — /live must mount on ambient", () => {
    // The flag can only be trusted if nothing outlives it. If /live ever
    // starts remembering the engine, this fails and the restore has to run
    // through the flag before it can land.
    const live = read("components/LiveShell.tsx");
    expect(live).not.toMatch(/localStorage|sessionStorage/);
    expect(live).toContain('useState<Engine>("ambient")');
  });
});

// /call came back on 2026-08-27, founders-only — the gate /video sits behind
// — and the public flag changed meaning in the process. It used to be "is
// /call reachable at all" (RC1: no, by anyone, founders included); it is now
// "has /call shipped to CUSTOMERS", which is still no.
//
// Both halves of the RC1 objection were answered to get here: CallShell reads
// the shared language pair like every other screen (the catalog gap that
// caused the blackout), and the cost guards ENHANCEMENTS.md asked for are in
// with numbers measured against a live session. What has NOT been answered is
// whether a stranger's carrier NAT can hold a call, or whether the per-minute
// spend is customer-shaped — which is why the flag stays off and this block
// pins that turning it on is a product decision, not a refactor.
describe("callEnabled (the public flag: /call has NOT shipped to customers)", () => {
  it("is off when the flag is unset — the default, and what production ships", () => {
    delete process.env.NEXT_PUBLIC_ENABLE_CALL;
    expect(callEnabled()).toBe(false);
  });

  it("is off for every value that is not an explicit opt-in", () => {
    for (const value of ["", " ", "0", "false", "no", "off", "undefined", "soon"]) {
      process.env.NEXT_PUBLIC_ENABLE_CALL = value;
      expect(callEnabled()).toBe(false);
    }
  });

  it("turns on with 1 or true, tolerating case and stray whitespace", () => {
    for (const value of ["1", " 1 ", "true", "TRUE", " True "]) {
      process.env.NEXT_PUBLIC_ENABLE_CALL = value;
      expect(callEnabled()).toBe(true);
    }
  });

  it("reads the literal process.env expression, so Next can inline it client-side", () => {
    expect(read("lib/release.ts")).toContain("process.env.NEXT_PUBLIC_ENABLE_CALL");
  });
});

describe("callVisibleTo (founders now, everyone only when the flag ships)", () => {
  it("lets founders in with the flag off — the whole point of this change", () => {
    delete process.env.NEXT_PUBLIC_ENABLE_CALL;
    delete process.env.NEXT_PUBLIC_FOUNDER_EMAILS;
    expect(callVisibleTo("xdrabbit@gmail.com")).toBe(true);
    expect(callVisibleTo("lizmariett@gmail.com")).toBe(true);
  });

  it("keeps everyone else out with the flag off, signed in or not", () => {
    delete process.env.NEXT_PUBLIC_ENABLE_CALL;
    delete process.env.NEXT_PUBLIC_FOUNDER_EMAILS;
    expect(callVisibleTo("customer@example.com")).toBe(false);
    expect(callVisibleTo(null)).toBe(false);
    expect(callVisibleTo(undefined)).toBe(false);
    expect(callVisibleTo("")).toBe(false);
  });

  it("opens to everyone only when the flag actually ships it", () => {
    process.env.NEXT_PUBLIC_ENABLE_CALL = "1";
    expect(callVisibleTo("customer@example.com")).toBe(true);
    expect(callVisibleTo(null)).toBe(true);
  });

  it("stays in the founders-held set — /call is not a customer screen", () => {
    expect(new Set<string>(HELD_BACK_V1).has("call")).toBe(true);
  });

  it("is what the page gate, the nav and the money route all ask", () => {
    // Three surfaces, one question. /tabletop lost its nav entry precisely
    // because each surface grew its own idea of who was allowed, so this
    // pins that none of them re-derives the answer from isFounder directly.
    expect(read("app/call/page.tsx")).toContain("<FounderGate");
    expect(read("components/TranslatorShell.tsx")).toContain("callVisibleTo(email)");
    expect(read("app/api/call/realtime/route.ts")).toContain("callVisibleTo(email)");
  });

  it("bounces a non-founder home rather than showing them a coming-soon card", () => {
    // /call?room=XYZ links live in people's messages. A stranger who taps a
    // forwarded one should land on TAOS, not on an advert for a screen they
    // will never get — unlike /video, which you can only reach on purpose.
    expect(read("app/call/page.tsx")).toContain('deny="home"');
    expect(read("app/video/page.tsx")).not.toContain("deny=");
  });

  it("bounces a non-founder off /fast too — a quickie URL travels in messages", () => {
    // Tom asked for a 307 here. It cannot be one: /tutor redirects
    // server-side because tutorEnabled() is an env flag the server can read,
    // whereas this gate is fastVisibleTo(EMAIL) and the session lives
    // client-side, so a server component cannot tell a founder from anyone
    // else. Same destination, client-side. The fence is the route.
    expect(read("app/fast/page.tsx")).toContain('deny="home"');
  });

  it("keeps the /fast money route as the actual fence, answering 404", () => {
    const route = read("app/api/fast/route.ts");
    const guard = route.indexOf("await guardSpend(req)");
    const gate = route.indexOf("fastVisibleTo(email)");
    const spend = route.indexOf("await fastTranslate(");
    expect(guard).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(guard);
    expect(spend).toBeGreaterThan(gate);
    expect(route).toContain('status: 404');
  });
});

describe("the /call routes are the fence, not the page", () => {
  // The page gate runs in the browser off a client-held Supabase session, so
  // it hides /call without defending it. These two routes re-ask the same
  // question against a server-validated token, and they are the ones that
  // reach a paid provider.
  for (const path of ["app/api/call/realtime/route.ts", "app/api/call/usage/route.ts"]) {
    it(`${path} refuses a non-founder as a 404`, () => {
      // The behaviour itself is exercised against the real handlers in
      // tests/call-gating.test.ts; this is the cheap structural half, so a
      // refactor that drops the check fails in two places rather than none.
      const route = read(path);
      expect(route).toContain("!callVisibleTo(email)");
      expect(route).toContain("404");
    });

    it(`${path} identifies the caller before it decides anything`, () => {
      // guardSpend FIRST, because founder-ness is an answer only a validated
      // access token can give — and it must land before any provider call.
      const route = read(path);
      const guardAt = route.indexOf("await guardSpend(req)");
      const visibleAt = route.indexOf("callVisibleTo(email)");
      expect(guardAt).toBeGreaterThan(-1);
      expect(visibleAt).toBeGreaterThan(guardAt);
    });
  }

  it("the minting route never reaches OpenAI before the gate", () => {
    const route = read("app/api/call/realtime/route.ts");
    expect(route.indexOf("callVisibleTo(email)")).toBeLessThan(route.indexOf("fetch(CLIENT_SECRETS_URL"));
  });

  it("the client sends its access token, or the fence answers nobody", () => {
    // The old client posted to /api/call/realtime with no Authorization
    // header at all. That was invisible while the route 404'd for everyone;
    // the moment the gate went to "founders", it would have 401'd Tom.
    expect(read("lib/call/interpreter.ts")).toContain("jsonAuthHeaders()");
    expect(read("components/CallShell.tsx")).toContain("jsonAuthHeaders()");
  });
});

describe("/call cost guards (ENHANCEMENTS.md, asked for on 8/03)", () => {
  it("caps how much conversation the model re-reads per response", () => {
    // THE saving. Measured 2026-08-27: uncapped, a session billed 209% of the
    // audio actually spoken and was still climbing turn over turn, because
    // every response re-reads the whole call at $32/Mtok. Capped, it billed
    // 66% and held flat. Deleting this is how a long call gets expensive
    // again, silently.
    //
    // Asserted on the BUILT session rather than on the route's source text as
    // of 8/31: the session object moved into lib/call/realtimeSession.ts so
    // the live-fire rig could drive the thing that ships (the same reason
    // /live and /tabletop have builders — see tests/realtime-cost-caps.ts).
    // Reading the object is the stronger claim anyway; the old grep would
    // have passed on a `truncation` sitting in a comment.
    const session = buildCallSession({
      direction: { source: "es", target: "en" },
      model: "gpt-realtime",
      voice: "marin",
      transcribeModel: "gpt-4o-mini-transcribe",
      mode: "clone"
    }) as { truncation?: { type: string; retention_ratio: number; token_limits: { post_instructions: number } } };
    expect(session.truncation).toEqual({
      type: "retention_ratio",
      retention_ratio: 0.8,
      token_limits: { post_instructions: 100 }
    });
    // And the route still mints with it, rather than building it and dropping
    // it on the floor.
    const route = read("app/api/call/realtime/route.ts");
    expect(route).toContain("buildCallSession");
    expect(route).toContain("session");
  });

  it("shrinks the four-hour client cap to the API's own one-hour ceiling", () => {
    const interpreter = read("lib/call/interpreter.ts");
    expect(interpreter).toContain("DEFAULT_MAX_MS = 60 * 60 * 1000");
    expect(interpreter).not.toContain("4 * 60 * 60 * 1000");
  });

  it("hangs the interpreter up after two minutes of quiet, with a warning", () => {
    const interpreter = read("lib/call/interpreter.ts");
    expect(interpreter).toContain("DEFAULT_IDLE_MS = 2 * 60 * 1000");
    expect(interpreter).toContain("IDLE_WARNING_MS");
    expect(interpreter).toContain("onIdleWarning");
  });

  it("gives the minted secret a short life", () => {
    const route = read("app/api/call/realtime/route.ts");
    expect(route).toContain("expires_after");
    expect(route).toContain("SECRET_TTL_SECONDS");
  });

  it("puts the dollars on the screen and in the log", () => {
    // "What does a minute of this cost?" had no answer after the July spikes.
    expect(read("components/CallShell.tsx")).toContain("formatUsdPerMinute");
    expect(read("lib/call/cost.ts")).toContain("[taos-call-cost]");
  });
});

// The pricing-copy fence (v1.0.0, 8/19). Stripe went live with tutor gated
// off, so the plans sell minutes nobody can spend yet. The rule is not "delete
// the tutor line items" — tutor comes back and the plans are priced around it
// — it is "never promise one unlabelled while the flag is off".
//
// These read the source rather than render the components: the point is that
// the label is wired to the FLAG, not that some particular string is on screen
// today. A rendered assertion would pass just as well against copy someone had
// hand-edited to say "coming soon", which is the version that goes stale the
// week tutor returns.
describe("pricing copy does not sell a gated tutor (v1.0.0)", () => {
  it("tracks tutorEnabled, so the labels lift by themselves", () => {
    delete process.env.NEXT_PUBLIC_ENABLE_TUTOR;
    expect(tutorComingSoon()).toBe(true);
    process.env.NEXT_PUBLIC_ENABLE_TUTOR = "1";
    expect(tutorComingSoon()).toBe(false);
  });

  it("labels every tutor line item on both pricing surfaces", () => {
    // Each tutor-dependent feature is tagged `tutor: true` in the plan data
    // and rendered through that tag. Counting them is what catches a fourth
    // line item added later without the tag.
    for (const path of ["components/Landing.tsx", "components/Paywall.tsx"]) {
      const src = read(path);
      expect(src).toContain("tutorComingSoon");
      expect(src).toContain("COMING_SOON");

      // Every "N tutor minutes" and every drills/progress line carries the tag.
      const tutorLines = src
        .split("\n")
        .filter((l) => /tutor minutes|Drills [&+]|minute packs/.test(l) && l.includes("text:"));
      expect(tutorLines.length).toBeGreaterThan(0);
      for (const line of tutorLines) expect(line).toContain("tutor: true");
    }
  });

  it("withholds the add-on minute packs rather than labelling a live charge", () => {
    // The packs are the only tutor promise on the paywall that moves money.
    // A badge next to a button that still charges $9.99 is not honesty, so
    // the buy buttons render only when tutor is actually on.
    const src = read("components/Paywall.tsx");
    expect(src).toContain("isPaid && !comingSoon ? (");
    // startPackCheckout stays wired — this withholds the button, it does not
    // rip out the feature or touch the Stripe price objects.
    expect(src).toContain("startPackCheckout");
  });

  it("does not call TAOS an AI language tutor in the site metadata", () => {
    // The title and description are the one surface a badge cannot sit on,
    // so they swap wholesale — but both halves stay, behind the same flag.
    const src = read("app/layout.tsx");
    expect(src).toContain("tutorEnabled()");
    const titleLine = src.split("\n").find((l) => l.includes("const TITLE"));
    expect(titleLine).toContain("tutorEnabled()");
    // The tutor wording is still in the file, ready for the flag.
    expect(src).toContain("AI language tutor");
  });

  it("ships the footer version as v1.0.0", () => {
    // The prod footer reads "v1.0.0 · <sha>"; the smoke test after a deploy is
    // "does the footer show the sha I just merged", which needs the version
    // bumped in the same PR as the release.
    expect(read("lib/version.ts")).toContain('APP_VERSION = "1.0.0"');
  });
});
