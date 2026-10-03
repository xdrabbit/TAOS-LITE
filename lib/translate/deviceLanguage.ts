// A first-time visitor's pair follows their phone (Tom, 2026-10-02).
//
// Before this, DEFAULT_PAIR put Spanish first for everybody, so a stranger
// opening TAOS for the first time sat in Spanish until they flipped their
// side. Now the SERVER reads the request's Accept-Language header and picks
// the starting pair from it — server-side on purpose: reading
// navigator.language in a client effect would render one language and then
// correct it, which is a hydration mismatch and a visible flash of the wrong
// language on first paint.
//
// ── What this is NOT allowed to do ─────────────────────────────────────────
// Override anybody's choice. This only seeds the pair a phone starts in when
// it has NOTHING stored; useLanguagePair's restore still runs at mount and a
// stored pair replaces this outright (tests/device-language.test.ts fences
// it). Tom and Liz both have stored pairs, so for them this file is inert.
//
// Kept pure — no next/headers import — so the tests can feed it raw headers
// and so the root layout is the only place that touches the request.

import { CHROME_LANGUAGES } from "@/lib/chrome/copy";
import { DEFAULT_PAIR, isPairLangCode, type PairLangCode } from "./pair";

// The languages a device can start in: the ones TAOS's own chrome is written
// in (lib/chrome/copy.ts — the table that used to be TranslatorShell's
// STRINGS). The pair itself can hold all hundred catalog languages, but a
// French phone dropped into [fr, en] would get English buttons around a
// French side it never picked; until somebody writes French chrome, a French
// phone starts where everyone did before.
export const DEVICE_LANGUAGES: readonly PairLangCode[] = CHROME_LANGUAGES.filter(isPairLangCode);

/**
 * The device's own language from an Accept-Language header: the primary
 * subtag of the highest-q entry, lowercased (`es-MX` → `es`). Only the TOP
 * preference — a phone set to French that also lists English is a French
 * phone. Null for a missing, empty or wildcard-only header.
 */
export function deviceLanguage(header: string | null | undefined): string | null {
  if (!header) return null;
  let best: { tag: string; q: number } | null = null;
  for (const part of header.split(",")) {
    const [rawTag, ...params] = part.trim().split(";");
    const tag = rawTag.trim().toLowerCase();
    if (!tag || tag === "*") continue;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.trim().split("=");
      if (key?.trim().toLowerCase() === "q") {
        const parsed = Number(value);
        q = Number.isFinite(parsed) ? parsed : 0;
      }
    }
    if (q <= 0) continue;
    // Strictly greater: on a tie the header's own order wins.
    if (!best || q > best.q) best = { tag, q };
  }
  if (!best) return null;
  return best.tag.split("-")[0] || null;
}

/**
 * The pair a phone with nothing stored starts in. `mine` is the device's
 * language; `theirs` is English, or Spanish for an English phone — so
 * Spanish and English phones both land in the EN⇄ES pair TAOS was built
 * around, each on their own side. Anything unsupported or missing gets
 * DEFAULT_PAIR, unchanged.
 */
export function pairForDevice(
  header: string | null | undefined
): readonly [PairLangCode, PairLangCode] {
  const code = deviceLanguage(header);
  const supported = DEVICE_LANGUAGES.find((l) => l === code);
  if (!supported || supported === DEFAULT_PAIR[0]) return DEFAULT_PAIR;
  return supported === "en" ? ["en", "es"] : [supported, "en"];
}
