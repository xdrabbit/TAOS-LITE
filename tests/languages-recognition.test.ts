// The browser's SpeechRecognition wants BCP-47; every other id in the app is
// Whisper's. /live's on-device engine is the only place the two meet, and a
// wrong tag there does not error — the recognizer just transcribes the wrong
// language, or the page's, which reads exactly like a broken microphone.
import { describe, expect, it } from "vitest";
import { LANGUAGES } from "@/lib/languages/catalog";
import { recognitionTag } from "@/lib/languages/recognition";

describe("recognition tags", () => {
  it("keeps the two the app started with", () => {
    expect(recognitionTag("es")).toBe("es-ES");
    expect(recognitionTag("en")).toBe("en-US");
  });

  it("fixes the codes Whisper and BCP-47 genuinely disagree on", () => {
    // Javanese: Whisper says "jw", BCP-47 says "jv".
    expect(recognitionTag("jw")).toBe("jv-ID");
    // Tagalog is what the phones call Filipino.
    expect(recognitionTag("tl")).toBe("fil-PH");
    // Cantonese needs its script or it is nothing.
    expect(recognitionTag("yue")).toBe("yue-Hant-HK");
    // Whisper's "no" is Bokmål in practice.
    expect(recognitionTag("no")).toBe("nb-NO");
  });

  it("passes an unmapped language through rather than blanking it", () => {
    // A browser handed a tag it does not know picks a default; a browser
    // handed "" transcribes the page's language into a summary nobody asked
    // for. Pass-through is the safe half of that trade.
    expect(recognitionTag("bs")).toBe("bs");
    expect(recognitionTag("definitely-not-a-language")).toBe("definitely-not-a-language");
  });

  it("answers something usable for every language in the catalog", () => {
    for (const language of LANGUAGES) {
      const tag = recognitionTag(language.code);
      expect(tag.trim()).not.toBe("");
      // Either the code itself or a region/script-qualified form of it —
      // never some other language's tag.
      expect(tag === language.code || tag.includes("-")).toBe(true);
    }
  });
});
