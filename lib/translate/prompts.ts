// Pure helpers for the spoken-turn translation route (/api/translate),
// extracted so tests/translate-prompts.test.ts can fence in behavior the
// route promises: tone parsing, the faithfulness rules in the prompts, and
// which upstream transcription errors count as "nothing was heard".

export type Tone = "casual" | "detailed";

export function parseTone(value: FormDataEntryValue | null): Tone {
  return value === "detailed" ? "detailed" : "casual";
}

export function buildInstructions(sourceLabel: string, targetLabel: string, tone: Tone): string {
  const shared =
    `You are a live interpreter helping two people in a face-to-face conversation. ` +
    `The speaker talks in ${sourceLabel}. Render their meaning in natural, fluent ${targetLabel}. ` +
    `Speak in the FIRST PERSON as if you are the speaker — never narrate ("he says", "she is saying"). ` +
    `Do NOT translate word for word. Convey the concept, intent, and emotional tone. ` +
    `Output ONLY the ${targetLabel} translation: no preamble, no quotes, no notes, no language labels.`;

  if (tone === "detailed") {
    return (
      shared +
      ` This is an IMPORTANT conversation. Preserve every meaningful nuance, condition, number, name, ` +
      `and emotional weight. Be faithful and complete, but still natural and first-person. ` +
      `If the speaker rambles, organize the meaning clearly without losing detail.`
    );
  }

  return (
    shared +
    ` This is CASUAL conversation. Be warm, concise, and conversational. ` +
    `Capture the gist and feeling the way a close friend would relay it. Trim filler and repetition. ` +
    `Casual means relaxed DELIVERY, never loose MEANING: stay strictly faithful to what was ` +
    `actually said — never invent, guess, or substitute content, and when something is unclear, ` +
    `translate it as literally as needed rather than improvising.`
  );
}

export interface LanguageChoice {
  code: string;
  label: string;
}

// Auto-detect is scoped to the conversation's language PAIR (detecting among
// all 12 supported languages gets flaky; between 2 it stays sharp). The model
// decides which of the two the transcript is, then translates to the other.
export function buildAutoDetectInstructions(
  a: LanguageChoice,
  b: LanguageChoice,
  tone: Tone
): string {
  const toneLine =
    tone === "detailed"
      ? "This is an IMPORTANT conversation: preserve nuance, numbers, names, and emotion."
      : "This is CASUAL conversation: warm, concise, friend-style; trim filler. " +
        "Casual means relaxed delivery, never loose meaning — stay strictly faithful to what " +
        "was said; never invent or substitute content.";
  return (
    `The user's text is in either ${a.label} or ${b.label}. Detect which. ` +
    `Then render its MEANING in the OTHER language as a natural, FIRST-PERSON concept paraphrase ` +
    `(never word-for-word, never narrate "he says"). ${toneLine} ` +
    `Respond ONLY with JSON: {"lang":"${a.code}"|"${b.code}","translation":"<text in the other language>"}.`
  );
}

// A micro-clip (rapid double-tap) or a mangled upload comes back from the
// transcription API as one of these. They mean "no usable speech", not a
// server failure — the route maps them to its gentle bilingual retry message
// instead of surfacing raw provider JSON (7/23 field report).
export function isUnusableAudioError(message: string): boolean {
  return /corrupted or unsupported|could not be decoded|file is empty/i.test(message);
}
