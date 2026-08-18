// The /translate pills are only as good as the server's allow-list: an output
// language missing from LANGUAGE_OPTIONS makes /api/translate answer
// "Unsupported language pair." (400) and the turn dies on the phone. These pin
// the four trip languages (8/17, Bosnia + Italy) and the guest languages that
// shipped before them.
import { describe, expect, it } from "vitest";
import { getLanguageLabel, isSupportedLanguageCode } from "@/lib/realtime/languages";

describe("supported languages behind the /translate pills", () => {
  it("accepts every language the pill row can select", () => {
    for (const code of ["en", "es", "bs", "it", "zh", "yue"]) {
      expect(isSupportedLanguageCode(code)).toBe(true);
    }
  });

  it("labels are the ones the prompts name to the model", () => {
    // buildInstructions / buildAutoDetectInstructions interpolate these into
    // the system prompt ("The speaker talks in Bosnian"), so a blank or
    // code-shaped label would quietly degrade the translation.
    expect(getLanguageLabel("bs")).toBe("Bosnian");
    expect(getLanguageLabel("it")).toBe("Italian");
  });

  it("rejects codes that are not configured", () => {
    // Bosnian's neighbours are NOT wired up — adding one means adding it to
    // LANGUAGE_OPTIONS and to the shell's SPEAKERS/STRINGS together.
    expect(isSupportedLanguageCode("sr")).toBe(false);
    expect(isSupportedLanguageCode("hr")).toBe(false);
  });
});
