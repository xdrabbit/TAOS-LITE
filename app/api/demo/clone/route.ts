import { NextRequest, NextResponse } from "next/server";
import { guardDemo } from "@/lib/demo/guard";
import {
  clonesLeftToday,
  createDemoVoice,
  DemoUpstreamError
} from "@/lib/demo/server";
import {
  DEMO_MAX_CLONES_PER_DAY,
  DEMO_MAX_SAMPLE_SECONDS,
  DEMO_MIN_SAMPLE_SECONDS
} from "@/lib/demo/limits";

export const runtime = "nodejs";
export const maxDuration = 60;

// POST /api/demo/clone — step 3 of "Tu voz": the sample in, a voice id out.
//
// Multipart: `sample` (the recording), `consent` ("yes" — the stranger tapped
// the consent line before the mic opened), `durationMs` (what the recorder
// measured), `removeNoise` ("1" / "0").
//
// Nothing here is written anywhere. The sample is forwarded to ElevenLabs in
// this request and dropped; the voice id goes back to the browser and into a
// signed token, and lib/demo/server.ts deletes the voice within ten minutes.

/** 90 s of opus at 64 kbps is ~720 KB; this is roomy for AAC and still under Vercel's 4.5 MB. */
const MAX_SAMPLE_BYTES = 4 * 1024 * 1024;

function bad(error: string, status = 400): NextResponse {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const gate = await guardDemo(req);
  if (!gate.ok) return gate.response;

  const form = await req.formData().catch(() => null);
  if (!form) return bad("Expected a multipart form.");

  // Consent FIRST, before the sample is even looked at: without the tap there
  // is no add-voice call, whatever else the request carries.
  if (form.get("consent") !== "yes") return bad("Consent is required before cloning.", 403);

  const sample = form.get("sample");
  if (!(sample instanceof Blob) || sample.size === 0) return bad("No recording arrived.");
  if (sample.size > MAX_SAMPLE_BYTES) return bad("That recording is too large.", 413);

  // The recorder's own clock. A browser can lie about it; a founder's browser
  // has no reason to, and the byte cap above bounds what a lie could buy.
  const durationMs = Number(form.get("durationMs"));
  if (!Number.isFinite(durationMs) || durationMs < DEMO_MIN_SAMPLE_SECONDS * 1000) {
    return bad(`Record at least ${DEMO_MIN_SAMPLE_SECONDS} seconds.`);
  }
  if (durationMs > (DEMO_MAX_SAMPLE_SECONDS + 2) * 1000) {
    return bad(`Keep it under ${DEMO_MAX_SAMPLE_SECONDS} seconds.`, 413);
  }

  if (clonesLeftToday(gate.user.id) <= 0) {
    return bad(`That's ${DEMO_MAX_CLONES_PER_DAY} demos today — the limit. Try again tomorrow.`, 429);
  }

  const fileName = sample instanceof File && sample.name ? sample.name : "sample.webm";
  try {
    const clone = await createDemoVoice({
      sample,
      fileName,
      ownerId: gate.user.id,
      removeBackgroundNoise: form.get("removeNoise") !== "0"
    });
    return NextResponse.json(clone, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof DemoUpstreamError) return bad(e.message, 502);
    if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
      return bad("Cloning took too long. Please try again.", 504);
    }
    return bad("Voice cloning failed.", 500);
  }
}
