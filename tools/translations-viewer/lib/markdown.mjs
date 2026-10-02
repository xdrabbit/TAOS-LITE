// Rendering an export as a readable Markdown document.
//
// The JSON export is for machines and round-trips back into the viewer. This
// one is for people: a transcript grouped by day, original quoted and
// translation beneath it, with the filters that produced it recorded at the
// top so the file can still be explained a year later.
//
// Everything in a record is user text, so it is escaped before it goes in — a
// translation containing "#" or "*" must not restructure the document.

/** Characters that open inline markup (or HTML) anywhere in a line. */
const INLINE = /[\\`*_[\]<>]/g;

/**
 * Escape one line's worth of user text.
 * Inline markup is escaped everywhere; block markers only where they would
 * actually start a block, so a mid-sentence hyphen stays a hyphen.
 */
function escapeLine(line) {
  const inline = line.replace(INLINE, (c) => `\\${c}`);
  // `#` heading, `+` bullet, `|` table, `=` setext, `1.` ordered item, and a
  // run of dashes — which is a bullet, a horizontal rule, or (directly under
  // text) a setext H2 that would silently promote the line above it.
  return inline.replace(/^(\s*)([#+=|]|-+(?=\s|$)|\d+[.)](?=\s))/, "$1\\$2");
}

/** Escape a whole field, preserving its line breaks. */
export function escapeMarkdown(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map(escapeLine)
    .join("\n");
}

/** Render user text as a blockquote, one `>` per line. */
function blockquote(text) {
  const escaped = escapeMarkdown(text).split("\n");
  return escaped.map((line) => (line ? `> ${line}` : ">")).join("\n");
}

/** Render user text as plain paragraphs, keeping hard line breaks. */
function paragraphs(text) {
  return escapeMarkdown(text)
    .split("\n")
    .map((line) => line.trimEnd())
    .join("  \n"); // two trailing spaces = a hard break in Markdown
}

/** Longest run of backticks in a string, so a code span can out-fence it. */
function longestBacktickRun(text) {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return longest;
}

/** Minimal YAML scalar quoting for the front matter. */
function yamlString(value) {
  const text = String(value ?? "");
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Name the zone rather than leaning on the process's. server.mjs pins
// TZ=America/Denver, but this module is also imported directly — by the tests,
// and by anything else that wants a transcript — and ambient TZ silently
// regroups every day boundary when it differs (CI runs in UTC, which moved a
// 21:52 record onto the following day). This is the same zone public/index.html
// names, and the one the From/To filters are read in.
const ZONE = "America/Denver";

const DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONE,
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric"
});
const TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
});
// en-CA renders ISO-shaped YYYY-MM-DD, which is what the day key needs.
const YMD = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});
const dayKey = (ms) => YMD.format(new Date(ms));

/**
 * Render an export payload ({ manifest, summary, records }) as Markdown.
 * Records are grouped by local day, oldest first within each day, so the
 * document reads forwards like a transcript.
 */
export function renderMarkdown({ manifest, summary, records }) {
  const out = [];
  const count = records.length;

  // --- front matter: the same facts as the JSON manifest, machine-readable.
  out.push("---");
  out.push(`tool: ${yamlString(manifest?.tool ?? "tools/translations-viewer")}`);
  out.push(`exported_at: ${yamlString(manifest?.exported_at ?? new Date().toISOString())}`);
  const source = manifest?.source;
  out.push(
    `source: ${yamlString(
      source?.kind === "live"
        ? "live database"
        : source?.file
          ? source.file
          : (source?.kind ?? "unknown")
    )}`
  );
  out.push(`record_count: ${count}`);
  if (summary?.firstAt) out.push(`first_at: ${yamlString(summary.firstAt)}`);
  if (summary?.lastAt) out.push(`last_at: ${yamlString(summary.lastAt)}`);
  if (manifest?.fts5_match) out.push(`fts5_match: ${yamlString(manifest.fts5_match)}`);
  if (manifest?.filters?.length) {
    out.push("filters:");
    for (const filter of manifest.filters) out.push(`  - ${yamlString(filter)}`);
  }
  out.push("---");
  out.push("");

  // --- human header
  out.push("# TAOS-LITE translations");
  out.push("");

  // Local days, so the span agrees with the day headings below — a record at
  // 21:52 Mountain is stored as the next day in UTC, and slicing the ISO
  // string would print a date that appears nowhere in the document.
  const span =
    summary?.firstAt && summary?.lastAt
      ? `${dayKey(Date.parse(summary.firstAt))} → ${dayKey(Date.parse(summary.lastAt))}`
      : null;
  const headline = [
    `**${count.toLocaleString()}** ${count === 1 ? "record" : "records"}`,
    span,
    summary?.users ? `${summary.users} ${summary.users === 1 ? "person" : "people"}` : null
  ].filter(Boolean);
  out.push(headline.join(" · "));
  out.push("");

  if (manifest?.filters?.length) {
    out.push(`**Filters** — ${manifest.filters.map(escapeMarkdown).join(" · ")}`);
    out.push("");
  }
  if (manifest?.fts5_match) {
    // A code span, so FTS5 quoting survives verbatim. A query containing a
    // backtick needs a longer fence rather than a rewrite — the whole point of
    // recording the match is that it is the one that actually ran.
    const match = String(manifest.fts5_match);
    const fence = "`".repeat(longestBacktickRun(match) + 1);
    const pad = match.startsWith("`") || match.endsWith("`") ? " " : "";
    out.push(`**Search** — ${fence}${pad}${match}${pad}${fence}`);
    out.push("");
  }

  if (!count) {
    out.push("_Nothing matched these filters._");
    out.push("");
    return out.join("\n");
  }

  // --- the transcript, grouped by day
  const byDay = new Map();
  for (const record of records) {
    const key = record.created_ms == null ? "undated" : dayKey(record.created_ms);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(record);
  }
  const days = [...byDay.keys()].sort((a, b) => {
    if (a === "undated") return 1;
    if (b === "undated") return -1;
    return a.localeCompare(b);
  });

  for (const day of days) {
    const entries = byDay
      .get(day)
      .slice()
      .sort((a, b) => (a.created_ms ?? 0) - (b.created_ms ?? 0));

    out.push("---");
    out.push("");
    const heading =
      day === "undated"
        ? "Undated"
        : DAY.format(new Date(entries[0].created_ms));
    out.push(`## ${heading}`);
    out.push("");
    out.push(`_${entries.length.toLocaleString()} ${entries.length === 1 ? "record" : "records"}_`);
    out.push("");

    for (const record of entries) {
      const when = record.created_ms == null ? "—" : TIME.format(new Date(record.created_ms));
      const direction =
        record.source_lang && record.target_lang
          ? `${record.source_lang} → ${record.target_lang}`
          : null;
      const tags = [record.tone, record.engine].filter(Boolean).join(" · ");
      const chat = record.source_table?.includes("chat_messages") ? "chat" : null;

      out.push(
        [`**${when}**`, direction, tags || null, chat].filter(Boolean).join(" · ")
      );
      out.push("");
      if (record.original_text) {
        out.push(blockquote(record.original_text));
        out.push("");
      }
      if (record.translation_text) {
        out.push(paragraphs(record.translation_text));
        out.push("");
      }
    }
  }

  return out.join("\n");
}
