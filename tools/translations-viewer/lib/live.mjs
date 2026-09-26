// Reading the live table straight from PostgREST.
//
// This is the only part of the viewer that needs a credential. The service-role
// key is NEVER handed to the browser: the page asks this server, and this
// server asks Supabase. Rows are pulled in pages because PostgREST caps a
// response (1,000 rows by default) and silently returns a short list otherwise.

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  TRANSLATIONS_TABLE,
  TRANSLATION_COLUMNS,
  fromTranslationRow
} from "./records.mjs";

const PAGE_SIZE = 1000;

/** Pull SUPABASE_* out of the environment, falling back to .env.local. */
export async function readCredentials({ repoRoot, env = process.env } = {}) {
  let url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || "";
  let key = env.SUPABASE_SERVICE_ROLE_KEY || "";

  if ((!url || !key) && repoRoot) {
    const fromFile = await readDotEnv(path.join(repoRoot, ".env.local"));
    url = url || fromFile.SUPABASE_URL || fromFile.NEXT_PUBLIC_SUPABASE_URL || "";
    key = key || fromFile.SUPABASE_SERVICE_ROLE_KEY || "";
  }
  return { url: url.replace(/\/+$/, ""), key };
}

export async function readDotEnv(file) {
  const out = {};
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

/**
 * Is the live source usable? Returns a reason when it is not, so the UI can
 * say why instead of showing a dead button.
 *
 * Vercel marks the service-role key sensitive, so `vercel env pull` writes a
 * placeholder locally — a short value here means exactly that, and no amount
 * of retrying will fix it.
 */
export function describeLive({ url, key }) {
  if (!url) {
    return {
      available: false,
      reason:
        "No Supabase URL. Set SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) in the environment or .env.local."
    };
  }
  if (!key) {
    return {
      available: false,
      reason:
        "No SUPABASE_SERVICE_ROLE_KEY. Copy it from the Supabase dashboard (Settings → API) into the environment."
    };
  }
  if (key.length < 20) {
    return {
      available: false,
      reason:
        `SUPABASE_SERVICE_ROLE_KEY is only ${key.length} characters — that is a placeholder, ` +
        "not a key. Vercel stores it as a sensitive variable, so `vercel env pull` cannot " +
        "retrieve it; copy the real key from the Supabase dashboard (Settings → API)."
    };
  }
  return { available: true, reason: null, url };
}

/** Fetch every translation row, newest last, following PostgREST pagination. */
export async function fetchLiveRecords({ url, key, log = () => {} }) {
  const probe = describeLive({ url, key });
  if (!probe.available) throw new Error(probe.reason);

  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: "application/json"
  };
  const select = TRANSLATION_COLUMNS.join(",");
  const records = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const to = from + PAGE_SIZE - 1;
    const endpoint =
      `${url}/rest/v1/${TRANSLATIONS_TABLE.replace(/^public\./, "")}` +
      `?select=${encodeURIComponent(select)}&order=created_at.asc`;

    const res = await fetch(endpoint, {
      headers: { ...headers, Range: `${from}-${to}`, "Range-Unit": "items" }
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Supabase returned HTTP ${res.status} for ${TRANSLATIONS_TABLE}: ${body.slice(0, 300)}`
      );
    }
    const page = await res.json();
    if (!Array.isArray(page)) {
      throw new Error("Supabase returned a non-array payload; check the table name.");
    }
    records.push(...page.map(fromTranslationRow));
    log(`live: ${records.length} rows…`);
    if (page.length < PAGE_SIZE) break;
  }

  return records;
}
