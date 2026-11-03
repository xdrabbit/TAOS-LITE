"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

// Subtitles, not a feed. While a segment is STREAMING, its scroll box keeps
// the end of the text — the words being written right now — in view. The
// moment it finalizes, the box stops moving. Tom's screenshot (10/23): a long
// Tabletop translation ran past the bottom of its pane mid-stream and the
// reader had to scroll to find the live line. Reading order is untouched —
// this replaces the newest-at-top idea (#100), it does not build on it.
//
// If the reader has scrolled UP to read history, nothing pulls them back:
// `detached` goes true and the screen offers <JumpToTail>. Scrolling back to
// the bottom, or tapping it, resumes following.
//
// The jump is a plain `scrollTop = scrollHeight` on every chunk — no smooth
// scroll to fight the next chunk — and the box should carry
// `[overflow-anchor:none]` so Safari's own anchoring doesn't move it twice.
// A rotated pane (Tabletop's top half, `rotate-180`) needs nothing special:
// the transform is paint only, so the DOM bottom is still that reader's tail.

// How close to the bottom still counts as "at the tail". Generous on purpose:
// a line of text, plus whatever iOS rubber-banding leaves behind.
export const TAIL_SLACK_PX = 32;

export function atTail(el: HTMLElement): boolean {
  // Past the end (rubber-band overshoot) reads negative — still at the tail.
  return el.scrollHeight - el.scrollTop - el.clientHeight <= TAIL_SLACK_PX;
}

export type FollowTail<T extends HTMLElement> = {
  ref: (el: T | null) => void;
  /** The reader scrolled away from a segment that is still streaming. */
  detached: boolean;
  jumpToTail: () => void;
};

/**
 * @param streaming a segment is being written into this box right now
 * @param content   the streaming text (or anything that changes per chunk)
 */
export function useFollowTail<T extends HTMLElement = HTMLDivElement>(
  streaming: boolean,
  content: unknown
): FollowTail<T> {
  const elRef = useRef<T | null>(null);
  // Decided by the reader's scrolling, never by the geometry after a chunk
  // lands — by then the box has grown and "at the bottom" is already false.
  const followingRef = useRef(true);
  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;
  const [detached, setDetached] = useState(false);

  const onScroll = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    const at = atTail(el);
    followingRef.current = at;
    setDetached(!at && streamingRef.current);
  }, []);

  const ref = useCallback(
    (el: T | null) => {
      if (elRef.current) elRef.current.removeEventListener("scroll", onScroll);
      elRef.current = el;
      if (el) el.addEventListener("scroll", onScroll, { passive: true });
    },
    [onScroll]
  );

  // Layout effect: the jump lands before paint, so a chunk never flashes
  // below the fold first.
  useLayoutEffect(() => {
    if (!streaming) {
      setDetached(false);
      return;
    }
    const el = elRef.current;
    if (!el) return;
    if (followingRef.current) {
      el.scrollTop = el.scrollHeight;
    } else {
      setDetached(true);
    }
  }, [streaming, content]);

  const jumpToTail = useCallback(() => {
    const el = elRef.current;
    followingRef.current = true;
    setDetached(false);
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  return { ref, detached, jumpToTail };
}

// Icon only — no new copy in either language. Sits at the bottom of the box
// it serves (the box's wrapper must be `relative`); inside a rotated pane
// that is the far reader's bottom too.
export function JumpToTail({ show, onJump }: { show: boolean; onJump: () => void }) {
  if (!show) return null;
  return (
    <button
      type="button"
      onClick={onJump}
      data-jump-to-tail=""
      className="absolute bottom-2 left-1/2 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-emerald-300/40 bg-stone-950/90 text-lg text-emerald-200 shadow-lg"
    >
      ↓
    </button>
  );
}
