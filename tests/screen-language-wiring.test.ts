// A fence around the thing this change was actually for: no screen may keep
// its own idea of which languages exist.
//
// Every one of these screens got here by hard-coding a pair — a Record keyed
// by "es-en", a useState<Lang>("es"), a { en: "English", es: "Spanish" } table
// — and each of those was invisible until someone on a trip tapped a language
// and got nothing. The tests below read the source and check for their return,
// because that is the only way to catch a THIRD copy of the pill row or a
// FOURTH label table before it ships.
//
// Source-reading tests are blunt and they will occasionally be wrong about
// intent. When one fails, the question to ask is "did a language ceiling just
// come back?" — if the answer is genuinely no, move the line, don't delete
// the test.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The screens that must reach the whole catalog.
 *
 * Two of these are called Translate and they are NOT the same screen — which
 * is most of how the second one got missed. `translate` is the home screen's
 * spoken turns (components/TranslatorShell.tsx); `typeTranslate` is the typing
 * surface behind the "Translate" nav pill (components/TranslateShell.tsx). The
 * 8/18 wiring did /live, /tabletop and /chat, the name scrub did the copy on
 * both, and nobody noticed the typing surface still held a two-language table
 * until Tom walked it on a phone. Every screen with a picker is listed here
 * now, so the next one to grow a private pair fails this file instead of a
 * trip.
 */
const SCREENS = {
  translate: "components/TranslatorShell.tsx",
  typeTranslate: "components/TranslateShell.tsx",
  live: "components/LiveShell.tsx",
  tabletop: "components/TabletopShell.tsx",
  chat: "components/ChatShell.tsx",
  /**
   * The one this file was written about, added late and on purpose.
   *
   * When the catalog landed (1711a3f4) /live, /tabletop and /chat were wired
   * to it and /call was NOT — it kept `type TargetLang = "en" | "es"` and a
   * two-name lookup table, so a pair of [en, it] got interpreted into
   * Spanish. Nobody noticed because /call was founders-only and then dark.
   * The screen is back on 2026-08-27 and it is listed here, which means it
   * has to keep passing every rule below like everyone else.
   */
  call: "components/CallShell.tsx"
} as const;

/** Server-side language plumbing behind those screens. */
const ROUTES = {
  liveRealtime: "app/api/live/realtime/route.ts",
  liveTranslate: "app/api/live-translate/route.ts",
  tabletopRealtime: "app/api/tabletop/realtime/route.ts",
  chatSend: "app/api/chat/send/route.ts",
  chatVoice: "app/api/chat/voice/route.ts",
  textTranslate: "app/api/text-translate/route.ts",
  callRealtime: "app/api/call/realtime/route.ts"
} as const;

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

/**
 * Source with its commentary removed. The comments in these files talk about
 * the very literals being banned ("this used to be an es-en string"), and
 * that history is worth keeping — so it is the CODE that gets checked.
 */
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

describe("no screen keeps its own language pair", () => {
  it("has no direction strings left in the streaming screens", () => {
    // "es-en" / "en-es" were the keys of /live's DIRECTIONS + TTS_LANGS and
    // /tabletop's TabletopDirection. Every one of them was a two-language
    // ceiling with a table hanging off it.
    // The typing surface is here for the same reason and was found late: its
    // DIRECTIONS Record keyed by "en-es" carried a label AND a placeholder,
    // so the ceiling was three deep in one table.
    for (const path of [SCREENS.live, SCREENS.tabletop, SCREENS.typeTranslate, SCREENS.call]) {
      expect(code(path)).not.toMatch(/["']es-en["']|["']en-es["']/);
    }
  });

  it("has no direction strings left in the route the typing surface calls", () => {
    // /api/text-translate answered in "en-es" | "es-en" and interpolated its
    // own { es: "Spanish", en: "English" }. Fixing the SCREEN alone would have
    // left the pair stopping at the network boundary.
    const src = code(ROUTES.textTranslate);
    expect(src).not.toMatch(/["']es-en["']|["']en-es["']/);
    expect(src).not.toContain("LANG_LABEL");
    expect(src).toContain("languageLabel(");
  });

  it("has no BCP-47 recognition tags written into the shell", () => {
    // /live's DIRECTIONS carried "es-ES" and "en-US" directly. The mapping is
    // lib/languages/recognition.ts now, for all hundred.
    expect(code(SCREENS.live)).not.toMatch(/["'](?:es-ES|en-US)["']/);
  });

  it("has no {en, es} label tables in the chat routes", () => {
    // Both routes had `const LANG_LABEL = { en: "English", es: "Spanish" }`
    // with a fall-through to the raw code, so an Italian thread asked the
    // model to "translate into it".
    for (const path of [ROUTES.chatSend, ROUTES.chatVoice]) {
      expect(code(path)).not.toContain("LANG_LABEL");
      expect(code(path)).toContain("languageLabel(");
    }
  });

  it("does not name English and Spanish in the voice transcription hint", () => {
    // The hint used to say "possibly mixing English and Spanish" for every
    // thread — naming languages nobody present speaks invites the transcriber
    // to use one of them.
    expect(code(ROUTES.chatVoice)).not.toContain("mixing English and Spanish");
  });
});

describe("every screen draws the SAME picker", () => {
  it("imports the shared pill row and sheet — nobody forks it", () => {
    for (const path of Object.values(SCREENS)) {
      const src = code(path);
      expect(src).toContain("LanguagePillRow");
      expect(src).toContain("LanguageSheet");
      expect(src).toMatch(/from "\.\/LanguagePicker"/);
    }
  });

  it("keeps the picker's drawing in exactly one file", () => {
    // A second `function LanguagePill(` anywhere is the beginning of the
    // drift this file exists to prevent.
    for (const path of Object.values(SCREENS)) {
      expect(code(path)).not.toMatch(/function LanguagePill\b/);
      expect(code(path)).not.toMatch(/function LanguageSheet\b/);
    }
  });
});

describe("the pair screens share one pair", () => {
  it("/translate, /live, /tabletop and /call all read the same hook", () => {
    // One pair on disk, one restore, one recency list. Three copies of the
    // restore effect is how you get a phone whose languages depend on which
    // screen you happened to open first.
    for (const path of [
      SCREENS.translate,
      SCREENS.typeTranslate,
      SCREENS.live,
      SCREENS.tabletop,
      SCREENS.call
    ]) {
      expect(code(path)).toContain("useLanguagePair");
    }
  });

  it("the typing surface asks pairDirection who is typing", () => {
    // The You/Them toggle keeps a real job — which SIDE is at the keyboard —
    // but it is not allowed to be the thing that knows the languages. A
    // toggle that sets a direction string instead of a PairSide is the old
    // bug growing back with different spelling.
    const src = code(SCREENS.typeTranslate);
    expect(src).toContain("pairDirection");
    expect(src).toContain("PairSide");
  });

  it("none of them reach past the hook to the storage helpers", () => {
    // writeStoredPair outside the hook means a second writer, and a second
    // writer is a pair that disagrees with itself across screens.
    for (const path of [
      SCREENS.translate,
      SCREENS.typeTranslate,
      SCREENS.live,
      SCREENS.tabletop,
      SCREENS.call
    ]) {
      expect(code(path)).not.toContain("writeStoredPair");
      expect(code(path)).not.toContain("readStoredPair");
    }
  });

  it("/chat keeps its language in the thread, not the phone", () => {
    // Deliberately NOT the shared pair: a chat language belongs to the
    // membership row, because the person it matters to is on the other phone.
    const src = code(SCREENS.chat);
    expect(src).toContain("setMyChatLanguage");
    expect(src).not.toContain("useLanguagePair");
    // It does share the ROW, though — recents are the same working set.
    expect(src).toContain("visiblePills");
  });
});

describe("streaming screens ask the catalog before they ask for a voice", () => {
  it("/live and /tabletop both route audio through requestSpeech", () => {
    // The one road to /api/tts (lib/tts/speech.ts), which answers null rather
    // than an error for a tier-2 language. A screen with its own fetch is a
    // screen that shows a red banner for a language working as designed.
    for (const path of [SCREENS.live, SCREENS.tabletop, SCREENS.chat]) {
      expect(code(path)).toContain("requestSpeech");
      expect(code(path)).not.toMatch(/fetch\(\s*["']\/api\/tts["']/);
    }
  });

  it("the typing surface has no private road to /api/tts", () => {
    // It has no audio control at all today — the muted speaker on the shared
    // pill is the whole of what it says about tier 2. This is here so that if
    // one is ever added it goes through requestSpeech like the others, rather
    // than showing a red banner for a language working as designed.
    expect(code(SCREENS.typeTranslate)).not.toMatch(/fetch\(\s*["']\/api\/tts["']/);
  });

  it("both say 'text only' somewhere a person will see it", () => {
    expect(code(SCREENS.live)).toContain("TEXT_ONLY_TITLE");
    expect(code(SCREENS.tabletop)).toMatch(/TextOnlyNote|TEXT_ONLY_TITLE/);
  });
});

describe("/call carries the pair across two phones", () => {
  it("names languages through the catalog, never through a table of its own", () => {
    // The exact shape of the original sin: `target === "en" ? "English" :
    // "Spanish"` inside the mint route, with the pair stopping at the network
    // boundary even after the screen was fixed.
    const route = code(ROUTES.callRealtime);
    expect(route).not.toContain("TargetLang");
    expect(route).not.toMatch(/["']English["']|["']Spanish["']/);
    expect(code("lib/call/instructions.ts")).toContain("languageLabel(");
  });

  it("validates both ends against the catalog before either reaches the prompt", () => {
    const route = code(ROUTES.callRealtime);
    expect(route).toContain("isSupportedLanguageCode");
  });

  it("sends the pair on the wire, because the other end is a different phone", () => {
    // This is what made /call harder than the other three screens, and what
    // ENHANCEMENTS.md meant by "the handshake is the actual work, not the
    // picker": each phone holds its OWN pair and cannot see the other's. A
    // picker with no handshake is a screen that still guesses.
    const session = code("lib/call/session.ts");
    expect(session).toContain('"language"');
    expect(session).toContain("onPeerLanguage");
    expect(session).toContain("sendLanguage");
    const shell = code(SCREENS.call);
    expect(shell).toContain("onPeerLanguage");
    expect(shell).toContain("sendLanguage");
  });

  it("does not fall back to a hardcoded partner language", () => {
    // The fallback when the partner has not announced yet is `theirs` from
    // the local pair — a guess drawn from the catalog, not from this file.
    expect(code(SCREENS.call)).toContain("resolveCallDirection");
    expect(code(SCREENS.call)).not.toMatch(/["'](?:en|es)["']/);
  });

  it("has no private road to /api/tts", () => {
    // The interpreter speaks through requestSpeech (lib/tts/speech.ts) like
    // /live and /tabletop, which is what makes a tier-2 language come back as
    // quiet captions instead of a red banner.
    expect(code(SCREENS.call)).not.toMatch(/fetch\(\s*["']\/api\/tts["']/);
    expect(code("lib/call/interpreter.ts")).toContain("requestSpeech");
    expect(code("lib/call/interpreter.ts")).not.toMatch(/fetch\(\s*["']\/api\/tts["']/);
  });

  it("says 'text only' where a person will see it", () => {
    expect(code(SCREENS.call)).toContain("TEXT_ONLY_TITLE");
  });
});
