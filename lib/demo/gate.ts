// What /demo shows, decided in one pure function so the four answers are
// testable without a browser (tests/demo.test.ts).
//
//   disabled — TAOS_DEMO_ENABLED is off: "not enabled", to everybody
//   loading  — the Supabase session has not answered yet
//   sign-in  — flag on, nobody signed in: "Inicia sesión · Sign in", NOT a
//              dead end — a founder whose phone dropped its session must be
//              one tap from the demo, not stranded on "not enabled"
//   denied   — signed in, not a founder: bounced home, like /fast
//   open     — a founder: the demo
//
// The flag is checked first so a switched-off demo never asks anyone to
// sign in for a screen that will not open.

import { isFounder } from "@/lib/release";

export type DemoGateState = "disabled" | "loading" | "sign-in" | "denied" | "open";

export function demoGateState(input: {
  enabled: boolean;
  ready: boolean;
  email: string | null | undefined;
  signedIn: boolean;
}): DemoGateState {
  if (!input.enabled) return "disabled";
  if (!input.ready) return "loading";
  if (!input.signedIn) return "sign-in";
  return isFounder(input.email) ? "open" : "denied";
}
