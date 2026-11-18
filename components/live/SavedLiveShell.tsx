"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { authHeaders } from "@/lib/authClient";
import { copyFor, fill } from "@/lib/chrome/copy";
import { languageNative, type LanguageCode } from "@/lib/languages/catalog";
import { useLanguagePair } from "@/lib/translate/useLanguagePair";
import type { SavedLiveLine, SavedLiveSession } from "@/lib/live/saved";
import { ExitHome } from "@/components/ExitHome";

// /live/saved: the conversations this user saved from /live. A list; tap one
// to read it; Export hands over a .txt; Delete removes it (and its lines) for
// good. Everything shown here is text — this feature stores no audio.
//
// Nothing saved is out of reach from here. The list arrives a page at a time
// and "Show older" asks for the next one until the server says there is no
// more; a conversation is read whole, and in the one case where it is not
// (longer than the server will read in one go) the screen says how many lines
// it is showing out of how many.
//
// The chrome follows the phone's owner (lib/chrome/copy.ts). The conversation
// itself is shown as it was saved: each half under the name of its language,
// and "?" where the language was not detected.

type Load = "loading" | "ready" | "not_ready" | "failed";

function nameOf(code: string | null): string {
  return code ? languageNative(code as LanguageCode) : "?";
}

function when(iso: string): string {
  try {
    return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

export function SavedLiveShell(): JSX.Element {
  const { mine } = useLanguagePair();
  const t = copyFor(mine);
  const [load, setLoad] = useState<Load>("loading");
  const [sessions, setSessions] = useState<SavedLiveSession[]>([]);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<{
    session: SavedLiveSession;
    lines: SavedLiveLine[];
    total: number;
    complete: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  // One page of the list from `offset`. Returns null when it could not be had.
  const page = useCallback(async (offset: number) => {
    const res = await fetch(`/api/live/saved${offset ? `?offset=${offset}` : ""}`, {
      headers: await authHeaders(),
      cache: "no-store"
    });
    const body = (await res.json().catch(() => null)) as
      | { ready?: boolean; sessions?: SavedLiveSession[]; more?: boolean }
      | null;
    return res.ok && body ? body : null;
  }, []);

  const refresh = useCallback(async () => {
    setFailed(false);
    try {
      const body = await page(0);
      if (!body) return setLoad("failed");
      setSessions(body.sessions ?? []);
      setMore(body.more === true);
      setLoad(body.ready ? "ready" : "not_ready");
    } catch {
      setLoad("failed");
    }
  }, [page]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The next page starts after what is on the screen. A conversation saved or
  // deleted since the last page can shift the server's rows by one, so a row
  // already shown is not shown twice.
  const loadMore = useCallback(async () => {
    setBusy(true);
    setFailed(false);
    try {
      const body = await page(sessions.length);
      if (!body) return setFailed(true);
      const older = body.sessions ?? [];
      setSessions((prev) => {
        const seen = new Set(prev.map((s) => s.id));
        return [...prev, ...older.filter((s) => !seen.has(s.id))];
      });
      setMore(body.more === true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, [page, sessions.length]);

  const read = useCallback(async (id: string) => {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch(`/api/live/saved/${id}`, { headers: await authHeaders(), cache: "no-store" });
      const body = (await res.json().catch(() => null)) as
        | { session?: SavedLiveSession; lines?: SavedLiveLine[]; total?: number; complete?: boolean }
        | null;
      if (!res.ok || !body?.session) return setFailed(true);
      const lines = body.lines ?? [];
      const total = typeof body.total === "number" ? body.total : lines.length;
      // Whole only if the server says so AND the numbers agree.
      setOpen({ session: body.session, lines, total, complete: body.complete !== false && lines.length >= total });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, []);

  // The export is fetched with the session's own credentials and handed over
  // as a file: a plain link could not carry the Authorization header.
  const exportText = useCallback(async (id: string) => {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch(`/api/live/saved/${id}?format=text`, { headers: await authHeaders(), cache: "no-store" });
      if (!res.ok) return setFailed(true);
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "taos-live.txt";
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, []);

  const remove = useCallback(
    async (id: string) => {
      if (!window.confirm(t.liveSavedDeleteConfirm)) return;
      setBusy(true);
      setFailed(false);
      try {
        const res = await fetch(`/api/live/saved/${id}`, { method: "DELETE", headers: await authHeaders() });
        if (!res.ok) return setFailed(true);
        setOpen(null);
        setSessions((prev) => prev.filter((s) => s.id !== id));
      } catch {
        setFailed(true);
      } finally {
        setBusy(false);
      }
    },
    [t.liveSavedDeleteConfirm]
  );

  const chip = "rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] text-amber-100/70 disabled:opacity-50";

  return (
    <main className="min-h-screen px-4 pb-10 pt-[calc(env(safe-area-inset-top)+1rem)]">
      <div className="mx-auto flex max-w-md flex-col gap-4">
        <header className="flex items-center gap-3">
          <ExitHome lang={mine} />
          <h1 className="text-lg font-semibold tracking-tight text-amber-200">TAOS·LITE</h1>
        </header>

        <div>
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs uppercase tracking-[0.2em] text-amber-100/50">{t.liveSavedTitle}</div>
            <Link href="/live" className="text-[11px] text-amber-100/60 underline underline-offset-2">
              ← {t.liveSavedToLive}
            </Link>
          </div>
          <p className="mt-1 text-sm text-amber-50/70">{t.liveSavedAbout}</p>
        </div>

        {failed || load === "failed" ? (
          <p role="status" className="rounded-2xl border border-amber-300/25 bg-amber-400/5 px-4 py-3 text-sm text-amber-100/80">
            {t.liveSavedLoadFailed}
          </p>
        ) : null}

        {open ? (
          <section data-saved-open="" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={chip} onClick={() => setOpen(null)}>
                ← {t.liveSavedBack}
              </button>
              <button type="button" className={chip} disabled={busy} onClick={() => void exportText(open.session.id)}>
                {t.liveSavedExport}
              </button>
              <button
                type="button"
                className="rounded-full border border-rose-400/30 bg-rose-500/10 px-3 py-1 text-[11px] text-rose-200 disabled:opacity-50"
                disabled={busy}
                onClick={() => void remove(open.session.id)}
              >
                {t.liveSavedDelete}
              </button>
            </div>
            <p className="text-xs text-amber-100/50">
              {when(open.session.started_at)} · {nameOf(open.session.lang_mine)} {open.session.auto ? "⇄" : "←"}{" "}
              {nameOf(open.session.lang_theirs)}
              {open.session.auto ? ` · ${t.liveAutoChip}` : ""}
            </p>
            {open.complete ? null : (
              <p
                data-saved-partial=""
                role="status"
                className="rounded-2xl border border-amber-300/25 bg-amber-400/5 px-4 py-3 text-sm text-amber-100/80"
              >
                {fill(t.liveSavedPartial, { shown: open.lines.length, total: open.total })}
              </p>
            )}
            <ol className="flex flex-col gap-2">
              {open.lines.map((line) => (
                <li
                  key={line.seq}
                  data-saved-line=""
                  className={`rounded-3xl border p-4 ${
                    line.detect === "miss"
                      ? "border-dashed border-amber-300/40 bg-amber-400/[0.04]"
                      : "border-white/10 bg-[rgba(18,44,36,0.7)]"
                  }`}
                >
                  {line.heard_text ? (
                    <div className="mb-3">
                      <span className="rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-wider text-amber-100/70">
                        {nameOf(line.heard_lang)}
                      </span>
                      <p className="mt-1 text-pretty text-base leading-snug text-amber-50/80">{line.heard_text}</p>
                    </div>
                  ) : null}
                  <span className="rounded-full border border-emerald-300/30 bg-emerald-400/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-emerald-100/80">
                    {line.translation_lang ? nameOf(line.translation_lang) : `? · ${t.liveAutoMissTag}`}
                  </span>
                  <p className="mt-1 text-pretty text-lg font-semibold leading-snug text-white">{line.translation}</p>
                </li>
              ))}
            </ol>
          </section>
        ) : load === "loading" ? (
          <p className="text-sm text-amber-100/40">…</p>
        ) : load === "not_ready" ? (
          <p className="rounded-3xl border border-dashed border-white/10 px-5 py-10 text-center text-amber-100/50">
            {t.liveSavedNotReady}
          </p>
        ) : load === "ready" && sessions.length === 0 ? (
          <p className="rounded-3xl border border-dashed border-white/10 px-5 py-10 text-center text-amber-100/50">
            {t.liveSavedEmpty}
          </p>
        ) : (
          <>
            <ol data-saved-list="" className="flex flex-col gap-2">
              {sessions.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void read(s.id)}
                    className="w-full rounded-3xl border border-white/10 bg-[rgba(18,44,36,0.7)] p-4 text-left disabled:opacity-60"
                  >
                    <div className="text-base font-semibold text-white">{when(s.started_at)}</div>
                    <div className="mt-1 text-xs text-amber-100/60">
                      {nameOf(s.lang_mine)} {s.auto ? "⇄" : "←"} {nameOf(s.lang_theirs)}
                      {s.auto ? ` · ${t.liveAutoChip}` : ""} · {fill(t.liveSavedLines, { count: s.line_count ?? 0 })}
                    </div>
                  </button>
                </li>
              ))}
            </ol>
            {more ? (
              <button
                type="button"
                data-saved-more=""
                disabled={busy}
                onClick={() => void loadMore()}
                className={`self-center ${chip}`}
              >
                {t.liveSavedMore}
              </button>
            ) : null}
          </>
        )}
      </div>
    </main>
  );
}
