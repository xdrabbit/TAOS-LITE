// The copy on /about, kept pure so it can be fenced (tests/about-page.test.ts)
// — same reason lib/chatLabels.ts exists.
//
// ── Why this file reads the way it does ────────────────────────────────────
// /about used to be a signed personal dedication. TAOS is now handed to
// strangers by QR code, so on 8/19 Tom called it: the public page reads as a
// product, and the dedication moved to docs/backstory.md verbatim, held for a
// future "Our story" page. It was moved for being private, not for being
// wrong — do not delete it from the repo.
//
// The rule this file exists to hold: NO PERSONAL NAMES. Not Tom's, not Liz's,
// not in a signature, a title, or a meta description. A stranger scanning a
// code at a table is the reader. Bilingual "English · Español" per the app's
// convention, because both halves of that table read the same page.
import { LANGUAGES } from "@/lib/languages/catalog";

/** Derived, never typed by hand — the catalog is the only count that exists. */
export const LANGUAGE_COUNT = LANGUAGES.length;

/**
 * Where support mail goes. NOTE (8/19): this mailbox is not yet routed —
 * nothing in the repo, Stripe settings, or env defined a support address, so
 * this is the address TAOS now promises. It must be created and monitored
 * before the QR codes go out.
 */
export const SUPPORT_EMAIL = "support@taoslite.com";

export interface AboutCopy {
  /** BCP-47 tag, so the markup can label each half for screen readers. */
  readonly lang: "en" | "es";
  readonly heading: string;
  readonly body: string;
  readonly contactLabel: string;
  readonly contactHint: string;
}

export const ABOUT_EN: AboutCopy = {
  lang: "en",
  heading: "About TAOS",
  body: `TAOS is a real-time translation app for people who don't share a language. It interprets spoken conversation as it happens, carries written messages between two phones, and reads the text in a photo — a menu, a sign, a form. ${LANGUAGE_COUNT} languages, translated as text; the most widely spoken of them are also spoken back out loud.`,
  contactLabel: "Support",
  contactHint: "Questions, problems, or billing"
};

export const ABOUT_ES: AboutCopy = {
  lang: "es",
  heading: "Acerca de TAOS",
  body: `TAOS es una app de traducción en tiempo real para personas que no comparten un idioma. Interpreta la conversación hablada en el momento, lleva mensajes escritos entre dos teléfonos y lee el texto de una foto — un menú, un letrero, un formulario. ${LANGUAGE_COUNT} idiomas, traducidos como texto; los más hablados también se pronuncian en voz alta.`,
  contactLabel: "Soporte",
  contactHint: "Dudas, problemas o facturación"
};

export const ABOUT_COPY: readonly AboutCopy[] = [ABOUT_EN, ABOUT_ES];

/** Page title and meta description — the two places the old name lingered. */
export const ABOUT_TITLE = "About TAOS · Acerca de TAOS";
export const ABOUT_DESCRIPTION = `TAOS is a real-time translation app: spoken conversation, chat, and photo translation in ${LANGUAGE_COUNT} languages.`;
