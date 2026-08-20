// First-release scope (Tom, 8/18: "take us to minimum first release
// candidate"). Customers see the screens the product actually sells:
// Translate, Live, Chat, Table, and the Photo translator.
//
// Tutor was in that list until RC1 — the paid plans sell tutor minutes, so
// hiding it makes the pricing page write a cheque the app cannot cash. That
// held up charging anyone until v1.0.0, when tutorComingSoon() below started
// labelling every tutor promise on Landing.tsx, Paywall.tsx and layout.tsx
// off the same flag that hides the screen. The plans still sell the minutes,
// because tutor comes back and they are priced around it — they just no
// longer sell them as something available today.
//
// Everything else is HELD BACK behind the founders gate below — the pages
// still exist and work, but show "Coming soon" to anyone who isn't a founder,
// and their nav links are hidden:
// - /call     — bills two realtime lines the whole time it's connected
//               (the July 14/22 spikes); not sellable until the cost guards
//               in ENHANCEMENTS.md land. Now ALSO off entirely for RC1 —
//               see callEnabled() below; the founders gate is what it falls
//               back to once the flag is on again.
// - /video    — works, but heavy (uploads, ffmpeg) for a first release.
//
// /tabletop was held here too, as "niche party mode; every extra screen is a
// day-one support surface". Tom took it back out on 8/19, walking RC1 on the
// Droid and finding no way to reach it: Table is the across-the-table dinner
// mode, the reason to lay the phone down between two people at all, and it
// has been wired to the whole language catalog since the catalog landed. The
// day-one-support argument holds for /video and /call, which are heavy and
// unfinished respectively; it was never an argument against a screen that
// works. tests/nav-completeness.test.ts now pins the nav itself, so the next
// refactor cannot quietly orphan a screen the way this one was orphaned.
//
// To un-hold a screen: remove it here and un-wrap its page from
// <FounderGate>. tests/release.test.ts pins this set — change both together.
export const HELD_BACK_V1 = ["call", "video"] as const;

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

// The pricing copy is the other half of that flag, and it was the open
// objection to pulling tutor at all: the plans sell "15 / 45 / 200 tutor
// minutes / month" and the add-on packs sell more of them, so with tutor dark
// the storefront was writing a cheque the app could not cash. Stripe goes
// live now, which turns that from an inconsistency into a customer paying for
// a screen they cannot open.
//
// The answer is not to delete the tutor line items — tutor comes back next
// week and the plans are priced around it. It is to label every one of them,
// from the same flag, so the labels vanish on their own the moment
// NEXT_PUBLIC_ENABLE_TUTOR=1 lands. Nobody has to remember to un-edit copy.
//
// Landing.tsx, Paywall.tsx and layout.tsx are the three surfaces that promise
// tutor; tests/release.test.ts pins that none of them promise it unlabelled
// while the flag is off. Bilingual because the storefront is handed to
// strangers by QR code, and half of them read the Spanish side first — the
// same reason the /about link says "About TAOS · Acerca de TAOS".
export const COMING_SOON = "Coming soon · Próximamente";

// True when a tutor-dependent promise needs the label above. Tutor-dependent
// includes the drills and the progress tracking: both live inside /tutor, so
// they went dark with it.
export function tutorComingSoon(): boolean {
  return !tutorEnabled();
}

// /call is off for RC1 the way tutor is off: dark to everyone, founders
// included, rather than founders-only behind the gate above.
//
// The founders gate was the right answer while /call was finished work
// waiting on cost guards. It stopped being the right answer when the
// 100-language catalog landed (commit 1711a3f4): /live, /tabletop and /chat
// were wired to it, /call was not. It still mints an interpreter session with
// a hardcoded "en" | "es" target and an English/Spanish prompt, so on a trip
// where the pair is [en, it] the call screen quietly interprets into the
// wrong language. Half-integrated and never verified with two phones is not
// something to hand a founder either — the founders are the people who would
// reach for it in a real conversation and be let down by it.
//
// So: nav link gone, /call redirects home, and POST /api/call/realtime — the
// one route it has, and the one that spends money — answers 404. Setting
//
//     NEXT_PUBLIC_ENABLE_CALL=1
//
// restores exactly the previous behavior, founders gate and all; it does not
// ship /call to customers. Before that flag goes on for real: wire CallShell
// to the language catalog (useLanguagePair, like the other three) and make
// the interpreter prompt take a language pair instead of TargetLang, then
// walk it with two phones. ENHANCEMENTS.md carries the list.
export function callEnabled(): boolean {
  const flag = (process.env.NEXT_PUBLIC_ENABLE_CALL ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true";
}

// /live's second engine — "On-device", the Web Speech API path — is off for
// RC1 (Tom, 8/18: it has never once worked for him). It is not a half-built
// feature like tutor; it is a finished feature standing on a browser API that
// silently isn't there. Chrome on desktop/Android has it, Safari and every
// iOS browser do not, and a PWA in standalone mode is its own coin toss —
// which means the mode's failure looks exactly like the app being broken:
// tap START, nothing happens, no error worth reading.
//
// Ambient AI does the same job over WebRTC on every browser we ship to, so
// RC1 has one engine and no toggle to get lost in. The on-device code path,
// its recognizer watchdog, and lib/languages/recognition.ts all stay — this
// hides the door, it does not board up the room.
//
//     NEXT_PUBLIC_ENABLE_ONDEVICE_STT=1
//
// brings the toggle back (NEXT_PUBLIC_ for the same client-bundle reason as
// tutor above). Nothing persists the engine choice — /live mounts on
// "ambient" every time — so turning this off cannot strand anyone mid-mode.
// See the post-RC investigation note in ENHANCEMENTS.md before re-enabling.
export function onDeviceSttEnabled(): boolean {
  const flag = (process.env.NEXT_PUBLIC_ENABLE_ONDEVICE_STT ?? "").trim().toLowerCase();
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
