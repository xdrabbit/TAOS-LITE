// Every link in the daily email goes to https://taoslite.com.
//
// The bug (Tom, 2026-11-20, the first real production send): the button opened
// a Vercel deployment URL. The cron route built its origin from `req.url`, and
// Vercel Cron calls the production deployment on its own deployment hostname —
// which passes the trustedOrigin allow-list, because it is a legitimate
// preview host for sign-in. So nothing fell back and nothing looked wrong.
//
// The real route handler runs here, called the way Vercel Cron calls it. What
// is faked is runDailyEmails' far side: the table and the provider.

import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { emailOrigin } from "@/lib/email/config";
import { ENV, fakeProvider, fakeStore, row, TOM } from "./helpers/dailyEmailFakes";

const PRODUCTION = "https://taoslite.com";
const DEPLOYMENT = "https://taos-lite-64xtpacuh-xdrabbits-projects.vercel.app";
const DENVER_8AM = new Date("2026-11-18T15:00:00Z");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.doUnmock("@/lib/email/daily");
});

/** Calls GET /api/email/daily on `host` and returns the one email it sent. */
async function sendVia(host: string, extraEnv: Record<string, string> = {}) {
  vi.resetModules();
  vi.stubEnv("CRON_SECRET", "cron-secret");
  vi.stubEnv("TAOS_EMAIL_ORIGIN", "");
  for (const [name, value] of Object.entries(extraEnv)) vi.stubEnv(name, value);

  const store = fakeStore([row(TOM, { opted_in: true, time_zone: "America/Denver", send_hour: 8 })]);
  const provider = fakeProvider();
  const actual = await vi.importActual<typeof import("@/lib/email/daily")>("@/lib/email/daily");
  vi.doMock("@/lib/email/daily", () => ({
    ...actual,
    runDailyEmails: (options: Parameters<typeof actual.runDailyEmails>[0]) =>
      actual.runDailyEmails({
        ...options,
        now: DENVER_8AM,
        env: ENV,
        store,
        provider,
        screens: { study: true, tutor: true },
        log: () => {}
      })
  }));

  const { GET } = await import("@/app/api/email/daily/route");
  const res = await GET(
    new NextRequest(`${host}/api/email/daily`, { headers: { authorization: "Bearer cron-secret" } })
  );
  expect(res.status).toBe(200);
  expect(provider.sent).toHaveLength(1);
  return provider.sent[0];
}

/** Every absolute URL in the email: body, plain text, and the List-Unsubscribe header. */
function linksIn(email: { html: string; text: string; headers?: Record<string, string> }): string[] {
  const everything = [email.html, email.text, ...Object.values(email.headers ?? {})].join("\n");
  return (everything.match(/https?:\/\/[^\s"'<>)]+/g) ?? []).filter((url) => !url.startsWith("mailto:"));
}

describe("the daily email's links", () => {
  it("point at production when the cron is called on the deployment hostname", async () => {
    const email = await sendVia(DEPLOYMENT);
    const links = linksIn(email);
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const url of links) expect(url.startsWith(`${PRODUCTION}/`), url).toBe(true);
    // The button (Study or Tutor, whichever this person gets) and the unsubscribe link.
    expect(email.html).toMatch(/href="https:\/\/taoslite\.com\/(study|tutor)\?src=daily-email"/);
    expect(email.html).toContain(`href="${PRODUCTION}/api/email/unsubscribe?u=${TOM.id}&`);
    expect(JSON.stringify(email)).not.toContain("vercel.app");
  });

  it("point at production from any other host the route can be reached on", async () => {
    for (const host of ["https://taos-lite.vercel.app", "https://www.taoslite.com", "http://localhost:3017"]) {
      const email = await sendVia(host);
      for (const url of linksIn(email)) expect(url.startsWith(`${PRODUCTION}/`), `${host} -> ${url}`).toBe(true);
    }
  });

  it("follow TAOS_EMAIL_ORIGIN when it is set to a host we own, whatever the request host", async () => {
    const preview = "https://taos-lite-git-feat-x-xdrabbits-projects.vercel.app";
    const email = await sendVia(PRODUCTION, { TAOS_EMAIL_ORIGIN: preview });
    for (const url of linksIn(email)) expect(url.startsWith(`${preview}/`), url).toBe(true);
  });
});

describe("emailOrigin", () => {
  it("is production when unset or blank", () => {
    expect(emailOrigin({})).toBe(PRODUCTION);
    expect(emailOrigin({ TAOS_EMAIL_ORIGIN: "  " })).toBe(PRODUCTION);
  });

  it("ignores Vercel's own host variables", () => {
    expect(emailOrigin({ VERCEL_URL: "taos-lite-64xtpacuh-xdrabbits-projects.vercel.app" })).toBe(PRODUCTION);
  });

  it("sends an override we do not own, or one with a path, to production", () => {
    expect(emailOrigin({ TAOS_EMAIL_ORIGIN: "https://evil.example" })).toBe(PRODUCTION);
    expect(emailOrigin({ TAOS_EMAIL_ORIGIN: "https://taoslite.com.evil.com" })).toBe(PRODUCTION);
    expect(emailOrigin({ TAOS_EMAIL_ORIGIN: "https://taoslite.com/study" })).toBe(PRODUCTION);
  });

  it("never ends in a slash", () => {
    expect(emailOrigin({ TAOS_EMAIL_ORIGIN: "https://taoslite.com/" })).toBe(PRODUCTION);
  });
});
