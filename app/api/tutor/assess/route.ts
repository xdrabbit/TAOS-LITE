import { NextRequest, NextResponse } from "next/server";
import { tutorEnabled } from "@/lib/release";
import { guardSpend } from "@/lib/spendGuard";
import { languageLabel } from "@/lib/languages/catalog";
import { resolveAssessmentLocale } from "@/lib/tutor/pronunciation";

export const runtime = "nodejs";
export const maxDuration = 60;

interface WordScore {
  word: string;
  accuracy: number | null;
  errorType: string | null;
}

// Short, strict-but-kind coaching from the scores (best-effort; never blocks).
//
// The two language names are ARGUMENTS now. They were "English pronunciation
// coach for a Spanish speaker", baked in — which was true of the 30-day drills
// and false the moment the curriculum modules arrived, because Crawl scores a
// phrase in whichever of the catalog's languages the learner is learning. A
// coach that names the wrong two languages does not just read oddly: it tells
// the model to explain Spanish interference to someone whose problem is
// Hindi's retroflex stops.
async function coach(reference: string, result: {
  pron: number | null;
  transcript: string;
  words: WordScore[];
  targetName: string;
  learnerName: string;
}): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return "";
  const weak = result.words
    .filter((w) => typeof w.accuracy === "number" && (w.accuracy as number) < 80)
    .map((w) => w.word);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_PARAPHRASE_MODEL?.trim() || "gpt-4.1-mini",
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content:
              `You are a strict but encouraging ${result.targetName} pronunciation coach for a ${result.learnerName} speaker. ` +
              `Write your feedback in ${result.learnerName}. ` +
              "In 1-2 short sentences give specific, actionable feedback. If certain words scored low, " +
              "name them and give one quick tip. Be direct, warm, and brief — no fluff."
          },
          {
            role: "user",
            content:
              `Target phrase: "${reference}". Overall score ${Math.round(result.pron ?? 0)}/100. ` +
              `Low-scoring words: ${weak.join(", ") || "none"}. They were heard saying: "${result.transcript}".`
          }
        ]
      }),
      cache: "no-store"
    });
    const json = (await res.json().catch(() => null)) as
      | { choices?: Array<{ message?: { content?: string } }> }
      | null;
    return json?.choices?.[0]?.message?.content?.trim() ?? "";
  } catch {
    return "";
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // RC1: tutor is off (lib/release.ts) — see /api/tutor/realtime. Azure
  // pronunciation scoring is billed per request too.
  if (!tutorEnabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Azure scoring plus an OpenAI coaching completion, both per request.
  // POST /api/tutor/realtime has required a session since it was written;
  // this one is the same feature and was not checking. Now it matches.
  const guard = await guardSpend(req);
  if (!guard.ok) return guard.response;

  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data." }, { status: 400 });
  }
  const audio = form.get("audio");
  const referenceText = String(form.get("referenceText") ?? "").trim();
  // Either a catalog code ("es", from a module lesson) or a full locale
  // ("en-US", from the legacy 30-day drills) — lib/tutor/pronunciation.ts
  // takes both and refuses to guess at anything else.
  const languageRaw = String(form.get("language") ?? "en-US");
  const learnerRaw = String(form.get("learner") ?? "en");
  const locale = resolveAssessmentLocale(languageRaw);

  if (!(audio instanceof File) || audio.size === 0 || !referenceText) {
    return NextResponse.json({ error: "audio and referenceText are required." }, { status: 400 });
  }

  // Azure assesses 24 of the catalog's 100 languages. Saying so plainly beats
  // sending the audio anyway and returning a confident score computed against
  // the wrong acoustic model — and it costs nothing, which is the other half
  // of why the check is here rather than after the request.
  if (!locale) {
    return NextResponse.json({
      configured: true,
      supported: false,
      message: `Pronunciation scoring isn't available for ${languageLabel(languageRaw)} yet — the phrase and its meaning still are.`
    });
  }

  if (!key || !region) {
    // Drill still works; scoring just isn't wired yet.
    return NextResponse.json({
      configured: false,
      message: "Pronunciation scoring isn't configured yet (missing Azure Speech key)."
    });
  }

  const paConfig = Buffer.from(
    JSON.stringify({
      ReferenceText: referenceText,
      GradingSystem: "HundredMark",
      Granularity: "Phoneme",
      Dimension: "Comprehensive",
      EnableMiscue: true
    })
  ).toString("base64");

  const url =
    `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1` +
    `?language=${encodeURIComponent(locale)}&format=detailed`;

  try {
    const audioBuffer = Buffer.from(await audio.arrayBuffer());
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Pronunciation-Assessment": paConfig,
        "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
        Accept: "application/json"
      },
      body: audioBuffer,
      cache: "no-store"
    });

    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !data) {
      return NextResponse.json(
        { configured: true, error: "Azure assessment failed.", details: data ?? `HTTP ${res.status}` },
        { status: 502 }
      );
    }

    const nbest = (Array.isArray(data.NBest) ? data.NBest[0] : null) as Record<string, unknown> | null;
    const pa = (nbest?.PronunciationAssessment ?? {}) as Record<string, number>;
    const words: WordScore[] = Array.isArray(nbest?.Words)
      ? (nbest!.Words as Array<Record<string, unknown>>).map((w) => {
          const wpa = (w.PronunciationAssessment ?? {}) as Record<string, unknown>;
          return {
            word: String(w.Word ?? ""),
            accuracy: typeof wpa.AccuracyScore === "number" ? (wpa.AccuracyScore as number) : null,
            errorType: typeof wpa.ErrorType === "string" ? (wpa.ErrorType as string) : null
          };
        })
      : [];

    const result = {
      configured: true as const,
      supported: true as const,
      locale,
      transcript: String(data.DisplayText ?? nbest?.Display ?? ""),
      accuracy: pa.AccuracyScore ?? null,
      fluency: pa.FluencyScore ?? null,
      completeness: pa.CompletenessScore ?? null,
      prosody: pa.ProsodyScore ?? null,
      pron: pa.PronScore ?? null,
      words
    };

    const coaching = await coach(referenceText, {
      pron: result.pron,
      transcript: result.transcript,
      words,
      // The names, not the codes: "Spanish", not "es". languageLabel() falls
      // back to the raw string, so a locale from the legacy drills still reads
      // as something rather than blowing up.
      targetName: languageLabel(languageRaw.split("-")[0]),
      learnerName: languageLabel(learnerRaw.split("-")[0])
    });

    return NextResponse.json({ ...result, coaching });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Assessment failed.";
    return NextResponse.json({ configured: true, error: message }, { status: 500 });
  }
}
