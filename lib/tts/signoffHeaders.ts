// The two response headers of the share sign-off (lib/tts/shareSignoff.ts),
// in their own file so the home screen can read them without bundling the
// server's synthesis code.

/** Response header on a sign-off request: "1" when the file carries one. */
export const SIGNOFF_HEADER = "X-TAOS-Signoff";
/**
 * Response header on a home-screen line when the flag is on: "1" tells the
 * client a Share should ask for the signed version instead of reusing the
 * Play audio. It says nothing about tier — the route decides that on the
 * sign-off request itself.
 */
export const SIGNOFF_AVAILABLE_HEADER = "X-TAOS-Signoff-Available";
