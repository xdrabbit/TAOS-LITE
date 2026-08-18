import { afterEach, describe, expect, it } from "vitest";
import { founderEmails, HELD_BACK_V1, isFounder, tutorEnabled } from "@/lib/release";

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

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.NEXT_PUBLIC_FOUNDER_EMAILS;
  } else {
    process.env.NEXT_PUBLIC_FOUNDER_EMAILS = ORIGINAL_ENV;
  }
  if (ORIGINAL_TUTOR === undefined) {
    delete process.env.NEXT_PUBLIC_ENABLE_TUTOR;
  } else {
    process.env.NEXT_PUBLIC_ENABLE_TUTOR = ORIGINAL_TUTOR;
  }
});

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
