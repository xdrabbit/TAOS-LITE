// Unobtrusive build marker so we can tell which deploy is live. Vercel injects
// the commit SHA at build time; falls back to "local" during dev.
//
// Lives here rather than in a component because two screens show it now — the
// /translate footer and /about. The process.env expression must stay literal:
// a computed key is invisible to Next's build-time replacement and would read
// as undefined in the browser bundle, printing "local" on production.
export const APP_VERSION = "0.4";

const BUILD_SHA = (process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7);

export const BUILD_LABEL = `v${APP_VERSION}${BUILD_SHA ? ` · ${BUILD_SHA}` : " · local"}`;
