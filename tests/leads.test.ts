// The fence around the lead form's replacement.
//
// `taos_leads` was writable by anyone holding the publishable key — which is
// everyone, because it ships in the browser bundle by design. The policy is
// gone (supabase/migrations/20260826_leads_server_only.sql) and POST
// /api/leads is the only door left. These are the rules that door applies.
//
// The bar is low on purpose: a mailing-list signup that rejects a real address
// costs a customer, and one that accepts a junk address costs a row. So what
// is pinned here is "stops garbage", not "proves deliverable" — only sending
// mail can do the second one.
import { describe, expect, it } from "vitest";
import {
  LEAD_EMAIL_MAX,
  LEAD_SOURCE_DEFAULT,
  LEAD_SOURCE_MAX,
  LEAD_THANKS,
  isValidLeadEmail,
  normalizeLeadEmail,
  normalizeLeadSource
} from "@/lib/leads";

describe("an address is normalized before it is judged", () => {
  it("trims and folds case, so one person is one row", () => {
    expect(normalizeLeadEmail("  Tom@Example.COM ")).toBe("tom@example.com");
  });

  it("answers empty for anything that is not a string", () => {
    for (const junk of [null, undefined, 42, {}, []]) {
      expect(normalizeLeadEmail(junk)).toBe("");
    }
  });
});

describe("what counts as an address", () => {
  it("accepts the ordinary ones", () => {
    for (const email of [
      "tom@example.com",
      "liz.mariett@gmail.com",
      "a+tag@sub.domain.co.uk",
      "x_y-z@example.io"
    ]) {
      expect(isValidLeadEmail(normalizeLeadEmail(email))).toBe(true);
    }
  });

  it("rejects the shapes that are not addresses at all", () => {
    for (const junk of [
      "",
      "tom",
      "tom@",
      "@example.com",
      "tom@example", // no dot in the domain
      "tom @example.com",
      "tom@exa mple.com",
      "two@at@example.com",
      "tom@.com",
      "tom@example."
    ]) {
      expect(isValidLeadEmail(normalizeLeadEmail(junk))).toBe(false);
    }
  });

  it("refuses prose in an email column", () => {
    // The column used to accept anything anyone posted. The length ceiling is
    // RFC 5321's, so a body that is really a payload cannot ride in here.
    const long = `${"a".repeat(LEAD_EMAIL_MAX)}@example.com`;
    expect(long.length).toBeGreaterThan(LEAD_EMAIL_MAX);
    expect(isValidLeadEmail(long)).toBe(false);
    expect(isValidLeadEmail("please click here to claim your prize")).toBe(false);
  });
});

describe("the source tag is a label, not a message", () => {
  it("falls back rather than rejecting — an unlabelled lead is still a lead", () => {
    expect(normalizeLeadSource(undefined)).toBe(LEAD_SOURCE_DEFAULT);
    expect(normalizeLeadSource("")).toBe(LEAD_SOURCE_DEFAULT);
    expect(normalizeLeadSource("!!!")).toBe(LEAD_SOURCE_DEFAULT);
    expect(normalizeLeadSource(99)).toBe(LEAD_SOURCE_DEFAULT);
  });

  it("keeps the tag the existing row uses, so history stays comparable", () => {
    // The one real row in this table is source 'atom', from June.
    expect(normalizeLeadSource("atom")).toBe("atom");
  });

  it("strips instead of failing, and cannot grow unbounded", () => {
    expect(normalizeLeadSource("Landing Page!")).toBe("landingpage");
    expect(normalizeLeadSource("a".repeat(500))).toHaveLength(LEAD_SOURCE_MAX);
  });
});

describe("the thank-you follows the app's convention", () => {
  it("is bilingual", () => {
    expect(LEAD_THANKS).toContain("·");
    expect(LEAD_THANKS).toMatch(/Gracias/);
  });
});
