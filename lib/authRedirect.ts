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
 * The origin Google sign-in should return to, given the origin the person is
 * actually on. Anything unrecognized falls back to production rather than being
 * passed through: an unknown host is either a mistake or an attack, and neither
 * one should be handed a session.
 */
export function authRedirectTarget(candidate: string | null | undefined): string {
  if (!isAllowedAuthOrigin(candidate)) return PRODUCTION_ORIGIN;
  // Return the PARSED origin, never the caller's string. `new URL` has already
  // normalized case, escapes and the default port, and the normalized form is
  // the one that was vetted a line ago.
  return new URL(candidate as string).origin;
}
