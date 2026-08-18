// First-release scope (Tom, 8/18: "take us to minimum first release
// candidate"). Customers see the screens the product actually sells:
// Translate, Live, Chat, Tutor (the paid plans sell tutor minutes — hiding
// Tutor would make the pricing page a lie), and the Photo translator.
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
