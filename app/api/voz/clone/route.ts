import { NextRequest, NextResponse } from "next/server";
import { guardVoz, vozError } from "@/lib/voz/guard";
import {
  checkAllowance,
  checkConsentToken,
  COME_BACK_TOMORROW,
  countTry,
  createVozVoice,
  ipAllows,
  kickVozSweep,
  liveVozVoices,
  setDeviceCookie,
  spendConsent,
  triesLeft,
  vozLog,
  vozMaxLive
} from "@/lib/voz/server";
import { VoiceUpstreamError } from "@/lib/voz/elevenlabs";
import { VOZ_MAX_SAMPLE_SECONDS, VOZ_MIN_SAMPLE_SECONDS } from "@/lib/voz/limits";

export const runtime = "nodejs";
export const maxDuration = 60;

// POST /api/voz/clone — the sample in, a ten-minute voice out.
//
// Multipart: `sample`, `consentToken` (from /api/voz/consent), `durationMs`,
// `removeNoise`. Every check runs before ElevenLabs is called, cheapest
// first, and the consent token is checked before the sample is even read:
//
//   consent token (bound to this device/account, ≤15 min old, unspent) → 403
//   per-IP hour → per-day tries → global anonymous day → 429
//   sample shape and length → 400/413
//   live voices account-wide (after a sweep) → 429
//
// Nothing is written anywhere: the sample is forwarded and dropped.

/** 60 s of opus at 64 kbps is ~480 KB; roomy for AAC, under Vercel's 4.5 MB. */
const MAX_SAMPLE_BYTES = 3 * 1024 * 1024;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const gate = await guardVoz(req);
  if (!gate.ok) return gate.response;
  const { caller } = gate;

  const form = await req.formData().catch(() => null);
  if (!form) return vozError("Expected a multipart form.", 400);

  const nonce = checkConsentToken(form.get("consentToken"), caller.owner);
  if (!nonce) {
    vozLog({ event: "refused", reason: "consent", tier: caller.tier });
    return vozError("Toca «Acepto» antes de grabar · Tap “I agree” before recording", 403, "consent");
  }

  if (!ipAllows(caller.ip)) {
    vozLog({ event: "refused", reason: "rate", tier: caller.tier });
    return vozError(COME_BACK_TOMORROW, 429, "rate");
  }
  const refusal = checkAllowance(caller);
  if (refusal) {
    vozLog({ event: "refused", reason: refusal.code, tier: caller.tier, at: "clone" });
    return vozError(refusal.error, refusal.status, refusal.code);
  }

  const sample = form.get("sample");
  if (!(sample instanceof Blob) || sample.size === 0) return vozError("No recording arrived.", 400);
  if (sample.size > MAX_SAMPLE_BYTES) return vozError("That recording is too large.", 413);
  if (sample.type && !sample.type.startsWith("audio/")) return vozError("That is not a recording.", 400);
  const durationMs = Number(form.get("durationMs"));
  if (!Number.isFinite(durationMs) || durationMs < VOZ_MIN_SAMPLE_SECONDS * 1000) {
    return vozError(`Record at least ${VOZ_MIN_SAMPLE_SECONDS} seconds.`, 400);
  }
  if (durationMs > (VOZ_MAX_SAMPLE_SECONDS + 2) * 1000) {
    return vozError(`Keep it under ${VOZ_MAX_SAMPLE_SECONDS} seconds.`, 413);
  }

  // The one truly global count: what ElevenLabs is holding right now.
  if ((await liveVozVoices()) >= vozMaxLive()) {
    vozLog({ event: "refused", reason: "live", tier: caller.tier });
    return vozError(COME_BACK_TOMORROW, 429, "live");
  }

  spendConsent(nonce);
  const fileName = sample instanceof File && sample.name ? sample.name : "sample.webm";
  try {
    const clone = await createVozVoice({
      sample,
      fileName,
      caller,
      removeBackgroundNoise: form.get("removeNoise") !== "0"
    });
    countTry(caller);
    kickVozSweep();
    const res = NextResponse.json(
      { ...clone, triesLeft: triesLeft(caller) },
      { headers: { "Cache-Control": "no-store" } }
    );
    setDeviceCookie(res, caller.device);
    return res;
  } catch (e) {
    if (e instanceof VoiceUpstreamError) return vozError(e.message, 502);
    if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
      return vozError("Cloning took too long. Please try again.", 504);
    }
    return vozError("Voice cloning failed.", 500);
  }
}
