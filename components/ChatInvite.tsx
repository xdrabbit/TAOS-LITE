"use client";

import {
  CHAT_INVITE_BLURB,
  CHAT_INVITE_BUSY,
  CHAT_INVITE_CAUTION,
  CHAT_INVITE_COPIED,
  CHAT_INVITE_COPY,
  CHAT_INVITE_HEADING,
  CHAT_INVITE_LABEL,
  CHAT_NO_THREAD_BODY,
  CHAT_NO_THREAD_TITLE,
  CHAT_START_BUSY,
  CHAT_START_LABEL
} from "@/lib/chatInvite";
import { QrShareModal } from "./QrShareModal";

// The two controls that turn /chat from a screen you can be locked out of into
// one you can walk into. Both do the same thing — POST /api/chat/invite and
// show the link — and they are two components only because they are two
// different sentences:
//
//   ChatStartCard   — you are in no chat at all. "Start a chat."
//   ChatInviteRow   — you are in a chat with nobody in it yet. "Invite someone."
//
// The words are in lib/chatInvite.ts with the route's, because half of this
// conversation is read on the other person's phone.

export function ChatStartCard({
  busy,
  error,
  onStart
}: {
  busy: boolean;
  error: string | null;
  onStart: () => void;
}): JSX.Element {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
      <h2 className="text-base font-semibold text-amber-200">{CHAT_NO_THREAD_TITLE}</h2>
      <p className="mt-2 text-sm leading-snug text-amber-100/70">{CHAT_NO_THREAD_BODY}</p>
      <button
        type="button"
        onClick={onStart}
        disabled={busy}
        className="mt-4 w-full rounded-2xl bg-amber-400 px-5 py-3 text-base font-semibold text-stone-950 transition active:scale-[0.99] disabled:opacity-60"
      >
        {busy ? CHAT_START_BUSY : CHAT_START_LABEL}
      </button>
      {error ? <p className="mt-3 text-sm text-rose-300">{error}</p> : null}
    </div>
  );
}

export function ChatInviteRow({
  busy,
  onInvite
}: {
  busy: boolean;
  onInvite: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onInvite}
      disabled={busy}
      className="rounded-2xl border border-amber-300/30 bg-amber-400/10 px-4 py-2.5 text-sm font-semibold text-amber-200 transition active:scale-[0.99] disabled:opacity-60"
    >
      {busy ? CHAT_INVITE_BUSY : CHAT_INVITE_LABEL}
    </button>
  );
}

/**
 * The minted link, as a QR to scan and a link to send.
 *
 * `display` is the URL itself rather than a tidied-up label: this one carries
 * a token, and a shortened version of it would be a link that does not work.
 */
export function ChatInviteSheet({
  open,
  url,
  onClose
}: {
  open: boolean;
  url: string | null;
  onClose: () => void;
}): JSX.Element | null {
  if (!url) return null;
  return (
    <QrShareModal
      open={open}
      onClose={onClose}
      url={url}
      title={CHAT_INVITE_HEADING}
      subtitle=""
      blurb={CHAT_INVITE_BLURB}
      note={CHAT_INVITE_CAUTION}
      copyLabel={CHAT_INVITE_COPY}
      copiedLabel={CHAT_INVITE_COPIED}
    />
  );
}
