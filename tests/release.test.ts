import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  callEnabled,
  founderEmails,
  HELD_BACK_V1,
  isFounder,
  onDeviceSttEnabled,
  tutorEnabled
} from "@/lib/release";

// The v1 release scope, decided 8/18 (Tom: "take us to minimum first release
// candidate"). Customers see Translate, Live, Chat, and the Photo translator;
// Call, Tabletop, and Video are founders-only.
//
// Tutor USED to be pinned here as in-scope, on the grounds that the paid plans
// sell tutor minutes and holding it back would make the pricing page a lie.
// Tom pulled it from RC1 on 8/18: it is unfinished and is planned as a premium
// feature, so it now hides behind tutorEnabled() (off by default) rather than
// behind the founders gate — nobody sees it, founders included. The pricing
// objection was not answered, only overruled: Landing.tsx and Paywall.tsx
// still advertise tutor minutes on every plan. That is tracked in
// ENHANCEMENTS.md and must be settled before anyone is charged.
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
  it("holds back exactly call, tabletop, and video", () => {
    expect([...HELD_BACK_V1].sort()).toEqual(["call", "tabletop", "video"]);
  });

  it("never holds back the customer-facing screens", () => {
    const held = new Set<string>(HELD_BACK_V1);
    for (const screen of ["translate", "live", "chat", "vision"]) {
      expect(held.has(screen)).toBe(false);
    }
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

// /call is off for RC1 — and note it is BOTH flagged off here and still a
// member of HELD_BACK_V1 above. That is deliberate, not a leftover: the flag
// is the RC1 decision (nobody sees /call, founders included), the founders
// gate is what it lands back on when the flag goes to 1, and the cost
// argument that put it behind the gate in the first place is still unanswered.
// Turning the flag on must not quietly ship /call to customers.
describe("callEnabled (RC1: /call is dark)", () => {
  it("is off when the flag is unset — the RC1 default, and what production ships", () => {
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

  it("stays in the founders-held set, so flag-on is not flag-on-for-everyone", () => {
    expect(new Set<string>(HELD_BACK_V1).has("call")).toBe(true);
    expect(read("app/call/page.tsx")).toContain("<FounderGate>");
  });

  it("redirects /call home rather than rendering it, and dynamically", () => {
    // force-dynamic matters as much as the redirect: statically prerendered,
    // Next turns redirect() into a post-hydration bounce with no Location
    // header — a visible flash of a screen that is supposed to be gone.
    const page = read("app/call/page.tsx");
    expect(page).toContain('export const dynamic = "force-dynamic"');
    expect(page).toContain('if (!callEnabled()) redirect("/")');
    // A shared /call?room=XYZ link should not preview a title either.
    expect(page).toContain("if (!callEnabled()) return {};");
  });

  it("404s the one route that spends money", () => {
    // /api/call/realtime is unauthenticated and its duration cap lives in the
    // client, so an off feature that still mints sessions is a live billing
    // hole, not a cosmetic one.
    const route = read("app/api/call/realtime/route.ts");
    expect(route).toContain("callEnabled");
    expect(route).toMatch(/if \(!callEnabled\(\)\) \{[\s\S]*?status: 404/);
  });

  it("has no /call link left in the nav outside the flag", () => {
    // The Together menu is the only place /call was ever linked. Every link
    // to it must sit directly under a callEnabled() gate — checked positionally
    // rather than by stripping the block, because a second, ungated copy
    // pasted in later is exactly the failure worth catching.
    for (const path of ["components/TranslatorShell.tsx", "components/Landing.tsx"]) {
      const lines = read(path).split("\n");
      lines.forEach((line, i) => {
        if (!line.includes('href="/call"')) return;
        const preceding = lines.slice(Math.max(0, i - 3), i).join("\n");
        expect(preceding).toContain("callEnabled() ? (");
      });
    }
    // ...and the gate is really there, so the loop above is not vacuous.
    expect(read("components/TranslatorShell.tsx")).toContain("callEnabled() ? (");
  });
});
