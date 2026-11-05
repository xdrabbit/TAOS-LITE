import { NextRequest, NextResponse } from "next/server";
import { guardReview } from "@/lib/review/guard";
import { clipSetEntries, type ExportTurn } from "@/lib/review/clipSet";
import { buildTar } from "@/lib/review/tar";
import { downloadReviewAudio, listReviewSpeakers, listReviewTurns, ReviewStoreError } from "@/lib/review/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/review/export → review-clips-<day>.tar
//
// Every FLAGGED, unexpired turn as a clip set — the audio, a `.txt` script
// and a `.json` sidecar per turn, plus a manifest — in the format
// tests/live-fire/transcribe-accuracy.run.mjs --clips <dir> reads
// (lib/review/clipSet.ts is the one definition of that format). So:
//
//   curl -H "Authorization: Bearer …" …/api/review/export > clips.tar
//   tar xf clips.tar && node tests/live-fire/transcribe-accuracy.run.mjs --clips review-clips-<day>
//
// or the Download button on /review, which does the first line for you.
// Bounded: at most EXPORT_LIMIT clips and EXPORT_MAX_BYTES of audio, so the
// archive stays inside one function's memory and the response limit.

const EXPORT_LIMIT = 100;
const EXPORT_MAX_BYTES = 40 * 1024 * 1024;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const guard = await guardReview(req);
  if (!guard.ok) return guard.response;
  try {
    const [rows, speakers] = await Promise.all([
      listReviewTurns({ flaggedOnly: true }, Date.now(), EXPORT_LIMIT),
      listReviewSpeakers()
    ]);
    // A short label per speaker — the part before the @, never the address.
    const label = new Map(speakers.map((s) => [s.id, s.email.split("@")[0]]));
    const clips: Array<{ turn: ExportTurn; audio: Uint8Array }> = [];
    let bytes = 0;
    for (const row of rows) {
      const audio = await downloadReviewAudio(row.audio_path);
      bytes += audio.byteLength;
      if (bytes > EXPORT_MAX_BYTES) break;
      clips.push({ turn: { ...row, speaker: label.get(row.user_id) ?? "founder" }, audio });
    }
    const builtAt = new Date();
    const tar = buildTar(clipSetEntries(clips, builtAt));
    console.log(`[taos-review] export clips=${clips.length} bytes=${tar.byteLength}`);
    // A fresh ArrayBuffer-backed copy: NextResponse's body type does not
    // take a Uint8Array over an ArrayBufferLike.
    return new NextResponse(tar.buffer.slice(tar.byteOffset, tar.byteOffset + tar.byteLength) as ArrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/x-tar",
        "Content-Disposition": `attachment; filename="review-clips-${builtAt.toISOString().slice(0, 10)}.tar"`,
        "Cache-Control": "no-store"
      }
    });
  } catch (error) {
    const code = error instanceof ReviewStoreError ? error.code : "failed";
    console.error(`[taos-review] export_failed code=${code}`);
    return NextResponse.json({ error: "Could not build the export." }, { status: 502 });
  }
}
