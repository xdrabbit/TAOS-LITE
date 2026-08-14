import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/authServer";
import { hasServiceRoleKey, supabaseAdmin } from "@/lib/supabaseAdmin";
import { MAX_VIDEO_BYTES, VIDEO_BUCKET } from "@/lib/video/storage";

export const runtime = "nodejs";
export const maxDuration = 30;

// Videos are far too large for a Vercel request body (4.5 MB limit), so the
// server never touches the bytes: this route mints a signed upload URL and the
// browser uploads straight to Supabase Storage. /api/video/process then reads
// the object server-side and deletes it when done — the bucket is transport,
// not a library.

// Storage keys keep only a vetted extension from the original filename; the
// path is namespaced by user id, and /api/video/process refuses any path
// outside the caller's own namespace.
const SAFE_EXTENSIONS = new Set(["mp4", "mov", "m4v", "webm", "mkv", "avi", "mp3", "m4a", "wav", "ogg"]);

function extensionFor(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return SAFE_EXTENSIONS.has(ext) ? ext : "mp4";
}

let bucketReady = false;

// Lazily create the bucket so no manual Supabase console step is needed.
// Private (signed access only), capped at the same size the client enforces.
async function ensureBucket(): Promise<void> {
  if (bucketReady) return;
  const { error } = await supabaseAdmin.storage.createBucket(VIDEO_BUCKET, {
    public: false,
    fileSizeLimit: MAX_VIDEO_BYTES
  });
  // "already exists" is the steady state; anything else is a real failure.
  if (error && !/already exists|duplicate/i.test(error.message)) {
    throw new Error(`Could not prepare the upload bucket: ${error.message}`);
  }
  bucketReady = true;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  }
  if (!hasServiceRoleKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: missing SUPABASE_SERVICE_ROLE_KEY." },
      { status: 500 }
    );
  }

  const body = (await req.json().catch(() => null)) as {
    fileName?: string;
    size?: number;
  } | null;
  const fileName = typeof body?.fileName === "string" ? body.fileName : "video.mp4";
  const size = typeof body?.size === "number" ? body.size : 0;
  if (size <= 0) {
    return NextResponse.json({ error: "Missing file size." }, { status: 400 });
  }
  if (size > MAX_VIDEO_BYTES) {
    return NextResponse.json(
      {
        error:
          "That video is too large (300 MB max). Try trimming it or exporting at a lower quality. · " +
          "Ese video es demasiado grande (máx. 300 MB)."
      },
      { status: 413 }
    );
  }

  try {
    await ensureBucket();
    const path = `${user.id}/${crypto.randomUUID()}.${extensionFor(fileName)}`;
    const { data, error } = await supabaseAdmin.storage
      .from(VIDEO_BUCKET)
      .createSignedUploadUrl(path);
    if (error || !data) {
      throw new Error(error?.message ?? "no signed URL returned");
    }
    return NextResponse.json({ path: data.path, token: data.token, bucket: VIDEO_BUCKET });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    return NextResponse.json({ error: "Could not start the upload.", details: message }, {
      status: 502
    });
  }
}
