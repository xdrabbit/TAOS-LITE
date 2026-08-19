// The words /chat puts around its language picker, kept pure so they can be
// fenced (tests/chat-labels.test.ts) — same reason buildInstructions and
// elevenLabsVoiceId live outside their routes.
//
// ── Why this file exists ───────────────────────────────────────────────────
// Every other screen's pill row means "TRANSLATE INTO": the solid pill is the
// language coming OUT. /chat borrows the same drawing for something that is
// almost the opposite — the solid pill is the language coming IN, to ME
// (taos_lite_chat_members.lang, what the send routes translate the PARTNER's
// messages into). It was captioned "You write in · Escribes en", which is not
// what the setting does and is a third meaning for one control.
//
// Tom, 8/19: tapped PL on /chat expecting to send Polish, got Spanish —
// correctly, because Liz reads Spanish — with nothing on screen to say so, and
// a header underneath reading "Polski → Español" for a man who does not write
// a word of Polish. So the strings below say out loud which language is whose:
//
//   the pill row  -> the language I READ                (CHAT_READ_CAPTION)
//   under the row -> the language THEY read             (theyReadLine)
//   the composer  -> what happens to what I type        (outgoingLine)
//   first tap     -> why my tap didn't change my output (CHAT_READ_HINT)
//
// Bilingual throughout, "English · Español" per the app's convention, because
// both people in a thread are looking at the same screen layout in different
// languages.
import { languageNative, type LanguageCode } from "@/lib/languages/catalog";

/** Caption over /chat's pill row and its sheet. NOT "translate into". */
export const CHAT_READ_CAPTION = "You read in · Lees en";

/** Badge on the partner's pill/row entry. It is theirs; a tap does not flip. */
export const CHAT_PARTNER_LABEL = "Theirs · Suyo";

/** Title on the partner's pill — the pair screens say "tap to flip" here, and
 *  on /chat a tap does something else entirely: it moves MY side onto their
 *  language, which is a legitimate thing to want and a terrible surprise. */
export const CHAT_PARTNER_PILL_TITLE = "their language · su idioma";

/**
 * The one-time note after the first language tap in a chat. It answers the
 * question the tap just raised — "I picked Polish, why is my message Spanish?"
 * — and it is the only place the whole model is stated in one breath.
 */
export const CHAT_READ_HINT =
  "This sets the language YOU read. They pick theirs on their own phone. · " +
  "Esto define el idioma que TÚ lees. Ellos eligen el suyo en su teléfono.";

export const CHAT_READ_HINT_KEY = "taos.chat.readLangHintSeen";

/**
 * The recipient's side, stated explicitly and sourced from THEIR saved
 * language — never from mine. Threads are two people today (lib/chat.ts takes
 * the one other member); a group would summarize here rather than anywhere
 * else, which is why the partner is a parameter and not a lookup.
 */
export function theyReadLine(partnerLang: LanguageCode | null): string {
  if (!partnerLang) {
    return "No one else in this chat yet · Todavía no hay nadie más en este chat";
  }
  const name = languageNative(partnerLang);
  return `They read: ${name} · Ellos leen: ${name}`;
}

/**
 * What happens to whatever I type, shown where I type it.
 *
 * THE LEFT SIDE IS NOT A LANGUAGE, AND THAT IS THE FIX. The old header
 * interpolated my own reading language there ("Polski → Español"), which
 * claimed to know a language I had never said I write. Nothing in /chat
 * detects the language of a draft, so the only honest left side is "whatever
 * you write" — and the right side, which IS knowable, is the promise that
 * matters: it comes out in theirs.
 */
export function outgoingLine(partnerLang: LanguageCode | null): string {
  if (!partnerLang) return "";
  const name = languageNative(partnerLang);
  return `Anything you write → ${name} · Lo que escribas → ${name}`;
}

// ── The hint's "once" ──────────────────────────────────────────────────────
// Browser-only and silent on failure, like the recency list's helpers: a phone
// that cannot persist (Safari private mode, SSR) should still work — it just
// sees the note again next time, which is the harmless direction to fail in.

export function hasSeenReadLangHint(): boolean {
  try {
    return window.localStorage.getItem(CHAT_READ_HINT_KEY) === "1";
  } catch {
    return false;
  }
}

export function rememberReadLangHint(): void {
  try {
    window.localStorage.setItem(CHAT_READ_HINT_KEY, "1");
  } catch {
    /* private mode — the note shows once more next time */
  }
}
