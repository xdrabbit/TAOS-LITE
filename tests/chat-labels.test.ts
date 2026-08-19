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
  CHAT_PARTNER_PILL_TITLE,
  CHAT_READ_CAPTION,
  CHAT_READ_HINT,
  CHAT_READ_HINT_KEY,
  outgoingLine,
  theyReadLine
} from "@/lib/chatLabels";
import { languageNative } from "@/lib/languages/catalog";

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

  it("marks the partner's pill as theirs, not as a flip", () => {
    // The pair screens flip on a tap of your own side. On /chat the outlined
    // pill is the PARTNER's language and a tap moves my side onto it — a
    // legitimate thing to want, and a terrible thing to be told is a flip.
    expect(CHAT_PARTNER_PILL_TITLE).not.toMatch(/flip/i);
    expect(CHAT_PARTNER_LABEL).toMatch(/theirs/i);
    expect(code(SHELL)).toContain("pairedTitle={CHAT_PARTNER_PILL_TITLE}");
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
