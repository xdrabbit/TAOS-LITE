// One rule, one wording, on every CONVERSATIONAL surface.
//
// The Driver read all of the app's translation prompts side by side on 9/10
// and found each one describing the same job in its own words — "concept
// paraphrase" here, "faithful and complete" there, "capture the gist" on the
// screen a stranger meets first — and NONE of them saying the two things a
// Spanish speaker notices immediately: whether "let me see" comes out as the
// idiom or as the calque, and whether they are being addressed as tú or as
// usted.
//
// So the rule is one exported string, appended verbatim. This file is the
// fence: it pins WHERE it appears, where it deliberately does NOT, and the
// example sentence inside it — the "a ver" line is the whole rule in
// miniature and is the first thing a future edit would trim.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCallInterpreterInstructions } from "@/lib/call/instructions";
import { buildLiteralAutoInstructions, buildLiteralInstructions } from "@/lib/fast/prompt";
import { buildConceptInstructions, buildInterpreterInstructions } from "@/lib/live/instructions";
import { buildTurnInstructions } from "@/lib/tabletop/instructions";
import {
  buildAutoDetectInstructions,
  buildCaptionTranslationInstructions,
  buildInstructions,
  DEFAULT_REGISTER,
  MEANING_FIRST_RULE,
  registerLineFor
} from "@/lib/translate/prompts";
import { buildVisionInstructions } from "@/lib/vision/prompts";

const code = (path: string): string => readFileSync(path, "utf8");

// The load-bearing middle of the rule, without the register tail — so a
// surface carrying either register still matches.
const RULE_CORE = MEANING_FIRST_RULE().replace(registerLineFor(DEFAULT_REGISTER), "").trim();

describe("the rule itself", () => {
  it("says meaning-first, and says what that is NOT", () => {
    const rule = MEANING_FIRST_RULE();
    expect(rule).toContain("the way a fluent native speaker would say it");
    expect(rule).toContain("closest to the original meaning, no more and no less");
    // Both failure directions named: a calque on one side, a précis on the
    // other. /live summarizes on purpose and /fast is literal on purpose;
    // everything in between must be neither.
    expect(rule).toContain("Not word for word, not a summary");
    expect(rule).toContain("Keep every fact, name, number, and condition");
  });

  it("carries the natural-equivalent example verbatim", () => {
    // An abstract instruction ("use idiomatic equivalents") is the kind of
    // sentence a model agrees with and then ignores. The example is what
    // makes it operative — if this assertion is ever in the way, replace the
    // example with another one, don't delete it.
    expect(MEANING_FIRST_RULE()).toContain(
      `English "let me see" is Spanish "a ver", not "déjame ver"`
    );
  });

  it("states formality, in both registers", () => {
    expect(registerLineFor("tu")).toContain("familiar form (tú)");
    expect(registerLineFor("tu")).toContain("partners or friends");
    expect(registerLineFor("usted")).toContain("polite form (usted)");
    expect(registerLineFor("usted")).toContain("assume a stranger");
    expect(MEANING_FIRST_RULE()).toContain("Match the speaker's register");
  });

  it("defaults to usted — the app is handed to strangers", () => {
    // A kiosk, a counter, a receptionist. Being too formal with a friend is a
    // smile; being too familiar with a stranger is a mistake.
    expect(DEFAULT_REGISTER).toBe("usted");
    expect(MEANING_FIRST_RULE()).toBe(MEANING_FIRST_RULE("usted"));
    expect(MEANING_FIRST_RULE()).toContain("polite form (usted)");
  });
});

describe("the conversational surfaces all carry it", () => {
  it("home / and /try — BOTH tones", () => {
    for (const tone of ["casual", "detailed"] as const) {
      expect(buildInstructions("Spanish", "English", tone)).toContain(MEANING_FIRST_RULE());
    }
  });

  it("auto-detect — BOTH tones, the default direction on the home screen", () => {
    for (const tone of ["casual", "detailed"] as const) {
      const p = buildAutoDetectInstructions(
        { code: "en", label: "English" },
        { code: "es", label: "Spanish" },
        tone
      );
      expect(p).toContain(MEANING_FIRST_RULE());
    }
  });

  it("/call", () => {
    expect(buildCallInterpreterInstructions({ source: "it", target: "en" })).toContain(
      MEANING_FIRST_RULE()
    );
  });

  it("/call keeps its fall-behind concession, which the rule does not revoke", () => {
    // "Not a summary" and "compress the oldest material" both live in this
    // prompt on purpose: compression is what a live call costs when the
    // interpreter runs behind, not the default shape of a turn.
    const p = buildCallInterpreterInstructions({ source: "es", target: "en" });
    expect(p).toContain("compress the oldest material and translate the newest fully");
  });

  it("/tabletop live", () => {
    expect(buildTurnInstructions({ source: "en", target: "es" })).toContain(MEANING_FIRST_RULE());
  });

  it("/chat send and voice — with the FAMILIAR register", () => {
    // The one surface that knows who is on the other end: a private thread
    // between two partners. usted there would be a stranger's voice in a
    // love letter.
    for (const path of ["app/api/chat/send/route.ts", "app/api/chat/voice/route.ts"]) {
      const src = code(path);
      expect(src).toContain("MEANING_FIRST_RULE");
      expect(src).toContain(`MEANING_FIRST_RULE("tu")`);
      expect(src).not.toContain(`MEANING_FIRST_RULE("usted")`);
    }
  });

  it("/translate typed — at the default (polite) register", () => {
    const src = code("app/api/text-translate/route.ts");
    expect(src).toContain("MEANING_FIRST_RULE()");
    expect(src).not.toContain(`MEANING_FIRST_RULE("tu")`);
  });
});

describe("the surfaces that deliberately do NOT carry it", () => {
  it("/live stays a summarizer — that is its whole job", () => {
    // A rolling gist of a room, not an interpretation of one speaker's turn.
    // The Driver's 9/10 review left this alone on purpose; /live's separate
    // forced-flush problem is item E2, not this rule.
    expect(buildInterpreterInstructions("en", "es")).not.toContain(RULE_CORE);
    expect(buildConceptInstructions("en", "es")).not.toContain(RULE_CORE);
    expect(code("lib/live/instructions.ts")).not.toContain("MEANING_FIRST_RULE");
  });

  it("/fast stays literal by design", () => {
    // A sign, a street name, an address: word-level is the deliverable and a
    // "natural equivalent" would be exactly wrong.
    expect(buildLiteralInstructions("English", "Spanish")).not.toContain(RULE_CORE);
    expect(buildLiteralAutoInstructions("English", "Spanish")).not.toContain(RULE_CORE);
    expect(code("lib/fast/prompt.ts")).not.toContain("MEANING_FIRST_RULE");
  });

  it("/vision and /video are not conversations", () => {
    // Photo text and subtitles have no speaker, no register, and in the
    // subtitle case a line count that must survive the translation.
    expect(buildVisionInstructions(null)).not.toContain(RULE_CORE);
    expect(buildVisionInstructions({ code: "es", label: "Spanish" })).not.toContain(RULE_CORE);
    expect(buildCaptionTranslationInstructions("English", "Spanish")).not.toContain(RULE_CORE);
  });
});

describe("/try meets a stranger in detailed", () => {
  it("sends tone=detailed, the same as the home screen", () => {
    // It used to send "casual" — "capture the gist the way a close friend
    // would relay it" — to the one screen someone tries the app on before
    // they trust it.
    const src = code("components/AtomShell.tsx");
    expect(src).toContain(`form.append("tone", "detailed")`);
    expect(src).not.toContain(`form.append("tone", "casual")`);
  });

  it("the casual branch survives — the classic tabletop still sends it", () => {
    expect(buildInstructions("English", "Spanish", "casual")).toContain("CASUAL");
    expect(code("components/TabletopShell.tsx")).toContain(`form.append("tone", "casual")`);
  });
});

describe("the realtime bookends survive the longer prompt", () => {
  // /call and /tabletop put the output language first in caps and repeat it
  // last, because the model drifts otherwise. Inserting ~90 words in the
  // middle must not push either end off.
  it("/call still opens with OUTPUT LANGUAGE and closes with the REMINDER", () => {
    const p = buildCallInterpreterInstructions({ source: "it", target: "en" });
    expect(p.startsWith("OUTPUT LANGUAGE: English.")).toBe(true);
    expect(p.endsWith("REMINDER: your output language is English and ONLY English.")).toBe(true);
  });

  it("/tabletop still opens with OUTPUT LANGUAGE and closes with the REMINDER", () => {
    const p = buildTurnInstructions({ source: "en", target: "es" });
    expect(p.startsWith("OUTPUT LANGUAGE: Spanish.")).toBe(true);
    expect(p.endsWith("REMINDER: output Spanish text and ONLY Spanish text.")).toBe(true);
  });
});
