#!/usr/bin/env node
// TAOS-LITE translations viewer — a LOCAL tool.
//
// Browse the live taos_lite_translations table (or a saved export) with FTS5
// full-text search and date-range filtering, and write filtered JSON exports
// back to local_exports/.
//
// This is deliberately NOT a route in the app. It reads every user's
// translations with the service-role key, which is not something to put behind
// a web gate; it binds to localhost and ships nothing to Vercel.
//
//   node tools/translations-viewer/server.mjs [--port 3018] [--open] [--tailnet]
//
// --tailnet also listens on this machine's Tailscale address, so your own
// signed-in devices can open it with no password. It is never on the LAN.

import { createServer } from "node:http";
import { readFile, readdir, stat, writeFile, mkdir, open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import path from "node:path";

import { dedupe, parseExport, summarise } from "./lib/records.mjs";
import { TranslationIndex, buildMatchQuery, parseDateBound } from "./lib/index-db.mjs";
import { describeLive, fetchLiveRecords, readCredentials, readDotEnv } from "./lib/live.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const EXPORT_DIR = path.join(REPO_ROOT, "local_exports");
const PUBLIC_DIR = path.join(HERE, "public");

const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 3018;
const TAILNET = args.includes("--tailnet");

// Bare From/To dates are read as local days (parseDateBound). Pin "local" to
// Mountain so the filter matches the times the page shows, on any machine.
process.env.TZ = "America/Denver";

const log = (message) => console.log(`[viewer] ${message}`);

/** The one loaded record set. Replaced wholesale when a source is loaded. */
let current = null;

// ---------------------------------------------------------------- helpers

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store"
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 5_000_000) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err.message}`));
      }
    });
    req.on("error", reject);
  });
}

/** Turn query params into the filter/search options the index understands. */
function optionsFromQuery(params) {
  const raw = params.get("raw") === "1";
  return {
    match: buildMatchQuery(params.get("q"), { raw }),
    query: (params.get("q") ?? "").trim(),
    raw,
    fromMs: parseDateBound(params.get("from")),
    toMs: parseDateBound(params.get("to"), { endOfDay: true }),
    sourceLang: params.get("source_lang") || undefined,
    targetLang: params.get("target_lang") || undefined,
    engine: params.get("engine") || undefined,
    table: params.get("table") || undefined,
    userId: params.get("user_id") || undefined,
    order: params.get("order") || "newest"
  };
}

function requireIndex(res) {
  if (!current) {
    sendJson(res, 409, { error: "No data loaded yet. Load a source first." });
    return null;
  }
  return current;
}

/**
 * Where export files are listed from: local_exports/ always, plus an optional
 * history folder of older exports (--history <dir>, or
 * TRANSLATIONS_HISTORY_DIR in the environment or .env.local).
 */
async function exportDirs() {
  const dirs = [{ key: "exports", label: "Saved exports", dir: EXPORT_DIR }];
  const flag = args.indexOf("--history");
  const history =
    (flag >= 0 ? args[flag + 1] : null) ||
    process.env.TRANSLATIONS_HISTORY_DIR ||
    (await readDotEnv(path.join(REPO_ROOT, ".env.local"))).TRANSLATIONS_HISTORY_DIR;
  if (history) dirs.push({ key: "history", label: "History", dir: path.resolve(history) });
  return dirs;
}

/** Guard the export directories against path traversal from the file picker. */
async function resolveExportFile(dirKey, name) {
  const root = (await exportDirs()).find((d) => d.key === (dirKey ?? "exports"));
  if (!root) return null;
  const base = path.basename(String(name ?? ""));
  if (!base || base !== name) return null;
  const full = path.join(root.dir, base);
  if (path.dirname(full) !== root.dir) return null;
  return full;
}

/**
 * The date an export is OF, read from its name: 20260909, 07142026 (MMDDYYYY)
 * or 822026 (MDYYYY). File times are useless on the history share — files were
 * copied around — so the name wins when it has one.
 */
function dateFromName(name) {
  const stem = name.replace(/\.[a-z]+$/i, "");
  const valid = (y, m, d) =>
    m >= 1 && m <= 12 && d >= 1 && d <= 31
      ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
      : null;
  let m = /(20\d{2})(\d{2})(\d{2})(?!\d)/.exec(stem);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = /^(\d{2})(\d{2})(20\d{2})$/.exec(stem);
  if (m) return valid(+m[3], +m[1], +m[2]);
  m = /^(\d)(\d)(20\d{2})$/.exec(stem);
  if (m) return valid(+m[3], +m[1], +m[2]);
  return null;
}

/** Extension-less files only count if they open like JSON. */
async function looksLikeJson(full) {
  let handle;
  try {
    handle = await open(full, "r");
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(64), 0, 64, 0);
    const head = buffer.subarray(0, bytesRead).toString("utf8").replace(/^﻿/, "").trimStart();
    return head.startsWith("[") || head.startsWith("{");
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

async function listExports() {
  const out = [];
  for (const { key, label, dir } of await exportDirs()) {
    let names;
    try {
      names = await readdir(dir);
    } catch {
      out.push({ dir: key, dirLabel: label, missing: true, path: dir });
      continue;
    }
    for (const name of names) {
      if (name.startsWith(".") || name.startsWith("~$")) continue; // ._ sidecars, .DS_Store, Office locks
      const full = path.join(dir, name);
      const known = /\.(ndjson|json|jsonl|csv)$/i.test(name);
      if (!known && (/\.[a-z0-9]{2,5}$/i.test(name) || !(await looksLikeJson(full)))) continue;
      try {
        const info = await stat(full);
        if (!info.isFile()) continue;
        out.push({
          dir: key,
          dirLabel: label,
          name,
          bytes: info.size,
          modifiedAt: info.mtime.toISOString(),
          date: dateFromName(name)
        });
      } catch {
        /* vanished mid-listing */
      }
    }
  }
  const when = (f) => f.date ?? f.modifiedAt ?? "";
  return out.sort((a, b) => when(b).localeCompare(when(a)));
}

function loadedPayload() {
  return {
    source: current.source,
    loadedAt: current.loadedAt,
    manifest: current.manifest,
    skipped: current.skipped.slice(0, 10),
    skippedCount: current.skipped.length,
    summary: current.summary
  };
}

async function swapIndex({ records, manifest, source, skipped }) {
  const next = await TranslationIndex.build({
    records,
    manifest,
    source,
    skipped,
    log
  });
  if (current) current.close();
  current = next;
  log(
    `loaded ${next.summary.total} records from ${source.kind}` +
      (source.file ? ` (${source.file})` : "")
  );
  return next;
}

// ---------------------------------------------------------------- routes

async function handleSources(res) {
  const creds = await readCredentials({ repoRoot: REPO_ROOT });
  sendJson(res, 200, {
    live: describeLive(creds),
    exports: await listExports(),
    loaded: current ? loadedPayload() : null
  });
}

async function handleLoad(req, res) {
  const body = await readBody(req);

  if (body.source === "live") {
    const creds = await readCredentials({ repoRoot: REPO_ROOT });
    const records = await fetchLiveRecords({ ...creds, log });
    await swapIndex({
      records,
      manifest: {
        record_type: "live_snapshot",
        fetched_at: new Date().toISOString(),
        database: { provider: "Supabase Postgres", url: creds.url }
      },
      source: { kind: "live", url: creds.url },
      skipped: []
    });
    return sendJson(res, 200, loadedPayload());
  }

  if (body.source === "all") return handleLoadAll(res);

  if (body.source === "export") {
    const full = await resolveExportFile(body.dir, body.file);
    if (!full) return sendJson(res, 400, { error: "Bad export file name." });
    let parsed;
    try {
      parsed = await readExportFile(full);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
    const { manifest, records, skipped } = parsed;
    await swapIndex({
      records,
      manifest,
      source: { kind: "export", dir: body.dir ?? "exports", file: path.basename(full) },
      skipped
    });
    return sendJson(res, 200, loadedPayload());
  }

  return sendJson(res, 400, { error: "source must be 'live', 'export' or 'all'." });
}

/** Parse one export file; throws a readable message if it holds no translations. */
async function readExportFile(full) {
  const parsed = parseExport(await readFile(full, "utf8"));
  if (!parsed.records.length) throw new Error(`${path.basename(full)} contained no records.`);
  // Any JSON parses as "records"; only a translations export carries text.
  if (!parsed.records.some((r) => r.original_text || r.translation_text)) {
    throw new Error(
      `${path.basename(full)} isn't a translations export (no original or translated text).`
    );
  }
  return parsed;
}

/**
 * Live (when available) plus every export in every folder, merged and
 * de-duplicated. Live goes first so its copy of a record wins; files follow
 * newest first. A file that can't be read is reported, not fatal.
 */
async function handleLoadAll(res) {
  const parts = [];
  const sets = [];
  const skipped = [];

  const creds = await readCredentials({ repoRoot: REPO_ROOT });
  if (describeLive(creds).available) {
    try {
      const records = await fetchLiveRecords({ ...creds, log });
      sets.push(records);
      parts.push({ source: "live", records: records.length });
    } catch (err) {
      parts.push({ source: "live", error: err.message });
    }
  }

  for (const file of await listExports()) {
    if (file.missing) {
      parts.push({ source: file.dir, error: `folder not reachable: ${file.path}` });
      continue;
    }
    const full = await resolveExportFile(file.dir, file.name);
    try {
      const parsed = await readExportFile(full);
      sets.push(parsed.records);
      skipped.push(...parsed.skipped.map((s) => ({ ...s, file: file.name })));
      parts.push({ source: file.dir, file: file.name, records: parsed.records.length });
    } catch (err) {
      parts.push({ source: file.dir, file: file.name, error: err.message });
    }
  }

  const { records, duplicates } = dedupe(sets);
  if (!records.length) return sendJson(res, 400, { error: "Nothing could be loaded." });
  log(`merged ${parts.length} sources: ${records.length} unique, ${duplicates} duplicates dropped`);

  await swapIndex({
    records,
    manifest: {
      record_type: "merged",
      merged_at: new Date().toISOString(),
      duplicates_dropped: duplicates,
      parts
    },
    source: { kind: "all" },
    skipped
  });
  return sendJson(res, 200, loadedPayload());
}

function handleSearch(res, params) {
  const index = requireIndex(res);
  if (!index) return;

  const options = optionsFromQuery(params);
  const limit = Math.min(Math.max(Number(params.get("limit")) || 50, 1), 500);
  const offset = Math.max(Number(params.get("offset")) || 0, 0);

  let result;
  try {
    result = index.search({ ...options, limit, offset });
  } catch (err) {
    // A raw FTS5 expression the user typed can be a syntax error. Say so
    // plainly rather than returning a 500 with a stack trace.
    return sendJson(res, 400, {
      error: `FTS5 could not parse that query: ${err.message}`,
      match: options.match
    });
  }

  sendJson(res, 200, {
    total: result.total,
    rows: result.rows,
    limit,
    offset,
    match: options.match,
    filtered: summariseFilters(options)
  });
}

/**
 * GET /api/context?key=&before=&after=&q=&raw=&loaded=
 * A search hit in its conversation. `key` is only meaningful for the load it
 * came from, so the client echoes `loaded` (the loadedAt it saw) and a stale
 * key after a reload gets a 409 instead of silently showing a different row.
 */
function handleContext(res, params) {
  const index = requireIndex(res);
  if (!index) return;
  if (params.get("loaded") && params.get("loaded") !== index.loadedAt) {
    return sendJson(res, 409, { error: "The data was reloaded — search again." });
  }
  const clamp = (v, d) => Math.min(Math.max(Number(v) || d, 0), 500);
  const { match } = optionsFromQuery(params);
  const result = index.context(Number(params.get("key")), {
    before: clamp(params.get("before"), 15),
    after: clamp(params.get("after"), 15),
    match
  });
  if (!result) return sendJson(res, 404, { error: "That record isn't in the loaded data." });
  sendJson(res, 200, result);
}

function summariseFilters(options) {
  const active = [];
  if (options.query) active.push(`text: ${options.query}`);
  // Bounds were parsed as local days, so label them as local days too —
  // formatting the end-of-day bound as UTC reads as the following date.
  const localDay = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  if (options.fromMs != null) active.push(`from ${localDay(options.fromMs)}`);
  if (options.toMs != null) active.push(`to ${localDay(options.toMs)}`);
  for (const key of ["sourceLang", "targetLang", "engine", "table", "userId"]) {
    if (options[key]) active.push(`${key}: ${options[key]}`);
  }
  return active;
}

function exportPayload(index, options) {
  const records = index.all(options);
  return {
    manifest: {
      record_type: "export_manifest",
      format: "json",
      format_version: 1,
      tool: "tools/translations-viewer",
      exported_at: new Date().toISOString(),
      source: index.source,
      source_manifest: index.manifest,
      filters: summariseFilters(options),
      fts5_match: options.match,
      record_count: records.length
    },
    summary: summarise(records),
    records
  };
}

function handleExport(res, params) {
  const index = requireIndex(res);
  if (!index) return;

  let payload;
  try {
    payload = exportPayload(index, optionsFromQuery(params));
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }

  const body = JSON.stringify(payload, null, 2);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="taos-lite-translations-${stamp}.json"`,
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function handleSave(req, res) {
  const index = requireIndex(res);
  if (!index) return;

  const body = await readBody(req);
  const params = new URLSearchParams(body.query ?? "");
  const payload = exportPayload(index, optionsFromQuery(params));

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const name = `taos-lite-translations-${stamp}.json`;
  await mkdir(EXPORT_DIR, { recursive: true });
  const full = path.join(EXPORT_DIR, name);
  // Every user's translations: owner-only, like the other exports.
  await writeFile(full, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
  log(`wrote ${payload.records.length} records to local_exports/${name}`);

  sendJson(res, 200, {
    file: name,
    path: path.relative(REPO_ROOT, full),
    records: payload.records.length
  });
}

async function serveStatic(res, urlPath) {
  const name = urlPath === "/" ? "index.html" : path.basename(urlPath);
  const full = path.join(PUBLIC_DIR, name);
  if (path.dirname(full) !== PUBLIC_DIR) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const body = await readFile(full);
    const type = name.endsWith(".html")
      ? "text/html; charset=utf-8"
      : name.endsWith(".css")
        ? "text/css; charset=utf-8"
        : name.endsWith(".js")
          ? "text/javascript; charset=utf-8"
          : "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

// ---------------------------------------------------------------- server

// Tailscale hands out 100.64.0.0/10 (CGNAT) addresses.
const isTailscale = (ip) => {
  const m = /^(?:::ffff:)?100\.(\d+)\.\d+\.\d+$/.exec(ip ?? "");
  return Boolean(m) && Number(m[1]) >= 64 && Number(m[1]) <= 127;
};
const isLoopback = (ip) => ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";

/** This machine's Tailscale IPv4 address, or null if Tailscale is down. */
function tailscaleAddress() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && isTailscale(a.address)) return a.address;
    }
  }
  return null;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  // Belt and braces: the listeners are already bound to loopback and the
  // Tailscale address only, but never answer anyone else.
  const peer = req.socket.remoteAddress;
  if (!isLoopback(peer) && !isTailscale(peer)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    if (url.pathname === "/api/sources" && req.method === "GET") {
      return await handleSources(res);
    }
    if (url.pathname === "/api/load" && req.method === "POST") {
      return await handleLoad(req, res);
    }
    if (url.pathname === "/api/search" && req.method === "GET") {
      return handleSearch(res, url.searchParams);
    }
    if (url.pathname === "/api/context" && req.method === "GET") {
      return handleContext(res, url.searchParams);
    }
    if (url.pathname === "/api/export" && req.method === "GET") {
      return handleExport(res, url.searchParams);
    }
    if (url.pathname === "/api/export/save" && req.method === "POST") {
      return await handleSave(req, res);
    }
    if (req.method === "GET") return await serveStatic(res, url.pathname);
    res.writeHead(405).end("method not allowed");
  } catch (err) {
    log(`error on ${req.method} ${url.pathname}: ${err.stack ?? err.message}`);
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
    else res.end();
  }
}

// Localhost always. --tailnet adds the Tailscale address and nothing else: never
// the LAN, since this process holds a service-role key and has no login of its
// own — Tailscale's device sign-in is the gate.
createServer(handle).listen(PORT, "127.0.0.1", () => {
  log(`translations viewer on http://localhost:${PORT}`);
  log(`exports directory: ${path.relative(REPO_ROOT, EXPORT_DIR)}`);
});

if (TAILNET) {
  const address = tailscaleAddress();
  if (!address) {
    log("--tailnet: no Tailscale address found (is Tailscale up?) — localhost only");
  } else {
    createServer(handle).listen(PORT, address, () => {
      log(`tailnet: http://${address}:${PORT}`);
    });
  }
}
