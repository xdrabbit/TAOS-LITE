"use client";

import { useEffect, useState } from "react";
import {
  clearHistory,
  deleteHistoryItem,
  listHistory,
  type HistoryRow
} from "@/lib/supabase";

const LANG_LABEL: Record<string, string> = { en: "English", es: "Español" };

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
  } catch {
    return iso;
  }
}

export function HistoryDrawer({
  open,
  onClose
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element | null {
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(null);
    listHistory()
      .then((data) => {
        if (active) setRows(data);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : "Could not load history · No se pudo cargar el historial.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open]);

  if (!open) return null;

  async function remove(id: string) {
    const prev = rows;
    setRows((r) => r.filter((x) => x.id !== id));
    try {
      await deleteHistoryItem(id);
    } catch (e) {
      setRows(prev);
      setError(e instanceof Error ? e.message : "Delete failed.");
    }
  }

  async function clearAll() {
    if (
      !window.confirm(
        "Delete your entire history? This can't be undone.\n¿Borrar todo el historial? No se puede deshacer."
      )
    ) {
      return;
    }
    const prev = rows;
    setRows([]);
    try {
      await clearHistory();
    } catch (e) {
      setRows(prev);
      setError(e instanceof Error ? e.message : "Clear failed.");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[rgba(9,9,9,0.96)] backdrop-blur">
      <div className="flex items-center justify-between border-b border-white/10 px-4 pb-3 pt-[calc(env(safe-area-inset-top)+0.75rem)]">
        <h2 className="text-lg font-semibold text-amber-200">History · Historial</h2>
        <div className="flex items-center gap-2">
          {rows.length > 0 ? (
            <button
              type="button"
              onClick={clearAll}
              className="rounded-full border border-rose-400/30 bg-rose-500/10 px-3 py-1.5 text-sm text-rose-200"
            >
              Clear all · Borrar
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-amber-100"
          >
            Close · Cerrar
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        {loading ? (
          <p className="animate-pulse text-amber-100/60">Loading… · Cargando…</p>
        ) : error ? (
          <p className="text-rose-300">{error}</p>
        ) : rows.length === 0 ? (
          <p className="text-amber-100/50">No translations saved yet · Aún no hay traducciones.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {rows.map((row) => (
              <li
                key={row.id}
                className="rounded-2xl border border-white/10 bg-[rgba(20,16,14,0.86)] p-4"
              >
                <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-wider text-amber-100/40">
                  <span>
                    {LANG_LABEL[row.source_lang] ?? row.source_lang} →{" "}
                    {LANG_LABEL[row.target_lang] ?? row.target_lang} · {row.tone}
                  </span>
                  <span>{fmtTime(row.created_at)}</span>
                </div>
                <p className="text-lg font-medium leading-snug text-white">
                  {row.translation_text}
                </p>
                <p className="mt-2 text-sm text-amber-50/45">{row.original_text}</p>
                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    onClick={() => void remove(row.id)}
                    className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-rose-200/90"
                  >
                    Delete · Eliminar
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
