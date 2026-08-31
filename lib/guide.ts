// The copy on /guide, kept pure so it can be fenced (tests/guide-page.test.ts)
// — same reason lib/about.ts and lib/chatLabels.ts exist.
//
// ── What this page is for ──────────────────────────────────────────────────
// /guide is the quick start handed to a group of travellers who have never
// seen the app: scan the code, read five short sections, be useful at dinner
// that night. It is linked from the QR share sheet on purpose, so the
// instructions travel with the code rather than being explained out loud each
// time, and from the storefront footer for anyone who lands there first.
//
// Three rules this file is under:
//
//   1. NO PERSONAL NAMES. Same rule as /about, same reason — a stranger who
//      scanned a code at a table is the reader. Not in copy, not in comments.
//   2. IT DESCRIBES THE SHIPPED UI, NOT THE INTENDED ONE. Every control named
//      below is quoted from the screen it lives on: "START LISTENING" from
//      components/LiveShell.tsx, "TAP TO TALK" from TabletopShell, "+ More ·
//      Más" from LanguagePicker, "Start a chat" from lib/chatInvite.ts. A
//      guide that renames things is worse than no guide, because the reader
//      trusts it and then cannot find the button. If a label changes, change
//      it here in the same PR.
//   3. NO SCREENSHOTS. They go stale silently and this page is read on a
//      phone over hotel wifi. Emoji and quoted labels instead.
//
// ── Bilingual, but not inline ──────────────────────────────────────────────
// The app's chrome convention is "English · Español" on one line, and this
// file keeps it for short things — headings, and labels that are ALREADY
// bilingual on screen ("Table · Mesa"). Paragraphs get the /about treatment
// instead: an `en` and an `es` field rendered as two stacked blocks per
// section. Two full sentences joined by a middot is unreadable on a phone,
// and the point of this page is that half the group reads the Spanish first.
import { LANGUAGES } from "@/lib/languages/catalog";

/** Derived, never typed by hand — the catalog is the only count that exists. */
export const LANGUAGE_COUNT = LANGUAGES.length;

/**
 * The free monthly translation allowance.
 *
 * It is QUOTAS.free.translations in lib/supabase.ts, and it is restated here
 * rather than imported because that module builds a Supabase browser client
 * at import time — this page renders on the server and has no business
 * starting an auth client to print a number. tests/guide-page.test.ts imports
 * both and fails the day the two drift, which is the actual risk: a guide
 * quoting a limit the app no longer enforces is how a reader learns to
 * distrust the rest of the page.
 */
export const FREE_TRANSLATIONS = 25;

/** Where /guide lives. One constant, because three surfaces link to it. */
export const GUIDE_PATH = "/guide";

/** The link label, on every surface that offers it. */
export const GUIDE_TITLE = "How to use TAOS · Cómo usar TAOS";

export const GUIDE_DESCRIPTION =
  "Quick start for TAOS: install it on your phone, the four ways to talk, photo translation, choosing languages, and what is free.";

/** A line of copy in both languages. */
export interface Bilingual {
  readonly en: string;
  readonly es: string;
}

/**
 * One item inside a section: an install step, a mode, a fact about languages.
 *
 * `label` is deliberately a single string rather than a Bilingual — it is the
 * control's name AS PRINTED ON THE SCREEN, which is sometimes English-only
 * ("START LISTENING") and sometimes already bilingual ("Table · Mesa").
 * Translating it would send the reader looking for a button that is not there.
 */
export interface GuideEntry {
  readonly icon: string;
  readonly label: string;
  readonly body: Bilingual;
  /** The tiny illustrative line under the paragraph — what it looks like in use. */
  readonly example?: Bilingual;
}

export interface GuideSection {
  readonly id: "install" | "modes" | "photo" | "languages" | "free";
  readonly heading: Bilingual;
  readonly intro?: Bilingual;
  readonly entries: readonly GuideEntry[];
  /** Small print under the section — the caveat that would clutter an entry. */
  readonly footnote?: Bilingual;
}

// ── 1. Install ─────────────────────────────────────────────────────────────
// Three steps, in the order a phone actually does them. The install step is
// two different sets of words because the platforms are genuinely different:
// Android fires `beforeinstallprompt` and the app shows its own Install
// button (components/InstallPrompt.tsx); iOS Safari has no such event and
// never will, so there the only path is Share → Add to Home Screen.
const INSTALL: GuideSection = {
  id: "install",
  heading: { en: "Get it on your phone", es: "Ponla en tu teléfono" },
  intro: {
    en: "Three steps, about a minute. There is nothing to download from an app store.",
    es: "Tres pasos, como un minuto. No hay nada que descargar de una tienda de apps."
  },
  entries: [
    {
      icon: "🌐",
      label: "taoslite.com",
      body: {
        en: "Open taoslite.com in your phone's browser — Safari on iPhone, Chrome on Android.",
        es: "Abre taoslite.com en el navegador de tu teléfono — Safari en iPhone, Chrome en Android."
      }
    },
    {
      icon: "🔑",
      label: "Continue with Google",
      body: {
        en: "Tap Continue with Google and pick your account. Free to start, no card.",
        es: "Toca Continue with Google y elige tu cuenta. Empezar es gratis, sin tarjeta."
      }
    },
    {
      icon: "📲",
      label: "Add to Home Screen · Añadir a inicio",
      body: {
        en: "Install it so it opens full screen, like any other app. On iPhone: tap Share, then Add to Home Screen. On Android: tap the Install button TAOS offers you, or open Chrome's ⋮ menu (three dots, top right) and choose Install app.",
        es: "Instálala para que abra en pantalla completa, como cualquier otra app. En iPhone: toca Compartir y luego Añadir a inicio. En Android: toca el botón Install que TAOS te ofrece, o abre el menú ⋮ de Chrome (tres puntos, arriba a la derecha) y elige Instalar app."
      }
    }
  ],
  footnote: {
    en: "It works in the browser too. Installing just makes it full screen and one tap away.",
    es: "También funciona en el navegador. Instalarla solo la hace pantalla completa y de un toque."
  }
};

// ── 2. The four modes ──────────────────────────────────────────────────────
// Named for what the nav says, which took some care:
//
// The header pill that reads "Translate" is the TYPING screen (/translate),
// not the microphone one. The microphone one is the screen the app opens on
// and has no nav entry, because it IS the app surface — the same fact
// tests/nav-completeness.test.ts records. So the first mode below is named
// for its button ("Speak · Hablar") rather than for a pill that would send
// the reader to the wrong screen, and the section footnote points at the
// typing pill by its real name so nobody thinks it is missing.
const MODES: GuideSection = {
  id: "modes",
  heading: { en: "Four ways to talk", es: "Cuatro formas de hablar" },
  intro: {
    en: "TAOS opens on the first one. The rest are buttons along the top of that screen — Translate, Live, Table, Chat — one tap each. The nine dots in the top right corner open a grid with every screen TAOS has, if you would rather see them all at once.",
    es: "TAOS abre en la primera. Las demás son botones arriba en esa misma pantalla — Translate, Live, Table, Chat — un toque cada uno. Los nueve puntos de la esquina superior derecha abren una cuadrícula con todas las pantallas, si prefieres verlas todas juntas."
  },
  entries: [
    {
      icon: "🎙️",
      label: "Speak · Hablar",
      body: {
        en: "The screen TAOS opens on, for a back-and-forth conversation. Tap the mic, say a whole thought, tap again — it comes back written on screen and spoken out loud in the other language. Then hand the phone over and they tap the same button.",
        es: "La pantalla con la que abre TAOS, para una conversación de ida y vuelta. Toca el micrófono, di una idea completa y toca otra vez — vuelve escrita en pantalla y en voz alta en el otro idioma. Luego pasa el teléfono y la otra persona toca el mismo botón."
      },
      example: {
        en: "Tap the mic, speak a full thought, tap again.",
        es: "Toca el micrófono, di una idea completa y toca otra vez."
      }
    },
    {
      icon: "👂",
      label: "Live",
      body: {
        en: "See what they are saying while they say it. Tap START LISTENING and short summaries appear as the room talks. This is the one for a dinner table you are not part of, a tour guide, a TV show — anyone you are listening to rather than talking with. Put in an earbud and it reads them to you.",
        es: "Ve lo que dicen mientras lo dicen. Toca START LISTENING y aparecen resúmenes cortos mientras la gente habla. Esta es para una mesa en la que no participas, un guía turístico, la tele — alguien a quien escuchas en vez de responder. Ponte un audífono y te los lee."
      },
      example: {
        en: "START LISTENING → the summaries keep coming until you tap STOP.",
        es: "START LISTENING → los resúmenes siguen hasta que tocas STOP."
      }
    },
    {
      icon: "🍽️",
      label: "Table · Mesa",
      body: {
        en: "Tap Table along the top. Lay the phone flat between the two of you: the screen splits, and the far half is upside-down so it reads the right way up from their side. Each half is in that person's own language. TAP TO TALK, TAP WHEN DONE, and it is the other person's turn.",
        es: "Toca Table arriba. Pon el teléfono plano entre los dos: la pantalla se divide, y la mitad de enfrente está al revés para que se lea bien desde su lado. Cada mitad está en el idioma de esa persona. TOCA PARA HABLAR, TOCA AL TERMINAR, y le toca a la otra persona."
      },
      example: {
        en: "Lay the phone flat between you.",
        es: "Pon el teléfono entre ustedes."
      }
    },
    {
      icon: "💬",
      label: "Chat · Chat",
      body: {
        en: "Texting across languages, on two phones. Tap Chat along the top, then Start a chat, and show them the QR code or send them the link. They scan it, sign in, and they are in. Everything you write arrives in their language and everything they write arrives in yours. The link works for one person and lasts 7 days.",
        es: "Mensajes entre idiomas, en dos teléfonos. Toca Chat arriba, luego Inicia un chat, y muéstrales el código QR o envíales el enlace. Lo escanean, inician sesión y ya están dentro. Todo lo que escribes llega en su idioma y todo lo que escriben llega en el tuyo. El enlace sirve para una sola persona y dura 7 días."
      },
      example: {
        en: "Start a chat → show the QR → they scan and join.",
        es: "Inicia un chat → muestra el QR → lo escanean y entran."
      }
    }
  ],
  footnote: {
    en: "The Translate pill at the top is a fifth way in: type instead of talking, with suggestions from things you have said before.",
    es: "El botón Translate de arriba es una quinta vía: escribe en vez de hablar, con sugerencias de cosas que ya has dicho."
  }
};

// ── 3. Photo ───────────────────────────────────────────────────────────────
// /vision's entry point is the LAUNCHER — the nine dots top right — not a
// header pill and not the avatar beside it. Naming the wrong corner of the
// screen is the fastest way to lose a reader, so it is spelled out; this
// paragraph said "the round button with your initial in it" for a month after
// that button stopped having an initial in it, which is what the
// tests/guide-page.test.ts label fence is for.
const PHOTO: GuideSection = {
  id: "photo",
  heading: { en: "Point it at a menu", es: "Apúntala a un menú" },
  entries: [
    {
      icon: "📷",
      label: "Photo translator · Fotos",
      body: {
        en: "Tap the nine dots in the top right corner — All screens · Pantallas — then Photo translator · Fotos. Point the camera at a menu, a sign, a label, a form — or choose a photo you already took — and the words come back in your language. Nothing is kept.",
        es: "Toca los nueve puntos de la esquina superior derecha — All screens · Pantallas — y luego Photo translator · Fotos. Apunta la cámara a un menú, un letrero, una etiqueta, un formulario — o elige una foto que ya tomaste — y las palabras vuelven en tu idioma. No se guarda nada."
      },
      example: {
        en: "There is no language to set: it reads whatever the photo turns out to be.",
        es: "No hay idioma que elegir: lee lo que sea que resulte estar en la foto."
      }
    }
  ]
};

// ── 4. Languages ───────────────────────────────────────────────────────────
// The count comes from the catalog. The text-only fact is here because it is
// the one thing about the language list that surprises people, and meeting it
// on this page is better than meeting it as a Play button that does nothing
// (which is the same reasoning components/TextOnly.tsx is built on).
const LANGUAGES_SECTION: GuideSection = {
  id: "languages",
  heading: { en: "Choosing languages", es: "Elegir idiomas" },
  intro: {
    en: `The row of pills near the top of the screen is the language list — "Translate into · Traducir a". Tap one and that is what comes out.`,
    es: `La fila de botones cerca de la parte de arriba es la lista de idiomas — "Translate into · Traducir a". Toca uno y eso es lo que sale.`
  },
  entries: [
    {
      icon: "➕",
      label: "+ More · Más",
      body: {
        en: `The pills hold the languages you have been using. "+ More · Más" at the end of the row opens a search box with all ${LANGUAGE_COUNT} of them; pick one and it joins the row.`,
        es: `Los botones guardan los idiomas que has estado usando. "+ More · Más" al final de la fila abre un buscador con los ${LANGUAGE_COUNT}; elige uno y se suma a la fila.`
      }
    },
    {
      icon: "🔇",
      label: "Text only · Solo texto",
      body: {
        en: `Some languages are translated but not spoken aloud — there is no voice for them yet. Those are marked "Text only · Solo texto" in the list and again wherever a play button would have been, so you know before you tap.`,
        es: `Algunos idiomas se traducen pero no se pronuncian en voz alta — todavía no hay voz para ellos. Están marcados "Text only · Solo texto" en la lista y otra vez donde habría un botón de reproducir, para que lo sepas antes de tocar.`
      }
    }
  ],
  footnote: {
    en: "Whatever you pick carries across the app — the speaking screen, Live, Table and the photo translator all use the same two languages.",
    es: "Lo que elijas se usa en toda la app — la pantalla de hablar, Live, Mesa y el traductor de fotos usan los mismos dos idiomas."
  }
};

// ── 5. Free tier ───────────────────────────────────────────────────────────
// The number is imported (see FREE_TRANSLATIONS above) and the banner is
// quoted from components/TranslatorShell.tsx, so a reader can match the
// sentence here to the sentence on their own screen.
const FREE: GuideSection = {
  id: "free",
  heading: { en: "What is free", es: "Qué es gratis" },
  entries: [
    {
      icon: "🎁",
      label: "Free",
      body: {
        en: `Starting costs nothing: every screen is open, and you get ${FREE_TRANSLATIONS} translations a month. The counter sits at the top of the home screen and starts over on the 1st.`,
        es: `Empezar no cuesta nada: todas las pantallas están abiertas y tienes ${FREE_TRANSLATIONS} traducciones al mes. El contador está arriba en la pantalla principal y vuelve a empezar el día 1.`
      },
      example: {
        en: `"Free · ${FREE_TRANSLATIONS} translations left this month" — that banner is your count.`,
        es: `"Free · ${FREE_TRANSLATIONS} translations left this month" — ese aviso es tu cuenta.`
      }
    },
    {
      icon: "⬆️",
      label: "Upgrade",
      body: {
        en: "Upgrading lifts the limit: paid plans translate without a monthly cap. The Upgrade button is on that same banner.",
        es: "Mejorar el plan quita el límite: los planes de pago traducen sin tope mensual. El botón Upgrade está en ese mismo aviso."
      }
    }
  ]
};

export const GUIDE_SECTIONS: readonly GuideSection[] = [
  INSTALL,
  MODES,
  PHOTO,
  LANGUAGES_SECTION,
  FREE
];

/** The two languages the page renders, in order — mirrors lib/about.ts. */
export const GUIDE_LANGS = ["en", "es"] as const;
export type GuideLang = (typeof GUIDE_LANGS)[number];
