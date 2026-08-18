// The tier-2 degrade, pinned once for the five screens that share it.
//
// /translate got this right first: ask the catalog before asking for audio,
// and when the answer is "text only" show the translation and stop. /chat,
// /live, /tabletop and /tutor each had their own fetch, and a tier-2 language
// reached them as a red error banner — which is the app apologizing for a
// limit of the language, not a fault of its own. requestSpeech is now the one
// road to /api/tts, so these tests are the fence for all five.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { isTextOnlyLanguage, requestSpeech, TEXT_ONLY_TITLE } from "@/lib/tts/speech";

function repoFile(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");
}

/** A fetch that records its calls and answers with whatever it's handed. */
function stubFetch(response: Response | (() => Response)) {
  return vi.fn(async () => (typeof response === "function" ? response() : response));
}

function audio(): Response {
  return new Response(new Blob([new Uint8Array([0xff, 0xfb])], { type: "audio/mpeg" }), {
    status: 200,
    headers: { "Content-Type": "audio/mpeg" }
  });
}

function textOnly422(): Response {
  // Verbatim from app/api/tts/route.ts — if that body ever changes shape, this
  // is the test that notices before a phone does.
  return new Response(JSON.stringify({ error: "This language is text only.", textOnly: true }), {
    status: 422,
    headers: { "Content-Type": "application/json" }
  });
}

describe("isTextOnlyLanguage — the question every screen asks first", () => {
  it("says yes only for a language the catalog knows it cannot speak", () => {
    // Thai and Hebrew: Whisper hears them, no ElevenLabs model says them.
    expect(isTextOnlyLanguage("th")).toBe(true);
    expect(isTextOnlyLanguage("he")).toBe(true);
    expect(isTextOnlyLanguage("fa")).toBe(true);
  });

  it("says no for the languages the household actually speaks", () => {
    for (const code of ["en", "es", "zh", "yue", "it", "bs"]) {
      expect(isTextOnlyLanguage(code), `${code} is tier 1`).toBe(false);
    }
  });

  it("keeps its opinion to itself when there is no language to have one about", () => {
    // Narrow on purpose, matching the server fence: absent or unrecognized is
    // "no opinion", not "text only". /tutor's drills carry no target language
    // and /chat reads its codes out of a database row — widening this to
    // !canSpeak() would silence both of them.
    expect(isTextOnlyLanguage(undefined)).toBe(false);
    expect(isTextOnlyLanguage(null)).toBe(false);
    expect(isTextOnlyLanguage("")).toBe(false);
    expect(isTextOnlyLanguage("xx")).toBe(false);
  });
});

describe("requestSpeech — a tier-2 language never reaches the network", () => {
  it("answers null without asking /api/tts anything", async () => {
    const fetchImpl = stubFetch(audio);
    const blob = await requestSpeech(
      { text: "ขอบคุณครับ", sourceLanguage: "en", targetLanguage: "th" },
      { fetch: fetchImpl }
    );
    // THE point of the whole change: no request, no wait, no error — and
    // therefore no cost, on a call that could only ever have failed.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(blob).toBeNull();
  });

  it("still calls for a tier-1 language, with the request the route expects", async () => {
    const fetchImpl = stubFetch(audio);
    const blob = await requestSpeech(
      { text: "gracias", sourceLanguage: "es", targetLanguage: "en", latency: "flash" },
      { fetch: fetchImpl }
    );
    expect(blob).toBeInstanceOf(Blob);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/tts");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      text: "gracias",
      sourceLanguage: "es",
      targetLanguage: "en",
      latency: "flash"
    });
  });

  it("asks anyway when nobody named a language", async () => {
    // /tutor speaks English drills through the OpenAI engine and sends no
    // language at all. That has to keep working.
    const fetchImpl = stubFetch(audio);
    expect(await requestSpeech({ text: "Where is the station?" }, { fetch: fetchImpl })).toBeInstanceOf(Blob);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)))
      .toEqual({ text: "Where is the station?" });
  });
});

describe("requestSpeech — a 422 from the route lands quietly", () => {
  it("treats textOnly:true as 'no audio', not as a failure", async () => {
    // Defense in depth for the stale client: a phone holding yesterday's
    // bundle after a tier flips asks for audio it shouldn't, and the answer
    // has to be the same silence rather than a banner.
    const fetchImpl = stubFetch(textOnly422);
    const blob = await requestSpeech(
      { text: "hello", sourceLanguage: "en", targetLanguage: "es" },
      { fetch: fetchImpl }
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(blob).toBeNull();
  });

  it("does not swallow a 422 that isn't about tiers", async () => {
    const fetchImpl = stubFetch(
      () => new Response(JSON.stringify({ error: "Nope." }), { status: 422 })
    );
    await expect(
      requestSpeech({ text: "hello", targetLanguage: "es" }, { fetch: fetchImpl })
    ).rejects.toThrow("Nope.");
  });
});

describe("requestSpeech — real failures still speak up", () => {
  it("throws the provider's own words when synthesis fails", async () => {
    const fetchImpl = stubFetch(
      () =>
        new Response(JSON.stringify({ error: "ElevenLabs TTS failed.", details: "quota" }), {
          status: 502
        })
    );
    await expect(
      requestSpeech({ text: "hola", targetLanguage: "en" }, { fetch: fetchImpl })
    ).rejects.toThrow("quota");
  });

  it("falls back to the caller's message when the server sends none", async () => {
    const fetchImpl = stubFetch(() => new Response("", { status: 500 }));
    await expect(
      requestSpeech(
        { text: "hola", targetLanguage: "en" },
        { fetch: fetchImpl, failureMessage: "No pudimos reproducir la voz." }
      )
    ).rejects.toThrow("No pudimos reproducir la voz.");
  });

  it("lets a dead connection through untouched, so 'Load failed' handling still fires", async () => {
    // TranslatorShell reads isConnectionError(e) off the thrown value to swap
    // in a human message; wrapping it here would break that.
    const boom = new TypeError("Load failed");
    const fetchImpl = vi.fn(async () => {
      throw boom;
    });
    await expect(
      requestSpeech({ text: "hola", targetLanguage: "en" }, { fetch: fetchImpl })
    ).rejects.toBe(boom);
  });
});

describe("the five screens all take the same road", () => {
  const SHELLS = [
    "components/TranslatorShell.tsx",
    "components/ChatShell.tsx",
    "components/LiveShell.tsx",
    "components/TabletopShell.tsx",
    "components/TutorShell.tsx"
  ];

  it("reaches /api/tts through requestSpeech and nowhere else", () => {
    // The four other screens each grew their own fetch, and that is exactly
    // how they ended up with four different answers to a text-only language.
    // A new direct call would be a fifth.
    for (const shell of SHELLS) {
      const source = repoFile(shell);
      expect(source, `${shell} should route through requestSpeech`).toContain("requestSpeech");
      expect(source, `${shell} should not call /api/tts directly`).not.toMatch(
        /fetch(WithRetry)?\(\s*\n?\s*"\/api\/tts"/
      );
    }
  });

  it("says 'text only' in one voice", () => {
    // components/TextOnly.tsx is the only place the mark is drawn, so the
    // sheet, the pills, a /chat bubble and the /live voice button can't drift.
    expect(TEXT_ONLY_TITLE).toBe("Text only — no voice for this language · Solo texto");
    expect(repoFile("components/TextOnly.tsx")).toContain("Text only · Solo texto");
    for (const shell of SHELLS) {
      expect(repoFile(shell), `${shell} should not fork the string`).not.toContain(
        "no voice for this language"
      );
    }
  });
});
