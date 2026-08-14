// Shared constants for the /video upload pipeline. Next.js forbids arbitrary
// exports from route files, so the two /api/video/* routes share these here.

export const VIDEO_BUCKET = "video-uploads";

// Matches the bucket's fileSizeLimit (set at creation in /api/video/upload-url)
// and the client-side pre-check in VideoShell. ~300 MB comfortably covers a
// 30-minute 1080p phone video and stays inside a serverless function's /tmp.
export const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
