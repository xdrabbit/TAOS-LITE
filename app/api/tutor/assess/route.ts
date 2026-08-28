import { NextRequest, NextResponse } from "next/server";
import { tutorEnabled } from "@/lib/release";
import { guardSpend, SIGN_IN_REQUIRED } from "@/lib/spendGuard";
import { languageLabel } from "@/lib/languages/catalog";
import { resolveAssessmentLocale } from "@/lib/tutor/pronunciation";
import { parseAzureAssessment, type AssessmentWord } from "@/lib/tutor/assessment";
import {
  beginTutorSession,
  settleTutorSession,
  TutorMeterUnavailableError,
  wavSeconds
} from "@/lib/tutor/meter";

export const runtime = "nodejs";
export const maxDuration = 60;

/** One scored word. The shape is lib/tutor/assessment.ts's; this is the name
 * the coaching prompt below has always used for it. */
type WordScore = AssessmentWord;

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
  // guardSpend without allowAnonymous never returns ok with a null user, but
  // the type says it can — and the meter needs someone to charge.
  const user = guard.user;
  if (!user) return NextResponse.json({ error: SIGN_IN_REQUIRED }, { status: 401 });

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

  // ── Crawl's share of the meter ───────────────────────────────────────────
  // Crawl has no session to time, so the unit is the DURATION OF THE AUDIO
  // being assessed — which is what Azure charges for and what the learner
  // actually spent talking. Reserved before the provider is called, for the
  // same reason every other spend on this route is: the refusal has to cost
  // nothing. A repeat-after-me attempt is a few seconds, so a free learner
  // will not lose their month to drills; a script hammering the endpoint with
  // long audio will.
  //
  // `audio.size` rather than the decoded buffer: lib/tutor/wav.ts produces
  // 16 kHz mono 16-bit WAV for exactly this endpoint, and reading the length
  // off the byte count means the reservation happens before anything is read
  // into memory.
  const attemptSeconds = Math.max(1, wavSeconds(audio.size));
  let reservation;
  try {
    reservation = await beginTutorSession({
      user: { id: user.id, email: user.email },
      phase: "crawl",
      requestedSeconds: attemptSeconds,
      moduleId: (form.get("moduleId") as string | null) ?? null,
      target: languageRaw.split("-")[0],
      learner: learnerRaw.split("-")[0],
      level: String(form.get("level") ?? "beginner")
    });
  } catch (error) {
    if (error instanceof TutorMeterUnavailableError) {
      // eslint-disable-next-line no-console
      console.error(error.message);
      return NextResponse.json(
        { configured: true, error: "Tutor is temporarily unavailable." },
        { status: 503 }
      );
    }
    throw error;
  }

  if (!reservation.ok) {
    return NextResponse.json(
      {
        configured: true,
        error: "quota_exhausted",
        details:
          reservation.balance.tier === "free"
            ? "Your free tutor minutes for this month are used up."
            : "You've used this month's tutor minutes.",
        balance: {
          unlimited: reservation.balance.unlimited,
          tier: reservation.balance.tier,
          remainingSeconds: reservation.balance.unlimited
            ? -1
            : reservation.balance.remainingSeconds,
          packSeconds: reservation.balance.packSeconds
        }
      },
      { status: 402 }
    );
  }

  // Whatever happens below — a score, a 502, a thrown fetch — the attempt is
  // settled at the audio's own length. Azure was paid for the audio it was
  // sent, not for whether we liked the answer.
  const settle = async (reason: "user" | "error") => {
    await settleTutorSession({
      user: { id: user.id, email: user.email },
      sessionId: reservation.ok ? reservation.sessionId : "",
      serverSeconds: attemptSeconds,
      reason,
      phase: "crawl"
    }).catch(() => undefined);
  };

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
      await settle("error");
      return NextResponse.json(
        { configured: true, error: "Azure assessment failed.", details: data ?? `HTTP ${res.status}` },
        { status: 502 }
      );
    }

    // This endpoint returns the scores FLAT on the NBest entry, not nested
    // under PronunciationAssessment the way the SDK does — reading only the
    // nested shape is why Crawl rendered "—" on every attempt for a month.
    // lib/tutor/assessment.ts reads both and explains the whole failure.
    const scores = parseAzureAssessment(data);
    const words: WordScore[] = scores.words;

    const result = {
      configured: true as const,
      supported: true as const,
      locale,
      ...scores
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

    await settle("user");
    return NextResponse.json({ ...result, coaching });
  } catch (error) {
    await settle("error");
    const message = error instanceof Error ? error.message : "Assessment failed.";
    return NextResponse.json({ configured: true, error: message }, { status: 500 });
  }
}
