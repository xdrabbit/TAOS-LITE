// Practice for lessons (tools/translations-viewer/lib/practice.mjs): hear it
// in Liz's voice, say it, get an Azure pronunciation score. No network here;
// the fixture is the REAL Azure REST answer captured for the tutor
// (lib/tutor/assessment.ts), because the shape the docs draw is not the shape
// the endpoint returns, and reading the wrong one showed "—" for a month.
import { describe, expect, it } from "vitest";

import {
  assessPronunciation,
  azureLocale,
  describeScoring,
  parseAssessment,
  speak
} from "@/tools/translations-viewer/lib/practice.mjs";

// Verbatim from the live westus2 resource, 2026-08-27 (scores FLAT on NBest).
const REAL_FLAT = {
  RecognitionStatus: "Success",
  DisplayText: "Necesito ayuda, por favor.",
  NBest: [
    {
      AccuracyScore: 88,
      FluencyScore: 94,
      CompletenessScore: 100,
      PronScore: 91.6,
      Words: [{ Word: "Necesito", AccuracyScore: 91, ErrorType: "None" }]
    }
  ]
};

const NESTED = {
  RecognitionStatus: "Success",
  DisplayText: "Hola.",
  NBest: [
    {
      PronunciationAssessment: { AccuracyScore: 70, FluencyScore: 80, CompletenessScore: 90, PronScore: 75 },
      Words: [{ Word: "Hola", PronunciationAssessment: { AccuracyScore: 70, ErrorType: "Mispronunciation" } }]
    }
  ]
};

describe("parseAssessment", () => {
  it("reads the flat shape the REST endpoint actually returns", () => {
    const r = parseAssessment(REAL_FLAT);
    expect(r.pron).toBe(91.6);
    expect(r.accuracy).toBe(88);
    expect(r.words[0]).toEqual({ word: "Necesito", accuracy: 91, errorType: "None" });
    expect(r.transcript).toBe("Necesito ayuda, por favor.");
  });

  it("reads the nested shape the docs show", () => {
    const r = parseAssessment(NESTED);
    expect(r.pron).toBe(75);
    expect(r.words[0]).toMatchObject({ accuracy: 70, errorType: "Mispronunciation" });
  });
});

describe("describeScoring", () => {
  it("says why scoring is off instead of offering a dead button", () => {
    expect(describeScoring({ key: "", region: "westus2" }).reason).toMatch(/No AZURE_SPEECH_KEY/);
    // The short stub `vercel env pull` writes for a sensitive variable.
    expect(describeScoring({ key: "placeholder", region: "westus2" }).reason).toMatch(/placeholder/);
    expect(describeScoring({ key: "x".repeat(84), region: "not a region" }).reason).toMatch(/REGION/);
    expect(describeScoring({ key: "x".repeat(84), region: "westus2" })).toEqual({ available: true, reason: null });
  });

  it("maps Spanish to es-MX, Liz's Latin American Spanish", () => {
    expect(azureLocale("es")).toBe("es-MX");
    expect(azureLocale("xx")).toBeNull();
  });
});

const fakeAzure = (status: number, body: unknown) => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
};

describe("assessPronunciation", () => {
  const args = { key: "k", region: "westus2", wav: Buffer.alloc(100), referenceText: "Necesito ayuda", locale: "es-MX" };

  it("sends the reference text and locale, and returns the number", async () => {
    const { impl, calls } = fakeAzure(200, REAL_FLAT);
    const r = await assessPronunciation({ ...args, fetchImpl: impl });
    expect(r.pron).toBe(91.6);
    expect(calls[0].url).toContain("westus2.stt.speech.microsoft.com");
    expect(calls[0].url).toContain("language=es-MX");
    const config = JSON.parse(Buffer.from(calls[0].headers["Pronunciation-Assessment"], "base64").toString());
    expect(config).toMatchObject({ ReferenceText: "Necesito ayuda", GradingSystem: "HundredMark", EnableMiscue: true });
  });

  it("says so when Azure heard no speech", async () => {
    const { impl } = fakeAzure(200, { RecognitionStatus: "InitialSilenceTimeout" });
    await expect(assessPronunciation({ ...args, fetchImpl: impl })).rejects.toThrow(/didn't hear any speech/);
  });

  it("refuses a successful answer that carries no score — the bug that hid for a month", async () => {
    const { impl } = fakeAzure(200, { RecognitionStatus: "Success", NBest: [{ Words: [] }] });
    await expect(assessPronunciation({ ...args, fetchImpl: impl })).rejects.toThrow(/without a score/);
  });

  it("turns an HTTP error into a readable message", async () => {
    const { impl } = fakeAzure(401, "Access denied due to invalid subscription key");
    await expect(assessPronunciation({ ...args, fetchImpl: impl })).rejects.toThrow(/HTTP 401.*invalid subscription key/);
  });
});

describe("speak", () => {
  it("asks for slower speech for the slow button, and returns the audio", async () => {
    let sent: Record<string, unknown> | null = null;
    let url = "";
    const impl = (async (u: string, init: { body: string }) => {
      url = u;
      sent = JSON.parse(init.body);
      return new Response(new Uint8Array(5000), { status: 200 });
    }) as unknown as typeof fetch;
    const audio = await speak({ apiKey: "k", voiceId: "VOICE", text: "Hola", slow: true, fetchImpl: impl });
    expect(audio.length).toBe(5000);
    expect(url).toContain("/text-to-speech/VOICE");
    expect(sent).toMatchObject({ text: "Hola", voice_settings: { speed: 0.75 } });
  });

  it("refuses an almost-empty answer rather than play nothing", async () => {
    const impl = (async () => new Response(new Uint8Array(10), { status: 200 })) as unknown as typeof fetch;
    await expect(speak({ apiKey: "k", voiceId: "V", text: "Hola", fetchImpl: impl })).rejects.toThrow(/almost no audio/);
  });
});
