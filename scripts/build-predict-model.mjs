#!/usr/bin/env node
// ── Build predictive-typing models from conversation history ─────────────────
// Runnable manually (`node scripts/build-predict-model.mjs`) — this is the CLI
// "rebuild now" path — and reused by the nightly cron API route.
//
// Reads the translations history (READ-ONLY), buckets each message by its
// detected language, builds a recency-weighted n-gram model per direction, then:
//   1. writes public/models/predict-en-es.json + predict-es-en.json (for local
//      inspection / offline dev), and
//   2. upserts both into the taos_lite_predict_models table (what the deployed
//      app serves), when a Supabase service-role key is available.

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Load .env.local into process.env (Next loads it automatically; a bare node
// script does not). Minimal parser — no dependency.
function loadEnvLocal() {
  const p = join(ROOT, ".env.local");
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnvLocal();

const { buildAllModels, DIRECTIONS } = await import(join(ROOT, "lib/predict/model.mjs"));

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://duqkmuaceklnfgvoufrz.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const KEY = SERVICE_KEY || ANON_KEY;
const TABLE = "taos_lite_translations";
const FIXTURE = process.env.PREDICT_FIXTURE;

if (!KEY && !FIXTURE) {
  console.error("Missing Supabase key: set SUPABASE_SERVICE_ROLE_KEY (preferred) or NEXT_PUBLIC_SUPABASE_ANON_KEY, or set PREDICT_FIXTURE for offline mode.");
  process.exit(1);
}
if (!SERVICE_KEY && !FIXTURE) {
  console.warn("⚠  No SUPABASE_SERVICE_ROLE_KEY — using anon key; history may be RLS-limited and the upsert will be skipped.");
}

// Offline mode (PREDICT_FIXTURE, declared above): build from a local JSON fixture
// [{ original_text, created_at }] instead of Supabase — handy for CI / local dev
// when the service-role key isn't present. The upsert is skipped in this mode.
const supabase = KEY
  ? createClient(SUPABASE_URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

// Page through all history rows (Supabase caps a single response at ~1000).
async function fetchAllRows() {
  if (FIXTURE) {
    console.log(`(fixture mode) reading rows from ${FIXTURE}`);
    return JSON.parse(readFileSync(FIXTURE, "utf8"));
  }
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(TABLE)
      .select("original_text, created_at")
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

function bytes(n) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

async function main() {
  console.log("Fetching history…");
  const raw = await fetchAllRows();
  console.log(`  ${raw.length} rows fetched.`);

  const now = Date.now();
  const models = buildAllModels(raw, now);

  const outDir = join(ROOT, "public", "models");
  mkdirSync(outDir, { recursive: true });

  for (const direction of DIRECTIONS) {
    const model = models[direction];
    const json = JSON.stringify(model);
    const file = join(outDir, `predict-${direction}.json`);
    writeFileSync(file, json);

    console.log(`\n── ${direction} ──────────────────────────────`);
    console.log(`  artifact: public/models/predict-${direction}.json  (${bytes(Buffer.byteLength(json))})`);
    console.log(`  trained on ${model.rowCount} messages, ${model.tokenCount} tokens`);
    console.log(`  unigrams=${Object.keys(model.unigrams).length}  bigramCtx=${Object.keys(model.bigrams).length}  trigramCtx=${Object.keys(model.trigrams).length}  phrases=${model.phrases.length}`);

    // Sample lookup for a common prefix + a next-word context.
    const prefix = direction === "en-es" ? "lo" : "te";
    const hits = Object.keys(model.unigrams)
      .filter((w) => w.startsWith(prefix) && w.length > prefix.length)
      .sort((a, b) => model.unigrams[b] - model.unigrams[a])
      .slice(0, 5);
    console.log(`  prefix "${prefix}" → ${hits.length ? hits.join(", ") : "(no matches)"}`);
    const topWord = Object.entries(model.unigrams).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (topWord && model.bigrams[topWord]) {
      const next = model.bigrams[topWord].map(([w]) => w).slice(0, 5).join(", ");
      console.log(`  after "${topWord}" → ${next}`);
    }

    // Upsert to the served table (service-role only; never in fixture mode).
    if (SERVICE_KEY && !FIXTURE && supabase) {
      const { error } = await supabase.from("taos_lite_predict_models").upsert(
        {
          direction,
          model,
          row_count: model.rowCount,
          token_count: model.tokenCount,
          built_at: new Date(now).toISOString()
        },
        { onConflict: "direction" }
      );
      if (error) {
        console.error(`  ✗ upsert failed: ${error.message}`);
        process.exitCode = 1;
      } else {
        console.log("  ✓ upserted to taos_lite_predict_models");
      }
    }
  }
  console.log(`\nDone. built_at=${new Date(now).toISOString()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
