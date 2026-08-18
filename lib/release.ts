// First-release scope (Tom, 8/18: "take us to minimum first release
// candidate"). Customers see the screens the product actually sells:
// Translate, Live, Chat, and the Photo translator.
//
// Tutor was in that list until RC1 — the paid plans sell tutor minutes, so
// hiding it makes the pricing page write a cheque the app cannot cash. That
// is a real and still-open problem: Landing.tsx and Paywall.tsx advertise
// "15 / 45 / 200 tutor minutes / month" on every plan. Nobody should be
// charged for those until either tutor comes back or the plans stop selling
// it. See tutorEnabled() below and the RC1 note in ENHANCEMENTS.md.
//
// Everything else is HELD BACK behind the founders gate below — the pages
// still exist and work, but show "Coming soon" to anyone who isn't a founder,
// and their nav links are hidden:
// - /call     — bills two realtime lines the whole time it's connected
//               (the July 14/22 spikes); not sellable until the cost guards
//               in ENHANCEMENTS.md land.
// - /tabletop — niche party mode; every extra screen is a day-one support
//               surface.
// - /video    — works, but heavy (uploads, ffmpeg) for a first release.
//
// To un-hold a screen: remove it here and un-wrap its page from
// <FounderGate>. tests/release.test.ts pins this set — change both together.
export const HELD_BACK_V1 = ["call", "tabletop", "video"] as const;

// /tutor is held back a different way, and for a different reason. The screens
// above are finished work waiting on cost guards or on a day-one support
// budget, so founders keep using them. Tutor is not finished, and it is the
// premium feature the roadmap sells later (ENHANCEMENTS.md: study words, the
// notebook) — RC1 goes out behind a QR code to strangers, and a half-built
// tutor is worse than no tutor at all. So it is hidden from EVERYONE,
// founders included, and its route redirects home rather than showing a
// "coming soon" card.
//
// The code, the course content, and the tests all stay in the repo. Turning
// tutor back on is one environment variable in Vercel and a redeploy:
//
//     NEXT_PUBLIC_ENABLE_TUTOR=1
//
// NEXT_PUBLIC_ because the nav that hides the link renders on the client;
// reading the literal process.env expression below (rather than a computed
// key) is what lets Next inline the value into the browser bundle.
// tests/release.test.ts pins the default — turning tutor on for RC1 is a
// product decision, not a refactor.
export function tutorEnabled(): boolean {
  const flag = (process.env.NEXT_PUBLIC_ENABLE_TUTOR ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true";
}

// Founders keep using everything. Tom and Liz are hardcoded; add anyone else
// via NEXT_PUBLIC_FOUNDER_EMAILS in Vercel — comma-separated, no code change
// needed, just an env edit + redeploy.
const FOUNDER_EMAILS = ["xdrabbit@gmail.com", "lizmariett@gmail.com"];

export function founderEmails(extra: string | undefined): Set<string> {
  const fromEnv = (extra ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...FOUNDER_EMAILS, ...fromEnv]);
}

export function isFounder(email: string | null | undefined): boolean {
  if (!email) return false;
  return founderEmails(process.env.NEXT_PUBLIC_FOUNDER_EMAILS).has(email.trim().toLowerCase());
}
