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
// - /call     — bills two realtime lines while connected (the July 14/22
//               spikes). The cost guards landed 8/27 and the per-minute
//               spend is measured now (lib/call/cost.ts), but "cheap enough
//               for two founders" is not "sellable", and it has still never
//               met a stranger's carrier NAT. See callVisibleTo() below.
// - /video    — works, but heavy (uploads, ffmpeg) for a first release.
// - /fast     — the word-for-word quickie box, added 2026-08-30. Not
//               unfinished and not expensive: held back because its whole
//               register is the OPPOSITE of what the rest of TAOS sells
//               (literal, not "the way a friend would say it"), and handing
//               a stranger two translation screens that disagree on purpose
//               needs a wave's worth of watching first. See fastVisibleTo().
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
export const HELD_BACK_V1 = ["call", "fast", "video"] as const;

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

// /call: FOUNDERS ONLY, and the flag below no longer means what it meant.
//
// The RC1 answer (8/18) was to black /call out for everyone, founders
// included, because it was the one screen the 100-language catalog never
// reached (commit 1711a3f4): it minted an interpreter with a hardcoded
// "en" | "es" target, so a trip on [en, it] got interpreted into Spanish.
// Half-integrated is not something to hand a founder either — the founders
// are exactly the people who would reach for it in a real conversation and
// be let down by it.
//
// Both halves of that objection are answered now (this PR):
//   - CallShell reads useLanguagePair() like every other screen, and the two
//     phones exchange their languages over the call's own signaling channel,
//     so each end interprets INTO its owner's language whatever the pair is.
//   - The cost guards ENHANCEMENTS.md has been asking for since 8/03 are in:
//     context truncation, a 60-minute cap, a 2-minute idle hangup, and a
//     per-session dollar meter on screen. lib/call/cost.ts has the numbers.
//
// So the gate goes back to the founders gate — the one /video sits behind —
// and the public flag becomes what its name always said it was: whether
// /call has shipped to CUSTOMERS. It has not, and it stays off. Founders no
// longer need it set to reach the screen; nobody else gets there with it
// unset. That is the whole difference from RC1, and it is why callEnabled()
// is not what any surface asks any more — they ask callVisibleTo(email).
//
//     NEXT_PUBLIC_ENABLE_CALL=1
//
// would ship /call to everyone, and is a product decision, not a refactor:
// two founders on two phones is not the same test as a stranger's carrier
// NAT, and the per-minute spend below is founder-shaped, not customer-shaped.
// tests/release.test.ts pins the default.
export function callEnabled(): boolean {
  const flag = (process.env.NEXT_PUBLIC_ENABLE_CALL ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true";
}

/**
 * May this person reach /call at all?
 *
 * THE question every /call surface asks — the nav link, the page gate, and
 * POST /api/call/realtime, which is the one that spends money. Public when
 * the flag says so; founders always. A single helper because the three
 * surfaces disagreeing is precisely how /tabletop lost its nav entry: each
 * one grew its own idea of who was allowed.
 *
 * The route-level check is the load-bearing one. The nav link and the page
 * gate run in the browser off a Supabase session the client already holds,
 * which makes them a courtesy, not a fence — a determined stranger can render
 * the component. What they cannot do is mint a realtime session, because the
 * route re-asks this question against a server-validated access token.
 */
export function callVisibleTo(email: string | null | undefined): boolean {
  return callEnabled() || isFounder(email);
}

// /fast: FOUNDERS ONLY, on the same two-function shape as /call above —
// a public flag that has not shipped, plus a founder bypass.
//
// The reason is not cost and not readiness. /fast is a one-line box that
// translates AS YOU TYPE, and it is the only surface in TAOS that translates
// LITERALLY: word-for-word and plain, where /translate, /live, /chat and the
// rest all ask for "the way a fluent friend would say it". That contrast is
// the feature — it is what makes /fast a dictionary and the others an
// interpreter — but it is also two screens that will hand the same sentence
// back differently, on purpose, to a person who did not read this comment.
// Founders use it for a wave first and find out whether that reads as a
// second tool or as a bug.
//
// Promoting it is ONE LINE. Set:
//
//     NEXT_PUBLIC_ENABLE_FAST=1
//
// in Vercel and redeploy — no code change, exactly like /call. The nav link,
// the page and POST /api/fast all ask fastVisibleTo(), so they open together
// and cannot drift apart the way /tabletop's nav entry once did.
// NEXT_PUBLIC_ because the nav that hides the link renders in the browser;
// the literal process.env expression is what lets Next inline it into the
// client bundle. tests/release.test.ts pins the default.
export function fastEnabled(): boolean {
  const flag = (process.env.NEXT_PUBLIC_ENABLE_FAST ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true";
}

/**
 * May this person reach /fast at all?
 *
 * THE question every /fast surface asks — the nav entry in the grid menu, the
 * page gate, and POST /api/fast, which is the one that spends money. The
 * route-level check is the load-bearing one for exactly the reason
 * callVisibleTo() documents: the other two run in the browser off a session
 * the client already holds, so they hide the screen without defending it.
 */
export function fastVisibleTo(email: string | null | undefined): boolean {
  return fastEnabled() || isFounder(email);
}

/**
 * Does a founder bypass /fast's STREAMING-SPEECH budget?
 *
 * Not while /fast is founders-gated. That combination is a meter that binds
 * nobody: fastVisibleTo() says only founders can reach the screen, and an
 * unconditional founder bypass would say founders do not count against the
 * speech budget — so the ledger in lib/fast/speechMeter.ts would run, and
 * refuse, for the empty set. The one population that could exercise it is the
 * one population exempted from it, and the first time the number mattered
 * would be the first day it applied to a stranger.
 *
 * So the bypass is tied to the gate rather than to the person. While /fast is
 * held back, founders spend against the ordinary allowance — they ARE the
 * test population, and TAOS_FAST_SPEECH_SECONDS_PER_HOUR is set generously
 * (ten minutes of audio an hour, roughly twenty spoken quickies) precisely so
 * that daily use walks the meter without tripping it. The day
 * NEXT_PUBLIC_ENABLE_FAST=1 promotes the screen, this flips itself: the
 * surface is public, strangers are the ones being bounded, and founders stop
 * paying for their own product.
 *
 * NOTE the deliberate asymmetry with the TYPING meter, which still passes
 * isFounder() straight through as p_unlimited (lib/fast/meter.ts). That one
 * is not /fast's own: it counts rows in taos_lite_translations, the SHARED
 * monthly allowance the home screen and /translate spend from too. Capping a
 * founder there would cap them at 25 translations a month across the whole
 * app to make one screen's number honest, which is a worse trade than the
 * one this function makes.
 */
export function fastSpeechUnlimited(email: string | null | undefined): boolean {
  return fastEnabled() && isFounder(email);
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
