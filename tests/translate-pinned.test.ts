// The pill row is the one control always on screen, so what it may and may not
// do is worth fencing: it must never grow past MAX_PILLS, must never drop the
// language the conversation is currently in, and must never reorder itself
// under someone's thumb mid-conversation.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECENT,
  MAX_PILLS,
  parseStoredRecent,
  RECENT_LIMIT,
  rememberLanguage,
  visiblePills
} from "@/lib/translate/pinned";
import { type PairLangCode } from "@/lib/translate/pair";

const pair = (a: PairLangCode, b: PairLangCode): readonly [PairLangCode, PairLangCode] => [a, b];

describe("which languages get a pill", () => {
  it("never shows more than MAX_PILLS of them", () => {
    // The whole point of the sheet: the catalog can grow to a hundred
    // languages and the row on screen cannot grow at all.
    const many: PairLangCode[] = ["fr", "de", "pt", "ja", "ko", "ru", "ar", "hi", "th", "pl"];
    expect(visiblePills(pair("en", "es"), many)).toHaveLength(MAX_PILLS);
    expect(visiblePills(pair("en", "es"), [])).toHaveLength(2);
  });

  it("leaves room for the \"+\" button on the same row", () => {
    // Five CONTROLS total, which is what the row held before this change.
    expect(MAX_PILLS).toBe(4);
  });

  it("always keeps the pair on the row", () => {
    // Even when recency is full of other languages: a row that couldn't show
    // the language you are speaking into would be lying about the app's state.
    const crowded: PairLangCode[] = ["fr", "de", "pt", "ja", "ko", "ru", "ar"];
    const pills = visiblePills(pair("bs", "sw"), crowded);
    expect(pills).toContain("bs");
    expect(pills).toContain("sw");
    expect(pills).toHaveLength(MAX_PILLS);
  });

  it("fills the rest from recency, most recent first", () => {
    // Two slots left after the pair; the three oldest recents lose out.
    const pills = visiblePills(pair("en", "es"), ["it", "bs", "fr", "de", "ja"]);
    expect(pills).toContain("it");
    expect(pills).toContain("bs");
    expect(pills).not.toContain("fr");
    expect(pills).not.toContain("de");
    expect(pills).not.toContain("ja");
  });

  it("never shows the same language twice", () => {
    // The pair's languages are normally in recency too — that overlap must
    // cost a slot once, not twice.
    const pills = visiblePills(pair("en", "es"), ["es", "en", "it", "bs"]);
    expect(new Set(pills).size).toBe(pills.length);
    expect(pills).toEqual(["en", "es", "it", "bs"]);
  });

  it("draws them in catalog order, not recency order", () => {
    // THE anti-shuffle rule. Same working set reached in two different
    // orders has to land on screen identically, or a pill moves under a
    // thumb between two turns of a live conversation.
    const a = visiblePills(pair("en", "es"), ["bs", "it"]);
    const b = visiblePills(pair("es", "en"), ["it", "bs"]);
    expect(a).toEqual(b);
    // en(1) and es(2) are ranked, it(11) is ranked lower, bs is unranked and
    // sorts after all of them.
    expect(a).toEqual(["en", "es", "it", "bs"]);
  });

  it("puts a newly picked language in its catalog slot, not on the end", () => {
    // Picking French does not push it to the front of the row; it lands
    // between the languages it belongs between, and nothing else moves.
    // The real flow: Liz is on ES⇄EN with the trip row remembered, then Tom
    // taps French out of the sheet — which becomes the output AND the newest
    // thing in recency, exactly as selectLanguage does it in the shell.
    const recent: PairLangCode[] = ["es", "en", "bs", "it"];
    const before = visiblePills(pair("es", "en"), recent);
    const after = visiblePills(pair("en", "fr"), rememberLanguage(recent, "fr"));
    expect(before).toEqual(["en", "es", "it", "bs"]);
    // French lands in its catalog slot — between es and bs, not on the end —
    // and Italian, the least recently used of the four, is what falls off to
    // make room. Everything that stays, stays where it was.
    expect(after).toEqual(["en", "es", "fr", "bs"]);
  });
});

describe("recency", () => {
  it("moves a language to the front without duplicating it", () => {
    expect(rememberLanguage(["bs", "it", "fr"], "it")).toEqual(["it", "bs", "fr"]);
    expect(rememberLanguage(["bs", "it"], "de")).toEqual(["de", "bs", "it"]);
  });

  it("remembers deeper than it shows, but not forever", () => {
    // Deeper than MAX_PILLS so a language pushed off the row comes back when
    // the pair moves, rather than needing the sheet again.
    expect(RECENT_LIMIT).toBeGreaterThan(MAX_PILLS);
    let recent: readonly PairLangCode[] = [];
    for (const code of ["en", "es", "bs", "it", "fr", "de", "pt", "ja", "ko", "ru", "ar", "hi",
      "th", "pl", "nl"] as PairLangCode[]) {
      recent = rememberLanguage(recent, code);
    }
    expect(recent).toHaveLength(RECENT_LIMIT);
    expect(recent[0]).toBe("nl");
    expect(recent).not.toContain("en"); // the oldest fell off
  });
});

describe("what survives on a phone", () => {
  it("reads back a saved row", () => {
    expect(parseStoredRecent(JSON.stringify(["it", "bs", "en"]))).toEqual(["it", "bs", "en"]);
  });

  it("treats missing or corrupt storage as nothing saved", () => {
    expect(parseStoredRecent(null)).toBeNull();
    expect(parseStoredRecent("")).toBeNull();
    expect(parseStoredRecent("not json")).toBeNull();
    expect(parseStoredRecent(JSON.stringify({ recent: ["en"] }))).toBeNull();
    expect(parseStoredRecent(JSON.stringify([]))).toBeNull();
    expect(parseStoredRecent(JSON.stringify(["xx", "nonsense"]))).toBeNull();
  });

  it("drops a bad entry instead of the whole row", () => {
    // One code from an older build should cost one pill, not send the phone
    // back to the defaults with the rest of a good list sitting right there.
    expect(parseStoredRecent(JSON.stringify(["it", "xx", "bs"]))).toEqual(["it", "bs"]);
    expect(parseStoredRecent(JSON.stringify(["it", "it", "bs"]))).toEqual(["it", "bs"]);
  });

  it("starts a fresh phone on the row the trip shipped with", () => {
    // Opening the app after this change should look like it did before it.
    expect(DEFAULT_RECENT).toEqual(["en", "es", "bs", "it"]);
    expect(visiblePills(["es", "en"], DEFAULT_RECENT)).toEqual(["en", "es", "it", "bs"]);
  });
});
