// Practice for a lesson: hear it (ElevenLabs, in Liz's cloned voice), say it,
// and get a pronunciation score (Azure Pronunciation Assessment).
//
// The voice ID is read from ELEVENLABS_LIZ_VOICE_ID, the same variable
// lib/tts/voice.ts reads. IDs live there and in the environment, never here.

/** Catalog code → Azure assessment locale. Mirrors lib/tutor/pronunciation.ts's choices. */
const AZURE_LOCALES = {
  es: "es-MX", // Liz's Latin American Spanish, not es-ES (see lib/tutor/pronunciation.ts)
  en: "en-US",
  it: "it-IT",
  fr: "fr-FR",
  pt: "pt-BR",
  de: "de-DE",
  ko: "ko-KR",
  zh: "zh-CN"
};

export function azureLocale(lang) {
  return AZURE_LOCALES[lang] ?? null;
}

/**
 * Can we score? A missing key, or the short placeholder that `vercel env pull`
 * leaves behind for a sensitive variable, can't work. Say which, rather than
 * offer a button that fails.
 */
export function describeScoring({ key, region }) {
  if (!key) return { available: false, reason: "No AZURE_SPEECH_KEY in the environment or .env.local." };
  if (key.length < 32) {
    return {
      available: false,
      reason: "AZURE_SPEECH_KEY is a placeholder (Vercel won't let the real one be downloaded). Paste the real key into .env.local."
    };
  }
  if (!/^[a-z]+[0-9]?$/.test(region ?? "")) {
    return { available: false, reason: "AZURE_SPEECH_REGION is missing or isn't a region name (e.g. westus2)." };
  }
  return { available: true, reason: null };
}

function record(value) {
  return value && typeof value === "object" ? value : {};
}
function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
/** Nested under PronunciationAssessment (SDK/docs) or flat (the REST endpoint, as captured). */
function score(holder, field) {
  return num(record(holder.PronunciationAssessment)[field]) ?? num(holder[field]);
}

/**
 * Azure's answer → scores. Reads BOTH shapes: the REST endpoint puts the
 * scores flat on NBest[0] (captured from the live resource, 2026-08-27 — see
 * lib/tutor/assessment.ts), the docs show them nested. Reading only one is
 * how the tutor rendered "—" for a month.
 */
export function parseAssessment(data) {
  const root = record(data);
  const nbest = record(Array.isArray(root.NBest) ? root.NBest[0] : null);
  const words = (Array.isArray(nbest.Words) ? nbest.Words : []).map((raw) => {
    const w = record(raw);
    const errorType = record(w.PronunciationAssessment).ErrorType ?? w.ErrorType;
    return {
      word: String(w.Word ?? ""),
      accuracy: score(w, "AccuracyScore"),
      errorType: typeof errorType === "string" ? errorType : null
    };
  });
  return {
    status: String(root.RecognitionStatus ?? ""),
    transcript: String(root.DisplayText ?? nbest.Display ?? ""),
    accuracy: score(nbest, "AccuracyScore"),
    fluency: score(nbest, "FluencyScore"),
    completeness: score(nbest, "CompletenessScore"),
    pron: score(nbest, "PronScore"),
    words
  };
}

/** Score one attempt. `wav` is 16 kHz mono 16-bit PCM. Throws a readable Error. */
export async function assessPronunciation({ key, region, wav, referenceText, locale, fetchImpl = fetch }) {
  const config = Buffer.from(
    JSON.stringify({
      ReferenceText: referenceText,
      GradingSystem: "HundredMark",
      Granularity: "Word",
      Dimension: "Comprehensive",
      EnableMiscue: true
    })
  ).toString("base64");
  const url =
    `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1` +
    `?language=${encodeURIComponent(locale)}&format=detailed`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Pronunciation-Assessment": config,
      "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
      Accept: "application/json"
    },
    body: wav,
    signal: AbortSignal.timeout(30_000)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Azure refused the recording (HTTP ${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Azure answered with something other than JSON.");
  }
  const result = parseAssessment(data);
  if (result.status && result.status !== "Success") {
    // NoMatch / InitialSilenceTimeout: it heard nothing it could match.
    throw new Error(
      result.status === "InitialSilenceTimeout" || result.status === "NoMatch"
        ? "Azure didn't hear any speech in that recording — check the mic and try again."
        : `Azure couldn't score that (${result.status}).`
    );
  }
  // "The request succeeded" is not "the number arrived" (lib/tutor/assessment.ts).
  if (result.pron == null && result.accuracy == null) {
    throw new Error("Azure answered, but without a score. Nothing to show.");
  }
  return result;
}

/** ElevenLabs text-to-speech → mp3 bytes. `slow` for a learner's first listen. */
export async function speak({ apiKey, voiceId, text, slow = false, model, fetchImpl = fetch }) {
  const res = await fetchImpl(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({
        text,
        // Multilingual v2 over the app's low-latency turbo: this audio is made
        // once, cached, and listened to closely — quality wins.
        model_id: model || "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.8, speed: slow ? 0.75 : 1.0 }
      }),
      signal: AbortSignal.timeout(30_000)
    }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`ElevenLabs refused (HTTP ${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 1000) throw new Error("ElevenLabs returned almost no audio.");
  return bytes;
}
