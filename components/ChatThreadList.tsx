"use client";

import { CHAT_START_BUSY, CHAT_START_LABEL } from "@/lib/chatInvite";
import {
  CHAT_LIST_CAPTION,
  CHAT_LIST_WAITING,
  formatThreadStamp,
  threadRowLabel,
  type ChatThreadSummary
} from "@/lib/chatThreads";

// The screen /chat opens on once an account holds more than one chat.
//
// It replaces a refusal. Joining a second invite used to answer "You're
// already in a chat, and TAOS holds one at a time" — honest about a screen
// that drew the first thread it found and had no switcher. This is the
// switcher, so the sentence is gone.
//
// A row is three facts and no chrome: who it is with, the last thing said, and
// when. All three are the VIEWER's — the label is the other person's own
// display name off their auth profile, and the preview is already resolved
// into the language this account reads IN THIS THREAD (lib/chatThreads.ts),
// which is not necessarily the language it reads in the row above.
//
// Start a chat is at the bottom and is always there, including when the list
// is long. It is the same call the empty state makes and the same call the
// invite button inside a thread makes — one route, one sheet, one QR.
export function ChatThreadList({
  threads,
  busy,
  onOpen,
  onStart
}: {
  threads: readonly ChatThreadSummary[];
  busy: boolean;
  onOpen: (threadId: string) => void;
  onStart: () => void;
}): JSX.Element {
  return (
    <div className="flex flex-1 flex-col gap-3 overflow-hidden">
      <div className="text-xs uppercase tracking-[0.2em] text-amber-100/50">
        {CHAT_LIST_CAPTION}
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto rounded-2xl border border-white/10 bg-white/5 p-2">
        {threads.map((t) => {
          const label = threadRowLabel(t.partnerName);
          const waiting = t.partnerName === null;
          return (
            <button
              key={t.threadId}
              type="button"
              onClick={() => onOpen(t.threadId)}
              className="flex w-full items-start gap-3 rounded-2xl border border-white/5 bg-stone-950/50 px-3 py-2.5 text-left transition active:scale-[0.99]"
            >
              <div className="min-w-0 flex-1">
                <div
                  className={`truncate text-[15px] font-semibold ${
                    waiting ? "text-amber-100/50" : "text-amber-100"
                  }`}
                >
                  {label}
                </div>
                {/* dir="auto" for the same reason the confirmation line has it:
                    seven of the hundred languages read the other way, and the
                    preview's own first letter knows which. */}
                <div dir="auto" className="truncate text-xs text-amber-100/50">
                  {t.preview}
                </div>
              </div>
              <span className="shrink-0 pt-0.5 text-[10px] uppercase tracking-wide text-amber-100/30">
                {formatThreadStamp(t.updatedAt)}
              </span>
            </button>
          );
        })}
        {/* A list is never empty when it is drawn — an account with no chats
            gets ChatStartCard instead — but a thread that lost its rows should
            not be a blank box either. */}
        {threads.length === 0 ? (
          <div className="py-6 text-center text-sm text-amber-100/40">{CHAT_LIST_WAITING}</div>
        ) : null}
      </div>

      <button
        type="button"
        onClick={onStart}
        disabled={busy}
        className="rounded-2xl bg-amber-400 px-5 py-3 text-base font-semibold text-stone-950 transition active:scale-[0.99] disabled:opacity-60"
      >
        {busy ? CHAT_START_BUSY : CHAT_START_LABEL}
      </button>
    </div>
  );
}
