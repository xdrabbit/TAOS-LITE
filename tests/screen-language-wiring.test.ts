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

/** The screens that must reach the whole catalog. */
const SCREENS = {
  translate: "components/TranslatorShell.tsx",
  live: "components/LiveShell.tsx",
  tabletop: "components/TabletopShell.tsx",
  chat: "components/ChatShell.tsx"
} as const;

/** Server-side language plumbing behind those screens. */
const ROUTES = {
  liveRealtime: "app/api/live/realtime/route.ts",
  liveTranslate: "app/api/live-translate/route.ts",
  tabletopRealtime: "app/api/tabletop/realtime/route.ts",
  chatSend: "app/api/chat/send/route.ts",
  chatVoice: "app/api/chat/voice/route.ts"
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
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "") // JSX comment blocks
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
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
    for (const path of [SCREENS.live, SCREENS.tabletop]) {
      expect(code(path)).not.toMatch(/["']es-en["']|["']en-es["']/);
    }
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
  it("/translate, /live and /tabletop all read the same hook", () => {
    // One pair on disk, one restore, one recency list. Three copies of the
    // restore effect is how you get a phone whose languages depend on which
    // screen you happened to open first.
    for (const path of [SCREENS.translate, SCREENS.live, SCREENS.tabletop]) {
      expect(code(path)).toContain("useLanguagePair");
    }
  });

  it("none of them reach past the hook to the storage helpers", () => {
    // writeStoredPair outside the hook means a second writer, and a second
    // writer is a pair that disagrees with itself across screens.
    for (const path of [SCREENS.translate, SCREENS.live, SCREENS.tabletop]) {
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

  it("both say 'text only' somewhere a person will see it", () => {
    expect(code(SCREENS.live)).toContain("TEXT_ONLY_TITLE");
    expect(code(SCREENS.tabletop)).toMatch(/TextOnlyNote|TEXT_ONLY_TITLE/);
  });
});
