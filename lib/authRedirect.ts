// Where Google sign-in is allowed to put you back down.
//
// The bug this exists for (Tom, 8/18, prepping the RC1 walkthrough): signing in
// with Google on a preview deployment landed on production. Supabase does not
// simply honor the `redirectTo` it is handed — it checks the value against the
// project's Redirect URLs allow-list and, when nothing matches, SILENTLY
// substitutes the Site URL. No error, no warning, just the wrong app. The
// allow-list held production and nothing else, so every preview host — and
// localhost, and www — resolved to https://taoslite.com/. A tester who thought
// they were reviewing a branch was reviewing production.
//
// So the load-bearing half of that fix is a dashboard setting, not code:
// docs/supabase-auth-redirects.md has the exact entries to add and the one
// command that proves they took. THIS file is the other half. It is the same
// allow-list, applied before a host is ever handed to Supabase, so that
// widening the dashboard list cannot turn the sign-in button into an open
// redirect — a stolen session is a worse bug than the one being fixed. The two
// lists are a pair: change one, change the other.
//
// Since 8/18 this is also the fence for every OTHER route that turns a
// client-supplied `Origin` into a URL somebody else will follow — the three
// Stripe routes that build `success_url` / `cancel_url` / `return_url`, and
// since 8/19 the /chat invite link. They all call `trustedOrigin` below.
// Same allow-list, one place to widen it.

/** Where an unrecognized host gets sent instead. Also Supabase's Site URL. */
export const PRODUCTION_ORIGIN = "https://taoslite.com";

const EXACT_HOSTS = new Set([
  "taoslite.com",
  "www.taoslite.com",
  // The project's own vercel.app alias, which predates the custom domain and
  // still appears in the printed test plans (outputs/TAOS_test_plan.md).
  "taos-lite.vercel.app"
]);

// Vercel names every deployment of this project
// `taos-lite-<something>-xdrabbits-projects.vercel.app`. All three forms in the
// wild match: the unique deployment URL (taos-lite-64xtpacuh-…), the branch
// alias (taos-lite-git-feat-trip-mode-…), and the truncated-plus-hash alias a
// long branch name gets (taos-lite-git-claude-taoslite-load-fa-c65fb2-…).
//
// The scope slug on the end is what makes this safe to wildcard: every host
// under `-xdrabbits-projects.vercel.app` is a deployment inside Tom's Vercel
// team, and nobody else can publish one. Both ends are anchored on purpose —
// unanchored, `evil-taos-lite-x-xdrabbits-projects.vercel.app` and
// `taos-lite-x-xdrabbits-projects.vercel.app.evil.com` would both pass.
const PREVIEW_HOST = /^taos-lite-[a-z0-9-]+-xdrabbits-projects\.vercel\.app$/;

// `npm run dev` serves on 3017, but any port is fine here: reaching localhost
// at all means the browser is already on the developer's own machine.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Is this an origin we are willing to have Google hand a session back to?
 *
 * Deliberately strict: a bare origin and nothing else. A path, query, fragment
 * or embedded credentials on something claiming to be a host is how an open
 * redirect gets smuggled past a hostname check, and we never have a legitimate
 * reason to send one — the only caller passes `window.location.origin`.
 */
export function isAllowedAuthOrigin(candidate: string | null | undefined): boolean {
  if (!candidate) return false;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }

  if (url.username || url.password) return false;
  if (url.pathname !== "/" && url.pathname !== "") return false;
  if (url.search || url.hash) return false;

  // `new URL` lowercases the host already; the second call is for the reader,
  // so nobody has to know that to trust the comparisons below.
  const host = url.hostname.toLowerCase();

  if (LOCAL_HOSTS.has(host)) return url.protocol === "http:" || url.protocol === "https:";

  // Everything that isn't the dev machine is TLS-only and on the default port.
  // Both are true of every host we actually deploy, and pinning them closes off
  // `http://taoslite.com` and `https://taoslite.com:8443` as return addresses.
  if (url.protocol !== "https:" || url.port !== "") return false;

  return EXACT_HOSTS.has(host) || PREVIEW_HOST.test(host);
}

/**
 * The vetted ORIGIN, and nothing else — scheme, host, no trailing slash.
 *
 * This is the shared half: the origin every caller starts from, whether it is
 * building a sign-in return address (below) or a Stripe `success_url` or a
 * /chat invite link. Anything unrecognized falls back to production rather
 * than being passed through: an unknown host is either a mistake or an attack,
 * and neither one should be handed a session — or a paying customer.
 *
 * Deliberately one function rather than a list per caller. An origin we would
 * not let Google drop a session on is not one we should bounce a customer
 * through either, and two allow-lists drift apart the first time one of them
 * gains a host.
 */
export function trustedOrigin(candidate: string | null | undefined): string {
  if (!isAllowedAuthOrigin(candidate)) return PRODUCTION_ORIGIN;
  // Return the PARSED origin, never the caller's string. `new URL` has already
  // normalized case, escapes and the default port, and the normalized form is
  // the one that was vetted a line ago.
  return new URL(candidate as string).origin;
}

/**
 * Where inside the app a sign-in may land. Only ever an absolute path on the
 * origin above — never a URL, never a host — because the origin is what was
 * vetted and the path is not allowed to move it. Anything else becomes "/".
 *
 * The character set is what an app route can actually contain, which today
 * means `/chat/join/<base64url token>`. No query and no fragment: Supabase
 * appends its own `?code=` to whatever it is handed, and a second one is how a
 * redirect target gets smuggled in.
 */
const INTERNAL_PATH = /^\/[A-Za-z0-9\-._~/]*$/;

function internalPath(path: string): string {
  if (!INTERNAL_PATH.test(path)) return "/";
  // `//host` is a URL to somebody else in every context that resolves it as a
  // reference. Appended to an origin it is only ever a path here — but this
  // value is also read by people, and one that LOOKS like an open redirect is
  // not worth the second reading.
  if (path.startsWith("//")) return "/";
  return path;
}

/**
 * The full URL Google sign-in should return to: the vetted origin, plus where
 * in the app to come back to.
 *
 * ── Why there is always a path ─────────────────────────────────────────────
 * This used to be `trustedOrigin` itself, returning a bare origin with no
 * trailing slash — and that one missing character was still sending preview
 * testers to production on 8/19, a day after the dashboard was edited. The
 * allow-list entries are patterns ending in `/**`, and Supabase matches them
 * against the whole URL, so an origin with no path matches nothing and
 * silently collapses to the Site URL. Asked directly:
 *
 *   https://taos-lite-git-feat-trip-mode-….vercel.app   -> https://taoslite.com/   ← the bug
 *   https://taos-lite-git-feat-trip-mode-….vercel.app/  -> itself                  ← one slash
 *
 * So a return address is now an origin AND a path, "/" by default. The second
 * argument is what /chat/join needs: an invite link opened by a signed-out
 * stranger has to come back to the invite, not to the home screen with the
 * token gone.
 *
 * Stripe's `success_url` and the /chat invite link keep calling `trustedOrigin`
 * directly — they append their own paths, and a slash from both ends is how
 * you get `//?checkout=success`.
 */
export function authRedirectTarget(candidate: string | null | undefined, path = "/"): string {
  return `${trustedOrigin(candidate)}${internalPath(path)}`;
}
