"use client";

import { copyFor } from "@/lib/chrome/copy";
import { useLanguagePair } from "@/lib/translate/useLanguagePair";

// The one way out. Tom, 2026-10-23: "a couple of screens are hard to figure
// out how to get out of — Table is one. Every screen needs the same color,
// different from the rest of the screen, that your eyes go to, that says this
// is how to get out."
//
// So it is ONE component, ONE look: solid green — the same emerald as TAP TO
// TALK, the app's "go" colour — dark text, a pill at least 44px tall. Every
// screen except home puts it first in its header row, top-left; /tabletop
// puts it first in the middle strip both readers share. It is a plain link:
// a screen that tears something down on the way out keeps doing that itself.
//
// The label follows the phone's owner, like the rest of the chrome
// (lib/chrome/copy.ts). A screen that already holds the pair passes `lang`;
// one that doesn't gets the same answer the pair hook would give it.
export function ExitHome({ lang }: { lang?: string }): JSX.Element {
  const { mine } = useLanguagePair();
  return (
    <a
      href="/"
      data-exit-home=""
      className="inline-flex min-h-[44px] shrink-0 items-center whitespace-nowrap rounded-full bg-emerald-400 px-4 text-sm font-semibold text-stone-950 transition active:scale-[0.98]"
    >
      {copyFor(lang ?? mine).home}
    </a>
  );
}
