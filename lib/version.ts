// Unobtrusive build marker so we can tell which deploy is live. Vercel injects
// the commit SHA at build time; falls back to "local" during dev.
//
// Lives here rather than in a component because two screens show it now — the
// /translate footer and /about. The process.env expression must stay literal:
// a computed key is invisible to Next's build-time replacement and would read
// as undefined in the browser bundle, printing "local" on production.
// 1.0.0 on 2026-08-19: the trip build (PR #24) is the first release handed to
// someone who is not Tom or Liz, so it gets a real version number rather than
// another decimal.
export const APP_VERSION = "1.0.0";

const BUILD_SHA = (process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7);

export const BUILD_LABEL = `v${APP_VERSION}${BUILD_SHA ? ` · ${BUILD_SHA}` : " · local"}`;
