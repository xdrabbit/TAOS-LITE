// Normalising translation records from every shape we read them in.
//
// Three shapes reach this module:
//   1. Live rows from public.taos_lite_translations (PostgREST JSON).
//   2. The existing NDJSON exports in local_exports/ — a manifest line, then
//      {record, source_table} lines, mixing translations and chat messages.
//   3. JSON this viewer wrote itself ({manifest, records}), or a bare array.
//   4. CSV with a header row, as the Supabase dashboard exports it.
// Everything lands in one flat record shape so one FTS5 index covers all of it.

export const TRANSLATIONS_TABLE = "public.taos_lite_translations";
export const CHAT_TABLE = "public.taos_lite_chat_messages";

/** Columns the live fetch asks PostgREST for. Mirrors the export manifest. */
export const TRANSLATION_COLUMNS = [
  "id",
  "user_id",
  "created_at",
  "source_lang",
  "target_lang",
  "tone",
  "original_text",
  "translation_text",
  "engine",
  "fast_sealed_at"
];

const KNOWN_TRANSLATION_KEYS = new Set(TRANSLATION_COLUMNS);
const KNOWN_CHAT_KEYS = new Set([
  "id",
  "thread_id",
  "sender_id",
  "body",
  "body_translated",
  "source_lang",
  "target_lang",
  "created_at",
  "read_at",
  "kind",
  "audio_path"
]);

function toMillis(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function leftovers(row, known) {
  const extra = {};
  for (const [key, value] of Object.entries(row)) {
    if (!known.has(key) || value === null || value === undefined) continue;
    if (
      key === "id" ||
      key === "created_at" ||
      key === "source_lang" ||
      key === "target_lang"
    ) {
      continue;
    }
    extra[key] = value;
  }
  return extra;
}

/** A row of public.taos_lite_translations → normalised record. */
export function fromTranslationRow(row) {
  const createdAt = row.created_at ?? null;
  return {
    id: row.id ?? null,
    source_table: TRANSLATIONS_TABLE,
    created_at: createdAt,
    created_ms: toMillis(createdAt),
    user_id: row.user_id ?? null,
    source_lang: row.source_lang ?? null,
    target_lang: row.target_lang ?? null,
    tone: row.tone ?? null,
    engine: row.engine ?? null,
    original_text: row.original_text ?? "",
    translation_text: row.translation_text ?? "",
    extra: leftovers(row, KNOWN_TRANSLATION_KEYS)
  };
}

/** A row of public.taos_lite_chat_messages → normalised record. */
export function fromChatRow(row) {
  const createdAt = row.created_at ?? null;
  return {
    id: row.id ?? null,
    source_table: CHAT_TABLE,
    created_at: createdAt,
    created_ms: toMillis(createdAt),
    user_id: row.sender_id ?? null,
    source_lang: row.source_lang ?? null,
    target_lang: row.target_lang ?? null,
    tone: null,
    engine: null,
    original_text: row.body ?? "",
    translation_text: row.body_translated ?? "",
    extra: leftovers(row, KNOWN_CHAT_KEYS)
  };
}

/** Dispatch on the source table an export line declares. */
export function fromExportRecord(record, sourceTable) {
  if (sourceTable === CHAT_TABLE) return fromChatRow(record);
  if (sourceTable === TRANSLATIONS_TABLE) return fromTranslationRow(record);
  // Unknown table: guess from the columns present rather than dropping data.
  if ("body" in record || "body_translated" in record) {
    const mapped = fromChatRow(record);
    mapped.source_table = sourceTable ?? CHAT_TABLE;
    return mapped;
  }
  const mapped = fromTranslationRow(record);
  mapped.source_table = sourceTable ?? TRANSLATIONS_TABLE;
  return mapped;
}

/**
 * Parse an export file's text into { manifest, records }.
 * Accepts this viewer's JSON, a bare JSON array, and the NDJSON in
 * local_exports/. Malformed lines are collected rather than thrown, so one bad
 * line cannot hide 5,000 good ones.
 */
export function parseExport(text) {
  const trimmed = text.replace(/^﻿/, "").trim();
  if (!trimmed) return { manifest: null, records: [], skipped: [] };

  // A CSV with a header row (the Supabase dashboard's "export to CSV").
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
    const csv = parseCsvRecords(trimmed);
    if (csv) return csv;
  }

  // Try whole-file JSON first (this viewer's own export, or a bare array).
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return {
          manifest: null,
          records: parsed.map((r) => normaliseMaybeWrapped(r)),
          skipped: []
        };
      }
      if (Array.isArray(parsed.records)) {
        return {
          manifest: parsed.manifest ?? null,
          records: parsed.records.map((r) => normaliseMaybeWrapped(r)),
          skipped: []
        };
      }
    } catch {
      // Not whole-file JSON — almost certainly NDJSON, handled below.
    }
  }

  const records = [];
  const skipped = [];
  let manifest = null;
  const lines = trimmed.split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      skipped.push({ line: i + 1, reason: err.message });
      continue;
    }
    if (parsed && parsed.record_type === "export_manifest") {
      manifest = parsed;
      continue;
    }
    records.push(normaliseMaybeWrapped(parsed));
  }

  return { manifest, records, skipped };
}

/**
 * RFC 4180 CSV → rows of fields. Quoted fields may hold commas, doubled
 * quotes and newlines — translation text has all three.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** CSV with a header naming translation or chat columns; null if not one. */
function parseCsvRecords(text) {
  const rows = parseCsv(text);
  const header = rows[0]?.map((h) => h.trim());
  if (!header || !(header.includes("original_text") || header.includes("body"))) return null;

  const records = [];
  const skipped = [];
  for (let i = 1; i < rows.length; i += 1) {
    const fields = rows[i];
    if (fields.length === 1 && fields[0] === "") continue;
    if (fields.length !== header.length) {
      skipped.push({ line: i + 1, reason: `expected ${header.length} fields, got ${fields.length}` });
      continue;
    }
    const row = {};
    // The dashboard writes NULL as an empty field.
    header.forEach((key, j) => (row[key] = fields[j] === "" ? null : fields[j]));
    records.push(fromExportRecord(row));
  }
  return { manifest: null, records, skipped };
}

/** Handle both {record, source_table} envelopes and already-flat records. */
function normaliseMaybeWrapped(entry) {
  if (entry && typeof entry === "object" && entry.record) {
    return fromExportRecord(entry.record, entry.source_table);
  }
  if (entry && typeof entry === "object" && entry.source_table && "created_ms" in entry) {
    return entry; // already normalised by this viewer
  }
  return fromExportRecord(entry ?? {}, entry?.source_table);
}

/**
 * Merge record sets, dropping duplicates. The FIRST copy wins, so pass the
 * most authoritative set (live) first.
 *
 * A record with an id is the same record as another with that id in the same
 * table. Some old exports carry no id at all, so every record is also keyed on
 * what it says and when (to the millisecond — exports disagree on how many
 * microseconds they print), and an id-less record is dropped if anything
 * already kept says the same thing at the same moment.
 */
export function dedupe(recordSets) {
  const byId = new Set();
  const byContent = new Set();
  const kept = [];
  let duplicates = 0;
  const contentKey = (r) =>
    `${r.created_ms ?? r.created_at ?? ""}\u0000${r.original_text}\u0000${r.translation_text}`;

  // Id-bearing records first, from every set, so an id-less copy can never
  // shadow the fuller record it duplicates.
  const all = recordSets.flat();
  for (const pass of [true, false]) {
    for (const r of all) {
      if (Boolean(r.id) !== pass) continue;
      const content = contentKey(r);
      if (r.id) {
        const id = `${r.source_table}\u0000${r.id}`;
        if (byId.has(id)) {
          duplicates += 1;
          continue;
        }
        byId.add(id);
      } else if (byContent.has(content)) {
        duplicates += 1;
        continue;
      }
      byContent.add(content);
      kept.push(r);
    }
  }
  return { records: kept, duplicates };
}

/** Roll a record set up into the numbers the UI shows above the results. */
export function summarise(records) {
  const sourceLangs = new Map();
  const targetLangs = new Map();
  const engines = new Map();
  const tables = new Map();
  let first = null;
  let last = null;
  const users = new Set();

  const bump = (map, key) => {
    if (key === null || key === undefined || key === "") return;
    map.set(key, (map.get(key) ?? 0) + 1);
  };

  for (const r of records) {
    bump(sourceLangs, r.source_lang);
    bump(targetLangs, r.target_lang);
    bump(engines, r.engine);
    bump(tables, r.source_table);
    if (r.user_id) users.add(r.user_id);
    if (r.created_ms != null) {
      if (first === null || r.created_ms < first) first = r.created_ms;
      if (last === null || r.created_ms > last) last = r.created_ms;
    }
  }

  const sortedEntries = (map) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
      .map(([value, count]) => ({ value, count }));

  return {
    total: records.length,
    users: users.size,
    firstAt: first === null ? null : new Date(first).toISOString(),
    lastAt: last === null ? null : new Date(last).toISOString(),
    sourceLangs: sortedEntries(sourceLangs),
    targetLangs: sortedEntries(targetLangs),
    engines: sortedEntries(engines),
    tables: sortedEntries(tables)
  };
}
