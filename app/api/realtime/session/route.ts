import { NextResponse } from "next/server";

// Deprecated. TAOS-LITE moved from continuous realtime streaming to a
// push-to-talk pipeline (/api/translate + /api/tts). This endpoint is retained
// only as a tombstone so old clients fail loudly instead of silently.
export async function POST(): Promise<NextResponse> {
  return NextResponse.json(
    { error: "Deprecated endpoint. Use POST /api/translate." },
    { status: 410 }
  );
}
