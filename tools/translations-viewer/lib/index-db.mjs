// The searchable index: one in-memory SQLite database per loaded record set,
// with a real FTS5 table over the two text columns.

import { loadSqlite } from "./sqlite.mjs";
import { summarise } from "./records.mjs";

/**
 * FTS5 MATCH is a query language, not a search box: an unbalanced quote or a
 * bare `AND` is a syntax error, and `-` or `*` mean something. Users type
 * neither reliably, so we translate a plain box into valid FTS5 and let the
 * power user opt into raw syntax.
 *
 * Returns null when there is nothing to match on (empty box) so callers can
 * skip the FTS join entirely and still honour the date/lang filters.
 */
export function buildMatchQuery(input, { raw = false } = {}) {
  const text = (input ?? "").trim();
  if (!text) return null;
  if (raw) return text;

  const OPERATOR = /^(OR|AND|NOT|NEAR)$/;
  // Everything FTS5 reads as syntax. Replaced with spaces, not deleted, so
  // "well-being" becomes the phrase "well being" — which is how FTS5 tokenised
  // it on the way in, and therefore what actually matches.
  const SYNTAX = /[*"()^:{}[\],\-+~]/g;

  const quote = (term, prefix) => {
    const cleaned = term.replace(SYNTAX, " ").replace(/\s+/g, " ").trim();
    return cleaned ? `"${cleaned}"${prefix ? "*" : ""}` : null;
  };

  // Split into quoted phrases and bare words, preserving order.
  const items = [];
  for (const piece of text.match(/"[^"]*"?|\S+/g) ?? []) {
    if (piece.startsWith('"')) {
      const term = quote(piece, false);
      if (term) items.push({ term });
      continue;
    }
    if (OPERATOR.test(piece)) {
      items.push({ operator: piece });
      continue;
    }
    const term = quote(piece, piece.endsWith("*"));
    if (term) items.push({ term });
  }

  // Join: an explicit operator is honoured, two adjacent terms get an AND.
  const out = [];
  for (const item of items) {
    if (item.operator) {
      // A leading or doubled operator is meaningless — drop it rather than
      // handing FTS5 a syntax error.
      if (out.length && !OPERATOR.test(out[out.length - 1])) out.push(item.operator);
      continue;
    }
    if (out.length && !OPERATOR.test(out[out.length - 1])) out.push("AND");
    out.push(item.term);
  }
  while (out.length && OPERATOR.test(out[out.length - 1])) out.pop();

  return out.length ? out.join(" ") : null;
}

/** Parse a date box into epoch ms. `to` is inclusive of the whole day. */
export function parseDateBound(value, { endOfDay = false } = {}) {
  const text = (value ?? "").trim();
  if (!text) return null;
  // A bare YYYY-MM-DD is read as local time, which is what a human typing a
  // date into a box means by it.
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [y, mo, d] = text.split("-").map(Number);
    const date = endOfDay
      ? new Date(y, mo - 1, d, 23, 59, 59, 999)
      : new Date(y, mo - 1, d, 0, 0, 0, 0);
    return date.getTime();
  }
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

export class TranslationIndex {
  #db;
  #sqlite;

  constructor(sqlite, db, { records, manifest, source, skipped }) {
    this.#sqlite = sqlite;
    this.#db = db;
    this.manifest = manifest ?? null;
    this.source = source;
    this.skipped = skipped ?? [];
    this.loadedAt = new Date().toISOString();
    this.summary = summarise(records);
  }

  static async build({ records, manifest = null, source, skipped = [], log }) {
    const sqlite = await loadSqlite({ log });
    const db = new sqlite.oo1.DB(":memory:");

    db.exec(`
      create table rows_raw (
        rowid integer primary key,
        id text,
        source_table text,
        created_at text,
        created_ms integer,
        user_id text,
        source_lang text,
        target_lang text,
        tone text,
        engine text,
        original_text text,
        translation_text text,
        extra text
      );
      create index rows_created on rows_raw(created_ms);
    `);

    // External-content FTS5: the text lives once, in rows_raw.
    db.exec(`
      create virtual table rows_fts using fts5(
        original_text,
        translation_text,
        content='rows_raw',
        content_rowid='rowid',
        tokenize="unicode61 remove_diacritics 2"
      );
    `);

    const insert = db.prepare(`
      insert into rows_raw (
        rowid, id, source_table, created_at, created_ms, user_id,
        source_lang, target_lang, tone, engine,
        original_text, translation_text, extra
      ) values (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    try {
      db.exec("begin");
      let rowid = 1;
      for (const r of records) {
        insert
          .bind([
            rowid,
            r.id ?? null,
            r.source_table ?? null,
            r.created_at ?? null,
            r.created_ms ?? null,
            r.user_id ?? null,
            r.source_lang ?? null,
            r.target_lang ?? null,
            r.tone ?? null,
            r.engine ?? null,
            r.original_text ?? "",
            r.translation_text ?? "",
            r.extra && Object.keys(r.extra).length ? JSON.stringify(r.extra) : null
          ])
          .stepReset();
        rowid += 1;
      }
      db.exec("commit");
    } finally {
      insert.finalize();
    }

    // Populate the external-content index in one pass.
    db.exec("insert into rows_fts(rows_fts) values('rebuild')");

    return new TranslationIndex(sqlite, db, {
      records,
      manifest,
      source,
      skipped
    });
  }

  #where(filters) {
    const clauses = [];
    const binds = [];
    const eq = (column, value) => {
      if (value === undefined || value === null || value === "") return;
      clauses.push(`rows_raw.${column} = ?`);
      binds.push(value);
    };

    eq("source_lang", filters.sourceLang);
    eq("target_lang", filters.targetLang);
    eq("engine", filters.engine);
    eq("source_table", filters.table);
    eq("user_id", filters.userId);

    if (filters.fromMs != null) {
      clauses.push("rows_raw.created_ms >= ?");
      binds.push(filters.fromMs);
    }
    if (filters.toMs != null) {
      clauses.push("rows_raw.created_ms <= ?");
      binds.push(filters.toMs);
    }
    return { clauses, binds };
  }

  /**
   * Search. `match` is an FTS5 expression or null (filters only).
   * Returns { total, rows } where rows carry FTS5 snippets when matching.
   */
  search({
    match = null,
    limit = 50,
    offset = 0,
    order = "newest",
    ...filters
  } = {}) {
    const { clauses, binds } = this.#where(filters);
    const orderBy =
      order === "oldest"
        ? "rows_raw.created_ms asc"
        : order === "relevance" && match
          ? "rows_fts.rank asc"
          : "rows_raw.created_ms desc";

    const from = match
      ? "rows_fts join rows_raw on rows_raw.rowid = rows_fts.rowid"
      : "rows_raw";
    const all = match ? ["rows_fts match ?", ...clauses] : clauses;
    const whereSql = all.length ? `where ${all.join(" and ")}` : "";
    const whereBinds = match ? [match, ...binds] : binds;

    const total = this.#one(
      `select count(*) as n from ${from} ${whereSql}`,
      whereBinds
    ).n;

    // Control characters, not `<mark>`: the snippet also carries user text, so
    // the client escapes the whole string and only then swaps these in. A
    // literal "<mark>" typed by a user can never become a tag this way.
    const snippetCols = match
      ? `,
         snippet(rows_fts, 0, char(1), char(2), '…', 12) as original_snippet,
         snippet(rows_fts, 1, char(1), char(2), '…', 12) as translation_snippet`
      : "";

    const rows = this.#all(
      `select rows_raw.id, rows_raw.source_table, rows_raw.created_at,
              rows_raw.created_ms, rows_raw.user_id, rows_raw.source_lang,
              rows_raw.target_lang, rows_raw.tone, rows_raw.engine,
              rows_raw.original_text, rows_raw.translation_text, rows_raw.extra
              ${snippetCols}
         from ${from}
         ${whereSql}
        order by ${orderBy}
        limit ? offset ?`,
      [...whereBinds, limit, offset]
    );

    for (const row of rows) {
      row.extra = row.extra ? JSON.parse(row.extra) : null;
    }
    return { total, rows };
  }

  /** Every matching record, unpaginated — what the JSON export writes. */
  all(options = {}) {
    const { total } = this.search({ ...options, limit: 1, offset: 0 });
    if (!total) return [];
    const { rows } = this.search({ ...options, limit: total, offset: 0 });
    for (const row of rows) {
      delete row.original_snippet;
      delete row.translation_snippet;
    }
    return rows;
  }

  #all(sql, binds) {
    const out = [];
    this.#db.exec({
      sql,
      bind: binds,
      rowMode: "object",
      callback: (row) => out.push(row)
    });
    return out;
  }

  #one(sql, binds) {
    return this.#all(sql, binds)[0] ?? {};
  }

  close() {
    try {
      this.#db.close();
    } catch {
      /* already closed */
    }
  }
}
