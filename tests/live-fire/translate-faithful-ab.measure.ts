// Paraphrase vs faithful, with and without conversation context, on REAL turns.
//
//   TAOS_AB_DIR=/home/tom/blackbird_dev/taos-ab \
//   node --env-file=/home/tom/blackbird_dev/TAOS-LITE/.env.local \
//     node_modules/vitest/vitest.mjs run --config vitest.measure.config.ts \
//     tests/live-fire/translate-faithful-ab.measure.ts
//
// Live fire: real OpenAI, real founder conversation rows. Never CI (the
// measure config is the only thing that picks this file up), and this file is
// data-free on purpose — the rows and every output land in TAOS_AB_DIR, which
// must be OUTSIDE the repo. Nothing from a row is printed to the console:
// the console gets tallies, the private file gets the side-by-side.
//
// Two dials (Tom, 10/28), decided on what he and Liz actually said rather than
// on synthetic fixtures — the synthetic probes for #111 showed no difference:
//   A      today's home prompt (MEANING_FIRST_RULE paraphrase), no context
//   B      today's prompt + FAITHFUL_RULE, inserted right after the
//          meaning-first rule, no context
//   A+ctx  A with the previous 3 turns of the same conversation (#111)
//   B+ctx  B with the same context
//   A2     A again — not a dial, the noise floor. At temperature 0.2 the same
//          prompt does not always return the same words, so "B differs from A"
//          only means something next to "A differs from A".
//
// Every arm goes through the SHIPPED route handler (app/api/translate/route.ts)
// on #111's branch, in manual mode (the row's source → target): spendGuard is
// mocked to "signed in", the transcriber is mocked to return the row's
// original_text (the transcript IS the input — no audio, no STT), and the
// context rides in the real `context` form field through parseContextField and
// buildContextBlock. B is the only prompt change, and it is made by wrapping
// the real buildInstructions, so A is byte-for-byte what production sends.
//
// Spend: every OpenAI response's `usage` is read off the wire and priced at
// gpt-4.1 list ($2/M in, $8/M out); the run refuses new calls past SPEND_CAP.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { describe, it, vi } from "vitest";
import { NextRequest } from "next/server";

export const FAITHFUL_RULE =
  "FAITHFUL: every clause, detail, number, name and hedge in the original must appear in the " +
  "translation, in the same order — condense nothing, add nothing. Natural phrasing is still required.";

const TURNS = Number(process.env.TAOS_AB_TURNS ?? 60);
const SPEND_CAP_USD = 3;
const PRICE_IN = 2 / 1e6;
const PRICE_OUT = 8 / 1e6;
const CONCURRENCY = 4;

// ── Mocks: auth, transcript, and the one prompt change ─────────────────────

// Per-request, so concurrent turns can never read each other's arm: the
// route's awaits all carry this async context through to the mocks.
const armContext = new AsyncLocalStorage<{ faithful: boolean; transcript: string }>();
const state = () => {
  const s = armContext.getStore();
  if (!s) throw new Error("route ran outside an arm");
  return s;
};

vi.mock("@/lib/spendGuard", () => ({
  guardSpend: async () => ({ ok: true, user: { id: "ab-harness" }, anonymous: false })
}));

vi.mock("@/lib/translate/transcribe", () => ({
  transcribeAudio: async () => state().transcript
}));

vi.mock("@/lib/translate/prompts", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/translate/prompts")>();
  return {
    ...real,
    buildInstructions: (...args: Parameters<typeof real.buildInstructions>) => {
      const prompt = real.buildInstructions(...args);
      if (!state().faithful) return prompt;
      const anchor = real.MEANING_FIRST_RULE();
      if (!prompt.includes(anchor)) throw new Error("meaning-first rule not found in prompt");
      return prompt.replace(anchor, `${anchor} ${FAITHFUL_RULE}`);
    }
  };
});

// ── Spend meter on the wire ─────────────────────────────────────────────────

const spend = { calls: 0, inTok: 0, outTok: 0 };
const usd = () => spend.inTok * PRICE_IN + spend.outTok * PRICE_OUT;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("https://api.openai.com/")) return realFetch(input, init);
  if (usd() >= SPEND_CAP_USD) throw new Error(`spend cap $${SPEND_CAP_USD} reached`);
  const res = await realFetch(input, init);
  try {
    const body = (await res.clone().json()) as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
    spend.calls += 1;
    spend.inTok += body.usage?.prompt_tokens ?? 0;
    spend.outTok += body.usage?.completion_tokens ?? 0;
  } catch {
    /* non-JSON error body — the route reports it */
  }
  return res;
}) as typeof fetch;

// ── Data: the founders' last turns, cached in TAOS_AB_DIR ───────────────────

interface Row {
  created_at: string;
  user_id: string;
  source_lang: string;
  target_lang: string;
  tone: string | null;
  original_text: string;
  translation_text: string;
  engine: string | null;
  session_id: string | null;
}

function outDir(): string {
  const dir = process.env.TAOS_AB_DIR;
  if (!dir) throw new Error("Set TAOS_AB_DIR to a directory OUTSIDE the repo.");
  const abs = resolve(dir);
  if (abs.startsWith(resolve(process.cwd()))) throw new Error("TAOS_AB_DIR must be outside the repo.");
  mkdirSync(abs, { recursive: true, mode: 0o700 });
  return abs;
}

async function supabase(path: string): Promise<unknown> {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing (pass --env-file).");
  const res = await realFetch(`${base}${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`Supabase ${path.split("?")[0]} → ${res.status}`);
  return res.json();
}

async function founderIds(): Promise<string[]> {
  // The founder list is read from lib/release.ts (plus NEXT_PUBLIC_FOUNDER_EMAILS
  // if set), never restated here.
  const { isFounder } = await import("@/lib/release");
  const ids: string[] = [];
  for (let page = 1; page < 50; page++) {
    const body = (await supabase(`/auth/v1/admin/users?page=${page}&per_page=200`)) as {
      users: { id: string; email?: string }[];
    };
    for (const u of body.users) if (isFounder(u.email)) ids.push(u.id);
    if (body.users.length < 200) break;
  }
  if (ids.length === 0) throw new Error("No founder accounts found.");
  return ids;
}

async function loadRows(dir: string, stamp: string): Promise<Row[]> {
  const file = join(dir, `rows-${stamp}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as Row[];
  const ids = await founderIds();
  const cols = "created_at,user_id,source_lang,target_lang,tone,original_text,translation_text,engine,session_id";
  // Pull a few extra so the oldest of the 60 still has earlier turns to use as context.
  const limit = TURNS + 20;
  const rows = (await supabase(
    `/rest/v1/taos_lite_translations?select=${cols}` +
      `&user_id=in.(${ids.join(",")})&or=(engine.is.null,engine.neq.fast)` +
      `&order=created_at.desc&limit=${limit}`
  )) as Row[];
  rows.reverse();
  writeFileSync(file, JSON.stringify(rows, null, 1), { mode: 0o600 });
  return rows;
}

// ── Context: previous 3 rows of the same conversation ───────────────────────

async function contextFor(rows: Row[], i: number) {
  const { SESSION_GAP_MS } = await import("@/lib/translate/session");
  const { selectContext } = await import("@/lib/translate/context");
  const { isSupportedLanguageCode } = await import("@/lib/realtime/languages");
  const picked: Row[] = [];
  let later = rows[i];
  for (let j = i - 1; j >= 0 && picked.length < 3; j--) {
    const r = rows[j];
    if (r.user_id !== later.user_id) continue;
    const same =
      rows[i].session_id && r.session_id
        ? r.session_id === rows[i].session_id
        : Date.parse(later.created_at) - Date.parse(r.created_at) <= SESSION_GAP_MS;
    if (!same) break;
    later = r;
    if (!isSupportedLanguageCode(r.source_lang) || !isSupportedLanguageCode(r.target_lang)) continue;
    if (!r.original_text?.trim() || !r.translation_text?.trim()) continue;
    picked.unshift(r);
  }
  return selectContext(
    picked.map((r) => ({
      source_lang: r.source_lang,
      target_lang: r.target_lang,
      original: r.original_text,
      translation: r.translation_text
    }))
  );
}

// ── One arm through the shipped route ──────────────────────────────────────

const ARMS = ["A", "B", "Actx", "Bctx", "A2"] as const;
type Arm = (typeof ARMS)[number];

async function runArm(row: Row, arm: Arm, context: unknown[]): Promise<string> {
  const { POST } = await import("@/app/api/translate/route");
  const form = new FormData();
  form.set("audio", new File([new Uint8Array([1])], "turn.webm", { type: "audio/webm" }));
  form.set("sourceLanguage", row.source_lang);
  form.set("targetLanguage", row.target_lang);
  form.set("tone", row.tone ?? "casual");
  const withCtx = arm === "Actx" || arm === "Bctx";
  if (withCtx && context.length) form.set("context", JSON.stringify(context));
  const req = new NextRequest("https://taoslite.com/api/translate", { method: "POST", body: form });
  const store = { faithful: arm === "B" || arm === "Bctx", transcript: row.original_text };
  const res = await armContext.run(store, () => POST(req));
  const body = (await res.json()) as { translation?: string; error?: string };
  if (!res.ok || !body.translation) throw new Error(`route ${res.status}: ${body.error ?? "no translation"}`);
  return body.translation;
}

// ── Scoring ─────────────────────────────────────────────────────────────────

const norm = (s: string) =>
  s.toLowerCase().replace(/[\p{P}\p{S}]/gu, " ").replace(/\s+/g, " ").trim();

const NEGATION = /\b(no|not|nunca|never|nothing|nada|ni|tampoco|jam[aá]s)\b|n['’]t\b/giu;

function signalTokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of s.match(/\d+(?:[.,:]\d+)*/g) ?? []) out.add(`#${m}`);
  // Capitalized words that do not start a sentence: names, places.
  for (const sentence of s.split(/(?<=[.!?¿¡…])\s+|^/u)) {
    const words = sentence.split(/\s+/).filter(Boolean);
    for (const w of words.slice(1)) {
      const clean = w.replace(/^[\p{P}]+|[\p{P}]+$/gu, "");
      if (/^\p{Lu}\p{Ll}/u.test(clean)) out.add(clean);
    }
  }
  return out;
}

const negations = (s: string) => (s.match(NEGATION) ?? []).length;

/**
 * Tokens B has that A lacks: numbers, names, or an extra negation. A first
 * filter, not a verdict — digits vs spelled-out numbers ("500" / "five
 * hundred") and a rephrased negation both trip it; read the flagged rows.
 */
function omissionInA(a: string, b: string): string[] {
  const ta = signalTokens(a);
  const missing = [...signalTokens(b)].filter((t) => !ta.has(t));
  if (negations(b) > negations(a)) missing.push("(negation)");
  return missing;
}

function wordEdits(a: string, b: string): number {
  const x = norm(a).split(" ");
  const y = norm(b).split(" ");
  let prev = Array.from({ length: y.length + 1 }, (_, k) => k);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length];
}

// Help for the human pass, not a verdict: rows matching this are never quoted
// in the report.
const SENSITIVE =
  /\b(doctor|m[eé]dic|hospital|medicin|medicament|pill|pastilla|dose|dosis|cancer|c[aá]ncer|surgery|cirug|diagnos|blood|sangre|pregnan|embaraz|insurance|seguro|bank|banco|money|dinero|dollar|d[oó]lar|pesos|loan|pr[eé]stamo|mortgage|hipoteca|debt|deuda|tax|impuesto|salary|salario|pay|pagar|card|tarjeta|account|cuenta)/iu;

interface Result {
  i: number;
  row: Row;
  ctxTurns: number;
  out: Partial<Record<Arm, string>>;
  error?: string;
}

const cell = (s: string | undefined) => (s ?? "—").replace(/\|/g, "\\|").replace(/\s+/g, " ");

describe("translate: paraphrase vs faithful, ± context, on real founder turns", () => {
  it("runs five arms per turn and writes the private side-by-side", async () => {
    const dir = outDir();
    const stamp = process.env.TAOS_AB_STAMP ?? new Date().toISOString().slice(0, 10);
    const all = await loadRows(dir, stamp);
    const { isSupportedLanguageCode } = await import("@/lib/realtime/languages");
    const start = Math.max(0, all.length - TURNS);

    const results: Result[] = [];
    let skipped = 0;
    const queue: number[] = [];
    for (let i = start; i < all.length; i++) {
      const r = all[i];
      const ok =
        isSupportedLanguageCode(r.source_lang) &&
        isSupportedLanguageCode(r.target_lang) &&
        r.source_lang !== r.target_lang &&
        r.original_text?.trim();
      if (ok) queue.push(i);
      else skipped++;
    }

    let next = 0;
    async function worker() {
      while (next < queue.length) {
        const i = queue[next++];
        const row = all[i];
        const ctx = await contextFor(all, i);
        const res: Result = { i, row, ctxTurns: ctx.length, out: {} };
        try {
          for (const arm of ARMS) {
            // No context available → the ctx arm IS the no-ctx arm; don't pay twice.
            if ((arm === "Actx" || arm === "Bctx") && ctx.length === 0) continue;
            res.out[arm] = await runArm(row, arm, ctx);
          }
        } catch (e) {
          res.error = e instanceof Error ? e.message : String(e);
        }
        results.push(res);
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    results.sort((a, b) => a.i - b.i);

    // ── Tally ──
    const done = results.filter((r) => r.out.A && r.out.B);
    const differs = (x?: string, y?: string) => x !== undefined && y !== undefined && norm(x) !== norm(y);
    const bNeA = done.filter((r) => differs(r.out.A, r.out.B));
    const noise = done.filter((r) => differs(r.out.A, r.out.A2));
    const omissions = done.filter((r) => omissionInA(r.out.A!, r.out.B!).length > 0);
    const reverse = done.filter((r) => omissionInA(r.out.B!, r.out.A!).length > 0);
    const ratios = done.map((r) => r.out.B!.length / r.out.A!.length);
    const meanRatio = ratios.reduce((s, x) => s + x, 0) / (ratios.length || 1);
    const ratioOrig = (arm: Arm) => {
      const v = done.map((r) => r.out[arm]!.length / r.row.original_text.length);
      return v.reduce((s, x) => s + x, 0) / (v.length || 1);
    };
    const withCtx = done.filter((r) => r.ctxTurns > 0 && r.out.Actx && r.out.Bctx);
    const ctxA = withCtx.filter((r) => differs(r.out.A, r.out.Actx));
    const ctxB = withCtx.filter((r) => differs(r.out.B, r.out.Bctx));

    const pct = (n: number, d: number) => `${n}/${d} (${d ? Math.round((100 * n) / d) : 0}%)`;
    const tallies = [
      `turns pulled ${all.length}, measured ${results.length}, skipped (bad lang pair) ${skipped}, errored ${results.filter((r) => r.error).length}`,
      `B ≠ A                         ${pct(bNeA.length, done.length)}`,
      `A ≠ A2 (noise floor)          ${pct(noise.length, done.length)}`,
      `B kept number/name/neg A lacked ${omissions.length}   (reverse: A had one B lacked ${reverse.length})`,
      `mean length ratio B/A         ${meanRatio.toFixed(3)}`,
      `mean length vs original       A ${ratioOrig("A").toFixed(3)}  B ${ratioOrig("B").toFixed(3)}`,
      `turns with context            ${withCtx.length}`,
      `ctx changed A                 ${pct(ctxA.length, withCtx.length)}`,
      `ctx changed B                 ${pct(ctxB.length, withCtx.length)}`,
      `spend                         ${spend.calls} calls, ${spend.inTok} in / ${spend.outTok} out tok, $${usd().toFixed(3)}`
    ];

    // ── Private side-by-side ──
    const ranked = [...done]
      .map((r) => ({ r, edits: wordEdits(r.out.A!, r.out.B!) }))
      .sort((x, y) => y.edits - x.edits);
    const lines: string[] = [
      `# Faithful A/B — ${stamp} (PRIVATE: founder conversation data, never commit)`,
      "",
      "FAITHFUL rule (arm B), inserted right after MEANING_FIRST_RULE:",
      "",
      `> ${FAITHFUL_RULE}`,
      "",
      "```",
      ...tallies,
      "```",
      "",
      "## Largest A-vs-B differences (word edits; ⚠ = sensitive keyword, do not quote)",
      "",
      "| # | edits | ⚠ | original | A | B |",
      "|---|---|---|---|---|---|",
      ...ranked.slice(0, 20).map(
        ({ r, edits }) =>
          `| ${r.i} | ${edits} | ${SENSITIVE.test(r.row.original_text + r.out.A + r.out.B) ? "⚠" : ""} | ${cell(r.row.original_text)} | ${cell(r.out.A)} | ${cell(r.out.B)} |`
      ),
      "",
      "## Every turn",
      "",
      "| # | dir | tone | ctx | original | A | B | A+ctx | B+ctx | A2 | flags |",
      "|---|---|---|---|---|---|---|---|---|---|---|",
      ...results.map((r) => {
        const flags: string[] = [];
        if (r.error) flags.push(`ERROR ${r.error}`);
        if (r.out.A && r.out.B) {
          if (differs(r.out.A, r.out.B)) flags.push("B≠A");
          const om = omissionInA(r.out.A, r.out.B);
          if (om.length) flags.push(`B+${om.join(",")}`);
          const rev = omissionInA(r.out.B, r.out.A);
          if (rev.length) flags.push(`A+${rev.join(",")}`);
          flags.push(`B/A ${(r.out.B.length / r.out.A.length).toFixed(2)}`);
        }
        if (differs(r.out.A, r.out.A2)) flags.push("A≠A2");
        if (differs(r.out.A, r.out.Actx)) flags.push("ctx→A");
        if (differs(r.out.B, r.out.Bctx)) flags.push("ctx→B");
        if (SENSITIVE.test(r.row.original_text)) flags.push("⚠");
        return `| ${r.i} | ${r.row.source_lang}→${r.row.target_lang} | ${r.row.tone ?? "casual"} | ${r.ctxTurns} | ${cell(r.row.original_text)} | ${cell(r.out.A)} | ${cell(r.out.B)} | ${cell(r.out.Actx)} | ${cell(r.out.Bctx)} | ${cell(r.out.A2)} | ${flags.join(" ")} |`;
      })
    ];
    const file = join(dir, `faithful-ab-${stamp}.md`);
    writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
    writeFileSync(join(dir, `faithful-ab-${stamp}.json`), JSON.stringify(results, null, 1), { mode: 0o600 });

    // Console: tallies only — no row text.
    console.log(["", "── faithful A/B ──", ...tallies, `private side-by-side: ${file}`].join("\n"));
  });
});
