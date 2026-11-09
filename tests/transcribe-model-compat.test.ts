import { afterEach, describe, expect, it, vi } from "vitest";
import { transcribeAudio, usesPluralLanguageHints } from "@/lib/translate/transcribe";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("successor transcription request shape", () => {
  it("gpt-transcribe uses plural language hints and its JSON response shape", async () => {
    let sent: FormData | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        sent = init?.body as FormData;
        return Response.json({ text: "Hola.", languages: [{ code: "es" }] });
      })
    );

    const text = await transcribeAudio(
      "test-key",
      new File([new Uint8Array([1, 2, 3])], "clip.webm", { type: "audio/webm" }),
      { model: "gpt-transcribe", languageCode: "es", sourceLabel: "Spanish" }
    );

    expect(text).toBe("Hola.");
    expect(sent?.get("model")).toBe("gpt-transcribe");
    expect(sent?.get("languages[]")).toBe("es");
    expect(sent?.get("language")).toBeNull();
    expect(String(sent?.get("prompt"))).toContain("Spoken Spanish");
  });

  it("keeps singular hints for Whisper and recognizes both successor names", () => {
    expect(usesPluralLanguageHints("whisper-1")).toBe(false);
    expect(usesPluralLanguageHints("gpt-transcribe")).toBe(true);
    expect(usesPluralLanguageHints("gpt-live-transcribe")).toBe(true);
  });
});
