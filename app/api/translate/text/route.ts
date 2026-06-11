import { NextResponse } from "next/server";

// Deprecated. Superseded by POST /api/translate, which takes audio and returns
// a concept-level first-person paraphrase. Kept as a tombstone for old clients.
export async function POST(): Promise<NextResponse> {
  return NextResponse.json(
    { error: "Deprecated endpoint. Use POST /api/translate." },
    { status: 410 }
  );
}
