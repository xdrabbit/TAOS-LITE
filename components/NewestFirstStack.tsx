"use client";

import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";

// ── A stack, not a teleprompter (Tom, 2026-10-22) ──────────────────────────
// "The new stuff stays at the top where it's visible, and the old stuff gets
// pushed down — like a stack, last in, first out." /live and /tabletop render
// their lines newest-first inside one of these, and this component's only job
// is to keep the reader's eyes still while that happens:
//
//  • PINNED (scrolled to the top, the default): stay at scrollTop 0. The new
//    item lands at the top, everything else slides down and eventually off
//    the bottom. Nothing the reader is looking at scrolls away upward.
//  • READING HISTORY (scrolled down): never yank them back. Whatever line was
//    at the top of their view stays exactly where it was — the new item grows
//    the content ABOVE it and the scroll position grows by the same amount —
//    and a small ↑ appears that takes them back to the top. Scrolling back up
//    by hand does the same.
//
// The position is restored by hand, from layout offsets. Browser scroll
// anchoring (`overflow-anchor`) would do some of this, but iOS Safari has
// never shipped it, so it is switched OFF here and every engine gets the same
// arithmetic. offsetTop, not getBoundingClientRect: /tabletop rotates its top
// pane 180°, and a transformed rect reads upside down; layout offsets don't.
//
// Every item that a reader could be looking at carries `data-stack-item` —
// that is what the anchor is chosen from.

/** Within this many px of the top counts as "at the top" (rubber-banding). */
const PIN_PX = 8;

interface Anchor {
  el: HTMLElement;
  /** The anchor's offsetTop minus scrollTop when it was recorded. */
  delta: number;
}

export function NewestFirstStack({
  contentKey,
  className = "",
  children
}: {
  /** Changes whenever an item arrives, finalizes, or a streaming one grows. */
  contentKey: string;
  className?: string;
  children?: ReactNode;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const anchorRef = useRef<Anchor | null>(null);
  const mountedRef = useRef(false);
  // Something new arrived while the reader was down in the history.
  const [fresh, setFresh] = useState(false);

  // Where is the reader, and which line are they looking at?
  const record = useCallback(() => {
    const box = scrollRef.current;
    if (!box) return;
    const top = box.scrollTop;
    pinnedRef.current = top <= PIN_PX;
    anchorRef.current = null;
    if (pinnedRef.current) return;
    const items = box.querySelectorAll<HTMLElement>("[data-stack-item]");
    for (const el of Array.from(items)) {
      if (el.offsetTop + el.offsetHeight > top) {
        anchorRef.current = { el, delta: el.offsetTop - top };
        return;
      }
    }
  }, []);

  const onScroll = useCallback(() => {
    record();
    if (pinnedRef.current) setFresh(false);
  }, [record]);

  // After every content change, before paint.
  useLayoutEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    if (pinnedRef.current) {
      // Only ever pull DOWN to 0. A negative scrollTop is iOS rubber-banding
      // past the top under the reader's finger; writing to it fights them.
      if (box.scrollTop > 0) box.scrollTop = 0;
    } else {
      const a = anchorRef.current;
      if (a && a.el.isConnected) {
        const target = a.el.offsetTop - a.delta;
        if (Math.abs(box.scrollTop - target) > 0.5) box.scrollTop = target;
      }
      setFresh(true);
    }
    record();
  }, [contentKey, record]);

  const backToTop = useCallback(() => {
    const box = scrollRef.current;
    if (box) box.scrollTop = 0;
    pinnedRef.current = true;
    anchorRef.current = null;
    setFresh(false);
  }, []);

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      data-testid="newest-first-stack"
      className={`relative overflow-y-auto overscroll-contain ${className}`}
      style={{ overflowAnchor: "none" }}
    >
      {/* Zero-height and sticky, so it rides the top edge of the view without
          moving a single item — the anchor arithmetic never sees it. */}
      <div className="pointer-events-none sticky top-0 z-10 flex h-0 items-start justify-center">
        {fresh ? (
          <button
            type="button"
            onClick={backToTop}
            data-testid="stack-back-to-top"
            className="pointer-events-auto mt-1 rounded-full bg-emerald-400 px-4 py-1 text-base font-bold text-stone-950 shadow-lg shadow-black/40"
          >
            ↑
          </button>
        ) : null}
      </div>
      {children}
    </div>
  );
}
