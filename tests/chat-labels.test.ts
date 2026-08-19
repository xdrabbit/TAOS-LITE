// The fence around WHOSE LANGUAGE IS WHOSE on /chat.
//
// /chat borrows the pill row from three screens where a pill means "translate
// INTO this". Its own pill means the opposite — the language coming in, to me
// — and for a while it was captioned "You write in · Escribes en", with a
// header underneath reading "<my language> → <their language>".
//
// Tom, 8/19: tapped PL expecting to send Polish, got Spanish (correct — Liz
// reads Spanish), with nothing on screen to explain it, under a header that
// told him he writes Polish. Nothing about the per-member model was wrong;
// every word around it was.
//
// So these tests hold the words. Some of them read the source, which is blunt
// — when one fails, ask "can a stranger still tell which language is theirs?"
// before moving a line.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CHAT_PARTNER_LABEL,
  CHAT_READ_CAPTION,
  CHAT_READ_HINT,
  CHAT_READ_HINT_KEY,
  CHAT_THEY_SEE_PREFIX,
  outgoingLine,
  partnerChip,
  readConfirmation,
  theyReadLine
} from "@/lib/chatLabels";
import { LANGUAGES, languageNative } from "@/lib/languages/catalog";
import { READ_CONFIRMATIONS } from "@/lib/languages/readConfirmation";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

/** Source with its commentary removed — the comments below quote the very
 *  strings being banned, and that history is worth keeping. */
function code(path: string): string {
  return read(path)
    // Block comments FIRST, then whatever braces a JSX comment left behind.
    // The other way round, `{/* … */}` and a doc comment three functions
    // apart pair up into one match and everything between them vanishes from
    // the source these tests are reading.
    .replace(/\/\*[\s\S]*?\*\//g, "") // block and doc comments
    .replace(/\{\s*\}/g, "") // the braces a JSX comment left behind
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line)) // whole-line comments
    .map((line) => line.replace(/\s+\/\/(?!\/).*$/, "")) // trailing comments
    .join("\n");
}

const SHELL = "components/ChatShell.tsx";
const PICKER = "components/LanguagePicker.tsx";
const CLIENT = "lib/chat.ts";

describe("the pill row says what it actually controls", () => {
  it("is captioned READ, never WRITE", () => {
    expect(CHAT_READ_CAPTION).toMatch(/read/i);
    expect(CHAT_READ_CAPTION).not.toMatch(/write/i);
    expect(CHAT_READ_CAPTION).not.toMatch(/escribes/i);
    // Bilingual, "English · Español", like every caption on every screen.
    expect(CHAT_READ_CAPTION).toContain(" · ");
    expect(CHAT_READ_CAPTION).toMatch(/lees/i);
  });

  it("captions the row AND the sheet behind it with the same words", () => {
    // Two taps deep into the same control is not the place to rename it.
    const src = code(SHELL);
    expect(src).toContain("caption={CHAT_READ_CAPTION}");
    expect(src.match(/caption=\{CHAT_READ_CAPTION\}/g)).toHaveLength(2);
    expect(src).not.toContain("You write in");
    expect(src).not.toContain("Escribes en");
  });

  it("marks the partner's language as theirs, in the sheet", () => {
    expect(CHAT_PARTNER_LABEL).toMatch(/theirs/i);
    expect(code(SHELL)).toContain("pairedLabel={CHAT_PARTNER_LABEL}");
  });

  it("leaves the pair screens' flip wording alone", () => {
    // pairedTitle is an override with a default, not a rename: /translate,
    // /live and /tabletop pass nothing and still say "tap to flip".
    const src = code(PICKER);
    expect(src).toContain('pairedTitle = "tap to flip"');
    expect(src).toContain("pairedTitle={pairedTitle}"); // row → pill
  });
});

describe("the recipient's language is on screen, sourced from THEM", () => {
  it("names the partner's language, in the partner's own words", () => {
    const line = theyReadLine("pl");
    expect(line).toContain(languageNative("pl")); // Polski
    expect(line).toMatch(/they read/i);
    expect(line).toMatch(/ellos leen/i);
  });

  it("says so plainly when there is nobody on the other end", () => {
    const line = theyReadLine(null);
    expect(line).toMatch(/no one else|nadie/i);
    expect(line).not.toContain("→");
  });

  it("is drawn from partnerLang, never from mine", () => {
    // The whole bug in one line: a recipient line computed from my own
    // language would agree with the pill row and be wrong on both counts.
    expect(code(SHELL)).toContain("theyReadLine(partnerLang)");
    expect(code(SHELL)).not.toContain("theyReadLine(myLang)");
  });

  it("takes partnerLang from the OTHER member's row", () => {
    // lib/chat.ts is where "theirs" comes from: the member of my thread who
    // is not me. Threads are two people today; a group would summarize in
    // theyReadLine, which is why it takes the language as an argument.
    const src = code(CLIENT);
    expect(src).toMatch(/user_id !== myUserId/);
    expect(src).toMatch(/partnerLang: partner\?\.lang \?\? null/);
  });
});

describe("the direction line no longer claims to know what I write", () => {
  it("names no source language — only where the message lands", () => {
    // "Polski → Español" was the header for a man who does not write Polish:
    // it was his READING language wearing the source slot. Nothing in /chat
    // detects the language of a draft (see app/api/chat/send/route.ts, which
    // hints the member language and translates whatever arrives), so the only
    // honest left side is "anything you write".
    const line = outgoingLine("es");
    expect(line).toContain(languageNative("es")); // Español, twice — both halves
    expect(line).not.toContain(languageNative("en"));
    expect(line).not.toContain(languageNative("pl"));
    expect(line).toMatch(/anything you write/i);
    expect(line).toMatch(/lo que escribas/i);
  });

  it("says nothing at all with nobody to send to", () => {
    expect(outgoingLine(null)).toBe("");
  });

  it("is the only direction the shell draws", () => {
    // The banned shape is the old one: a language name interpolated on the
    // left of an arrow. If a real detector ever lands, it belongs in
    // outgoingLine with the detected code passed in — not back in the JSX.
    const src = code(SHELL);
    expect(src).not.toMatch(/languageNative\(/);
    expect(src).toContain("outgoingLine(partnerLang)");
  });
});

describe("the first tap explains itself, once", () => {
  it("says which side of the thread the setting moves", () => {
    expect(CHAT_READ_HINT).toMatch(/YOU read/);
    expect(CHAT_READ_HINT).toMatch(/TÚ lees/);
    // …and that the other side is not mine to set.
    expect(CHAT_READ_HINT).toMatch(/their own phone/i);
    expect(CHAT_READ_HINT).toMatch(/su teléfono/i);
  });

  it("is remembered per phone and dismissible", () => {
    expect(CHAT_READ_HINT_KEY).toBe("taos.chat.readLangHintSeen");
    const src = code(SHELL);
    expect(src).toContain("hasSeenReadLangHint()");
    expect(src).toContain("rememberReadLangHint()");
    expect(src).toContain("setShowLangHint(false)"); // the ✕
    // Fired from the language tap itself — the moment the question arises.
    expect(src).toMatch(/selectMyLanguage[\s\S]{0,400}rememberReadLangHint\(\)/);
  });
});

describe("the partner's language is a badge, not a second selection", () => {
  // Tom, third misread: "Spanish stays selected no matter what I select." It
  // did — ES was the OUTLINED pill sitting in his own "You read in" row, one
  // gap from the filled HI. Two marked pills in a single-selection row are two
  // selections to everyone who has ever used a row of pills, and no tooltip
  // undoes that. The row is his alone now.
  it("hands the row no paired pill — only the sheet gets one", () => {
    const src = code(SHELL);
    // Two consumers of partnerLang-as-paired existed; exactly one survives,
    // and it is the sheet, where a hundred rows and a "Theirs" badge read as
    // information rather than as a choice already made.
    expect(src.match(/paired=\{partnerLang\}/g)).toHaveLength(1);
    expect(src).toMatch(/LanguageSheet[\s\S]{0,400}paired=\{partnerLang\}/);
    // The pill row's opening tag must not carry it.
    const row = src.match(/<LanguagePillRow[\s\S]*?\/>/);
    expect(row, "the shell still draws a pill row").toBeTruthy();
    expect(row![0]).not.toContain("paired");
    // And the title that only existed to explain the outlined pill is gone
    // with it, rather than left behind pointing at nothing.
    expect(src).not.toContain("pairedTitle");
  });

  it("puts it on the They-read line instead, non-interactive", () => {
    const chip = partnerChip("es");
    expect(chip).toContain("ES");
    expect(chip).toContain("\u{1F1EA}\u{1F1F8}"); // the flag, so it reads as a language
    expect(partnerChip(null)).toBe("");
    // A span, not a button: the shell cannot make it tappable by accident.
    const src = code(SHELL);
    expect(src).toMatch(/<span[^>]*>\s*\{partnerChip\(partnerLang\)\}/);
    expect(src).not.toMatch(/onClick=\{[^}]*partnerChip/);
    // Next to the line that already says whose it is.
    expect(src).toMatch(/theyReadLine\(partnerLang\)[\s\S]{0,600}partnerChip\(partnerLang\)/);
  });
});

describe("a language tap confirms itself IN that language", () => {
  // The one signal a label cannot fake. Tom read three correct captions and
  // still concluded nothing had changed; Devanagari appearing on screen is not
  // a claim about the setting, it is the setting.
  it("answers a Hindi tap in Devanagari", () => {
    const { native, frame } = readConfirmation("hi", { incomingCount: 3 });
    expect(native).toMatch(/[\u0900-\u097F]/); // Devanagari, not a promise of it
    expect(native).toContain(languageNative("hi"));
    expect(native).not.toMatch(/[A-Za-z]/); // no English hiding in the proof
    // …with the bilingual frame beside it, so a wrong tap is still escapable.
    expect(frame).toContain(" · ");
    expect(frame).toMatch(/you now read in Hindi/i);
    // Spanish lowercases its language names; the picker's labelEs is
    // capitalized for a list, so the sentence has to put it back down.
    expect(frame).toContain("Ahora lees en hindi");
  });

  it("has a sentence for every language in the catalog", () => {
    // Record<LanguageCode, string> already fails the BUILD on a missing row.
    // This says the same thing at test time, where the message is readable.
    const codes = LANGUAGES.map((l) => l.code).sort();
    expect(Object.keys(READ_CONFIRMATIONS).sort()).toEqual(codes);
    for (const c of codes) {
      const { native } = readConfirmation(c, { incomingCount: 1 });
      expect(native.trim().length, `${c} has no confirmation sentence`).toBeGreaterThan(0);
    }
    // And they are not one English sentence wearing a hundred codes.
    expect(new Set(Object.values(READ_CONFIRMATIONS)).size).toBe(codes.length);
  });

  it("fires on the tap itself, before the round trip", () => {
    // A confirmation that waits for the database is a spinner, and a spinner
    // is what the last two fixes already felt like.
    const src = code(SHELL);
    expect(src).toMatch(/selectMyLanguage[\s\S]{0,200}setConfirmedLang\(code\)/);
    expect(src).toMatch(/setConfirmedLang\(code\)[\s\S]{0,900}setMyChatLanguage\(/);
    // …and is taken back if the save failed, next to the rollback of the pill.
    expect(src).toMatch(/myLang: previous[\s\S]{0,200}setConfirmedLang\(null\)/);
  });

  it("lives in the thread, not in a toast that vanishes", () => {
    // It has to survive a glance away — the misreading happens when the eye
    // comes back to a screen that looks unchanged.
    const src = code(SHELL);
    expect(src).toContain("confirmation.native");
    expect(src).toContain("confirmation.frame");
    expect(src).toContain("confirmation.detail");
    expect(src).not.toMatch(/setTimeout\([^)]*setConfirmedLang/);
    // Drawn inside the scrolling message list, and scrolled to.
    expect(src).toMatch(/ref=\{listRef\}[\s\S]*confirmation\.native/);
    expect(src).toMatch(/\[messages, pending, confirmedLang\]/);
  });
});

describe("the solo tester is told why nothing moved", () => {
  // The state that has burned Tom three times and will burn every person a QR
  // code drops into an empty thread: alone, testing, with no message their
  // reading language could possibly have rewritten.
  it("says so when nothing has come FROM them", () => {
    const { detail } = readConfirmation("hi", { incomingCount: 0 });
    expect(detail).toMatch(/nothing to translate yet/i);
    expect(detail).toMatch(/messages FROM them/);
    expect(detail).toMatch(/aún no hay mensajes de ellos/i);
    expect(detail).toContain(languageNative("hi"));
  });

  it("promises the plain thing once they have written", () => {
    const { detail } = readConfirmation("hi", { incomingCount: 1 });
    expect(detail).not.toMatch(/nothing to translate/i);
    expect(detail).toMatch(/messages sent to you will appear in/i);
    expect(detail).toContain(languageNative("hi"));
    expect(detail).toContain(" · ");
  });

  it("counts THEIR messages, never the thread's", () => {
    // Tom's thread was full of bubbles and every one was his own. A count of
    // messages.length would have shown him the wrong line at the exact moment
    // the right one existed for him.
    const src = code(SHELL);
    expect(src).toMatch(/m\.sender_id !== thread\?\.myUserId/);
    expect(src).toContain("{ incomingCount }");
    expect(src).not.toMatch(/incomingCount: messages\.length/);
  });
});

describe("the grey line under my own bubble belongs to them", () => {
  it("is captioned, bilingually, as the recipient's view", () => {
    expect(CHAT_THEY_SEE_PREFIX).toMatch(/they see/i);
    expect(CHAT_THEY_SEE_PREFIX).toMatch(/ellos ven/i);
    expect(CHAT_THEY_SEE_PREFIX).toContain(" · ");
    // Not "you", not "translation" — the point is WHOSE it is.
    expect(CHAT_THEY_SEE_PREFIX).not.toMatch(/\byou\b/i);
  });

  it("is on every bubble of mine, and only mine", () => {
    // Once per thread is not enough: the caption has to be under the eye at
    // the moment it lands on Spanish text below an English message.
    const src = code(SHELL);
    expect(src).toMatch(/secondary \?[\s\S]{0,800}mine \?[\s\S]{0,200}CHAT_THEY_SEE_PREFIX/);
    // The incoming bubble's secondary line is the sender's own words, which
    // need no owner: captioning it "They see" would be exactly backwards.
    expect(src.match(/CHAT_THEY_SEE_PREFIX/g)).toHaveLength(2); // import + use
  });
});
