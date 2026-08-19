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
//   under the row -> the language THEY read             (theyReadLine, partnerChip)
//   the composer  -> what happens to what I type        (outgoingLine)
//   first tap     -> why my tap didn't change my output (CHAT_READ_HINT)
//   every tap     -> proof, in the language just picked (readConfirmation)
//   my own bubble -> whose the grey line under it is    (CHAT_THEY_SEE_PREFIX)
//
// Tom, 8/19 again, after all of the above shipped: "Spanish stays selected no
// matter what I select." Third misread of the same row. The screenshot says
// why — HI filled, ES outlined next to it, a grey Spanish line under his own
// bubbles, and not one incoming message in the thread. Every word on that
// screen was true and none of them CHANGED when he tapped, because in a solo
// thread his reading language has nothing to translate. So the last four
// exports below stop describing the setting and start showing it: a sentence
// in the new script the instant it is picked, a caption that hands the grey
// line to its owner, and a partner language that is a badge instead of a
// second lit-up pill.
//
// Bilingual throughout, "English · Español" per the app's convention, because
// both people in a thread are looking at the same screen layout in different
// languages.
import {
  languageFlag,
  languageLabel,
  languageLabelEs,
  languageNative,
  type LanguageCode
} from "@/lib/languages/catalog";
import { readConfirmationNative } from "@/lib/languages/readConfirmation";

/** Caption over /chat's pill row and its sheet. NOT "translate into". */
export const CHAT_READ_CAPTION = "You read in · Lees en";

/** Badge on the partner's pill/row entry. It is theirs; a tap does not flip. */
export const CHAT_PARTNER_LABEL = "Theirs · Suyo";

/**
 * The partner's language as a flag-and-code CHIP, to sit on the "They read"
 * line. Not a pill and not a button — a `<span>` the shell cannot make
 * tappable, which is the entire point of it.
 *
 * It used to be an OUTLINED PILL, in my own "You read in" row, one gap away
 * from my filled one. On the pair screens that outline means "your side, tap
 * to flip"; here it meant "not yours at all", and two lit pills in one row
 * read as two selections however they are shaded. That is what Tom saw when he
 * said Spanish stays selected no matter what he selects — it does, because it
 * is Liz's and it was never his row's to change. So the row now holds exactly
 * one marked pill (mine), and the partner's language moves down to the line
 * that was already saying whose it is.
 *
 * Note the partner's language keeps its plain pill in the row: reaching for
 * "let me read Spanish too" is a real thing to want and stays one tap away.
 * What it loses is the marking that made it look chosen.
 */
export function partnerChip(partnerLang: LanguageCode | null): string {
  if (!partnerLang) return "";
  return `${languageFlag(partnerLang)} ${partnerLang.toUpperCase()}`;
}

/**
 * The prefix on the grey line under MY OWN bubbles — the recipient preview.
 *
 * That line is the translation my message was delivered as, and uncaptioned it
 * reads as my own output in a language I did not pick, which is the misreading
 * in its purest form: Tom sees Spanish under a message he wrote in English
 * with HI selected, and concludes the app ignored him. Two words fix it, and
 * they have to be on EVERY bubble — a one-time note at the top of the thread
 * is not on screen at the moment the eye lands on the grey text.
 */
export const CHAT_THEY_SEE_PREFIX = "They see · Ellos ven:";

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

// ── The confirmation ───────────────────────────────────────────────────────
// What happens the instant a language is tapped. Everything else in this file
// is a description of the setting; this is the setting, rendered.
//
// Three lines, in this order, because that is the order of the questions:
//   native — a sentence in the language just picked. Unfakeable: no label can
//            put Devanagari on the screen, and only a real change can.
//   frame  — the same thing in English · Español, so the sentence above is
//            never a wall for the person who just picked a language they are
//            still learning (or picked one by accident and needs the way out).
//   detail — what it MEANS for the messages, which is the part a solo tester
//            has to be told, because in an empty thread it means nothing
//            visible at all.

export interface ReadConfirmation {
  /** The proof: one sentence, in the language just chosen. */
  native: string;
  /** The same sentence in the app's two framing languages. */
  frame: string;
  /** Which messages this changes — or that there are none of them yet. */
  detail: string;
}

/**
 * The confirmation for a language the user just picked.
 *
 * `incomingCount` is messages FROM THE PARTNER, not messages in the thread.
 * Tom's thread had plenty of bubbles and every one of them was his own, so
 * "there are messages here" would have been true and useless: his reading
 * language only ever rewrites THEIR half. Zero incoming is the state that has
 * now burned him three times, and it is the default state of every chat a QR
 * code has ever opened — someone alone in a thread, testing, waiting for proof
 * that nothing in the thread can give them.
 */
export function readConfirmation(
  code: LanguageCode,
  { incomingCount }: { incomingCount: number }
): ReadConfirmation {
  const native = languageNative(code);
  // Spanish writes its language names lowercase — "ahora lees en hindi", not
  // "en Hindi" — and labelEs is capitalized for the picker's list.
  const es = languageLabelEs(code).toLocaleLowerCase("es");
  return {
    native: readConfirmationNative(code),
    frame: `You now read in ${languageLabel(code)} · Ahora lees en ${es}`,
    detail:
      incomingCount === 0
        ? `Nothing to translate yet — messages FROM them will appear in ${native} · ` +
          `Aún no hay mensajes de ellos — sus mensajes aparecerán en ${native}`
        : `Messages sent to you will appear in ${native} · ` +
          `Los mensajes que te envíen aparecerán en ${native}`
  };
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
