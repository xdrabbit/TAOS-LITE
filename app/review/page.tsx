import type { Metadata } from "next";
import { ReviewGate } from "@/components/review/ReviewGate";
import { ReviewShell } from "@/components/review/ReviewShell";
import { reviewRetentionDays } from "@/lib/review/flag";
import { reviewBatchMax } from "@/lib/review/opinion";

// /review — founder translation review (Tom, 2026-11-04): every kept turn,
// newest first, with the audio beside the transcript and the translation, and
// a one-tap flag for the ones that went wrong. Founders only; the routes
// answer 404 to anyone else (lib/review/guard.ts), and nothing is kept for a
// founder until they flip their own "Keep my audio for review".
//
// Dynamic because the retention knob (TAOS_REVIEW_RETENTION_DAYS) is a server
// value read per request and shown on the screen.
export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  // Never indexed, no title to announce it.
  return { robots: { index: false, follow: false } };
}

export default function ReviewPage(): JSX.Element {
  return (
    <ReviewGate>
      <ReviewShell retentionDays={reviewRetentionDays()} batchMax={reviewBatchMax()} />
    </ReviewGate>
  );
}
