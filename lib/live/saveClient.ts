"use client";

// The phone's half of "Save this conversation" (lib/live/saved.ts).
//
// One of these per START. It does nothing until the first line it is handed —
// which the shell only does while the toggle is ON — so a session nobody saved
// never makes an id, never makes a request and never makes a row.
//
// Lines go up one at a time, in order. A line that fails is counted and
// dropped, never retried into a later position and never thrown: saving is a
// convenience on top of a live conversation and must not be able to interrupt
// one.

import { jsonAuthHeaders } from "@/lib/authClient";
import type { LiveLine } from "@/lib/live/auto";
import { LIVE_SAVE_UNAVAILABLE, type LiveSaveStatus } from "@/lib/live/saved";
import type { LiveStyle } from "@/lib/live/style";

/** Ask once at mount. Any failure at all is "no toggle". */
export async function fetchLiveSaveStatus(): Promise<LiveSaveStatus> {
  try {
    const res = await fetch("/api/live/saved/status", { headers: await jsonAuthHeaders(), cache: "no-store" });
    if (!res.ok) return LIVE_SAVE_UNAVAILABLE;
    const body = (await res.json().catch(() => null)) as Partial<LiveSaveStatus> | null;
    return { allowed: body?.allowed === true, ready: body?.ready === true };
  } catch {
    return LIVE_SAVE_UNAVAILABLE;
  }
}

function newSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // An older WebKit: RFC 4122 v4 from getRandomValues.
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface LiveSaver {
  /** Queue one line. Call ONLY while the toggle is on. */
  line: (line: LiveLine) => void;
}

export function createLiveSaver(
  meta: { mine: string; theirs: string; style: LiveStyle; auto: boolean },
  onFailed: () => void
): LiveSaver {
  let session: { id: string; startedAt: string } | null = null;
  let chain: Promise<void> = Promise.resolve();
  // The saved order is the order of SAVED lines: turning the toggle on at the
  // tenth line of a conversation stores a conversation that starts at 1.
  let seq = 0;

  return {
    line: (line) => {
      if (!session) session = { id: newSessionId(), startedAt: new Date().toISOString() };
      const body = JSON.stringify({
        session: { ...session, ...meta },
        line: { ...line, seq: (seq += 1) }
      });
      chain = chain.then(async () => {
        try {
          const res = await fetch("/api/live/saved/lines", {
            method: "POST",
            headers: await jsonAuthHeaders(),
            body
          });
          if (!res.ok) onFailed();
        } catch {
          onFailed();
        }
      });
    }
  };
}
