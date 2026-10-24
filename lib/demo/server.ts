// /demo — "Tu voz" — the server half: clone, authorize, delete, sweep.
//
// A stranger on the sidewalk records ~45 seconds, ElevenLabs makes an instant
// clone, they hear themselves speak the other language, and the clone is
// DELETED. The whole promise to that stranger is the last word, so most of
// this file is about deleting.
//
// ── What is stored, and where ──────────────────────────────────────────────
// The audio sample: nowhere. It arrives as multipart, is forwarded to
// ElevenLabs in the same request, and is garbage the moment the handler
// returns. The voice: on ElevenLabs, for at most DEMO_TTL_MS. Its id: in the
// browser's memory, in a signed token, in the `[taos-demo]` log line — and in
// this module's maps, which die with the instance. No database, no bucket.
//
// ── Why there is a signed token AND a map ──────────────────────────────────
// The map below is per INSTANCE, and on Vercel it is worse than that: each
// route is its own function bundle, so /api/demo/clone's map and
// /api/tts's map are different objects even on a single warm machine. A map
// alone would mean "the reveal works if you are lucky". So the clone route
// hands the browser a token that names the voice, the founder and an expiry,
// HMAC-signed with a key derived from ELEVENLABS_API_KEY (no new secret). Any
// instance of any route can verify it; only this server can mint one. The map
// is consulted first and keeps the parts that need a counter — lines used,
// deleted tombstones — best-effort per instance.
//
// And because no map can be trusted to remember a voice across a cold start,
// the sweep's real backstop is ElevenLabs itself: list every voice named
// `taos-demo-*` and delete the ones whose `expires` label has passed.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  DEMO_MAX_CLONES_PER_DAY,
  DEMO_MAX_LINES,
  DEMO_TTL_MS,
  DEMO_VOICE_PREFIX
} from "./limits";

const ELEVENLABS = "https://api.elevenlabs.io";
const UPSTREAM_TIMEOUT_MS = 30_000;

/**
 * Is /demo switched on at all? Server-only (`TAOS_DEMO_ENABLED=1`): the page
 * reads it on the server and the routes read it before anything else, so
 * with it unset every /api/demo route is a 404 and the page says so.
 */
export function demoEnabled(): boolean {
  const flag = (process.env.TAOS_DEMO_ENABLED ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true";
}

/** One line per event, no audio, no names: `[taos-demo] event=… voice=… ms=…`. */
export function demoLog(fields: Record<string, string | number>): void {
  const parts = Object.entries(fields).map(
    ([k, v]) => `${k}=${String(v).replace(/[^0-9A-Za-z_.:-]/g, "").slice(0, 48) || "?"}`
  );
  console.log(["[taos-demo]", ...parts].join(" "));
}

// ── Per-instance state ─────────────────────────────────────────────────────

interface DemoVoice {
  ownerId: string;
  createdAt: number;
  expiresAt: number;
  linesUsed: number;
}

const live = new Map<string, DemoVoice>();
/** Voices this instance has deleted — a token for one of them is refused here. */
const deleted = new Set<string>();
/** userId → clones made on `day` (UTC yyyy-mm-dd). Per instance; see PR body. */
const clonesByDay = new Map<string, { day: string; count: number }>();

/** Tests only: a fresh instance is the production reset. */
export function resetDemoState(): void {
  live.clear();
  deleted.clear();
  clonesByDay.clear();
}

/** Tests only: what the map currently holds. */
export function liveDemoVoices(): string[] {
  return [...live.keys()];
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Would one more clone fit under today's cap? Does not count it. */
export function clonesLeftToday(userId: string, now = Date.now()): number {
  const entry = clonesByDay.get(userId);
  const used = entry && entry.day === utcDay(now) ? entry.count : 0;
  return Math.max(0, DEMO_MAX_CLONES_PER_DAY - used);
}

function countClone(userId: string, now: number): void {
  const day = utcDay(now);
  const entry = clonesByDay.get(userId);
  clonesByDay.set(userId, { day, count: entry && entry.day === day ? entry.count + 1 : 1 });
}

// ── The token ──────────────────────────────────────────────────────────────

interface TokenPayload {
  /** voice id */
  v: string;
  /** owner (Supabase user id) */
  u: string;
  /** expiry, epoch ms */
  e: number;
}

function signingKey(): Buffer | null {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return null;
  // Derived, never the key itself: a leaked token must not be a leaked key,
  // and this domain string keeps the derivation from colliding with any other.
  return createHash("sha256").update(`taos-demo-token:v1:${apiKey}`).digest();
}

function sign(body: string, key: Buffer): string {
  return createHmac("sha256", key).update(body).digest("base64url");
}

export function mintDemoToken(payload: TokenPayload): string {
  const key = signingKey();
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body, key)}`;
}

/** The payload if the signature is ours, else null. Expiry is NOT checked here. */
export function readDemoToken(token: unknown): TokenPayload | null {
  if (typeof token !== "string" || token.length > 600) return null;
  const key = signingKey();
  if (!key) return null;
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  const expected = Buffer.from(sign(body, key));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<TokenPayload>;
    if (typeof p.v !== "string" || typeof p.u !== "string" || typeof p.e !== "number") return null;
    return { v: p.v, u: p.u, e: p.e };
  } catch {
    return null;
  }
}

export type DemoAuthorization =
  | { ok: true; linesLeft: number }
  | { ok: false; reason: "token" | "voice" | "owner" | "expired" | "deleted" | "lines" };

/**
 * May this request speak in `voiceId`?
 *
 * The override is accepted ONLY for a voice step 3 created, for the founder
 * it was created for, inside its ten minutes, for its first DEMO_MAX_LINES
 * lines. Anything else is a refusal — and the caller must not fall back to
 * another voice, because "it spoke, just not in their voice" is the one
 * outcome the demo cannot have.
 *
 * `consume` counts a line. /api/tts passes false, synthesizes, and only then
 * calls countDemoLine — so a provider failure does not eat one of the three.
 */
export function authorizeDemoVoice(input: {
  voiceId: unknown;
  token: unknown;
  userId: string;
  now?: number;
  consume?: boolean;
}): DemoAuthorization {
  const { voiceId, token, userId, now = Date.now(), consume = true } = input;
  if (typeof voiceId !== "string" || !voiceId) return { ok: false, reason: "voice" };
  const payload = readDemoToken(token);
  if (!payload) return { ok: false, reason: "token" };
  if (payload.v !== voiceId) return { ok: false, reason: "voice" };
  if (payload.u !== userId) return { ok: false, reason: "owner" };
  if (deleted.has(voiceId)) return { ok: false, reason: "deleted" };

  let entry = live.get(voiceId);
  if (entry && entry.ownerId !== userId) return { ok: false, reason: "owner" };
  const expiresAt = entry ? Math.min(entry.expiresAt, payload.e) : payload.e;
  if (now >= expiresAt) return { ok: false, reason: "expired" };

  // Not in this instance's map: the clone happened on another one (or in
  // another route's bundle — see the header). The signature is the proof it
  // was created by step 3; adopt it so the line counter has somewhere to live.
  if (!entry) {
    entry = { ownerId: userId, createdAt: payload.e - DEMO_TTL_MS, expiresAt: payload.e, linesUsed: 0 };
    live.set(voiceId, entry);
  }
  if (entry.linesUsed >= DEMO_MAX_LINES) return { ok: false, reason: "lines" };
  if (consume) entry.linesUsed += 1;
  return { ok: true, linesLeft: DEMO_MAX_LINES - entry.linesUsed };
}

/** Count one spoken line against a voice authorizeDemoVoice already let through. */
export function countDemoLine(voiceId: string): number {
  const entry = live.get(voiceId);
  if (!entry) return 0;
  entry.linesUsed += 1;
  return Math.max(0, DEMO_MAX_LINES - entry.linesUsed);
}

// ── ElevenLabs ─────────────────────────────────────────────────────────────

function apiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set");
  return key;
}

export interface CloneResult {
  voiceId: string;
  token: string;
  expiresAt: number;
  linesLeft: number;
}

export class DemoUpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/**
 * Make the instant clone. The caller has ALREADY checked the flag, the
 * founder, the consent and the cap — this function's only job is the add.
 */
export async function createDemoVoice(input: {
  sample: Blob;
  fileName: string;
  ownerId: string;
  removeBackgroundNoise: boolean;
  now?: number;
}): Promise<CloneResult> {
  const now = input.now ?? Date.now();
  const expiresAt = now + DEMO_TTL_MS;
  const name = `${DEMO_VOICE_PREFIX}${randomBytes(4).toString("hex")}`;

  const form = new FormData();
  form.append("name", name);
  form.append("files", input.sample, input.fileName);
  form.append("remove_background_noise", input.removeBackgroundNoise ? "true" : "false");
  form.append("description", "TAOS sidewalk demo. Deleted automatically within 10 minutes.");
  form.append("labels", JSON.stringify({ taos: "demo", expires: new Date(expiresAt).toISOString() }));

  const started = Date.now();
  const res = await fetch(`${ELEVENLABS}/v1/voices/add`, {
    method: "POST",
    headers: { "xi-api-key": apiKey() },
    body: form,
    cache: "no-store",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // The detail can carry ElevenLabs' explanation; it never carries the key.
    console.error(`[taos-demo] event=clone_failed http=${res.status} ${detail.slice(0, 200)}`);
    throw new DemoUpstreamError("Voice cloning failed.", res.status);
  }
  const payload = (await res.json().catch(() => ({}))) as { voice_id?: unknown };
  const voiceId = typeof payload.voice_id === "string" ? payload.voice_id : "";
  if (!voiceId) throw new DemoUpstreamError("Voice cloning returned no voice.", 502);

  live.set(voiceId, { ownerId: input.ownerId, createdAt: now, expiresAt, linesUsed: 0 });
  countClone(input.ownerId, now);
  demoLog({ event: "clone", voice: voiceId, ms: Date.now() - started });
  return {
    voiceId,
    token: mintDemoToken({ v: voiceId, u: input.ownerId, e: expiresAt }),
    expiresAt,
    linesLeft: DEMO_MAX_LINES
  };
}

/**
 * Delete one demo voice. True when it is gone — including when ElevenLabs
 * says it was already gone, which is the normal answer for the second of
 * "Done" and the page-unload beacon.
 *
 * "Already gone" is NOT a 404 here. Probed against the real API 2026-10-24:
 * a second DELETE answers 400 with `detail.code: "voice_not_found"`. Matching
 * only 404 would have reported every second delete as a failure.
 */
export function alreadyGone(status: number, body: string): boolean {
  return status === 404 || (status === 400 && body.includes("voice_not_found"));
}

export async function deleteDemoVoice(voiceId: string, reason: string): Promise<boolean> {
  const started = Date.now();
  live.delete(voiceId);
  deleted.add(voiceId);
  if (deleted.size > 500) deleted.delete(deleted.values().next().value as string);
  try {
    const res = await fetch(`${ELEVENLABS}/v1/voices/${encodeURIComponent(voiceId)}`, {
      method: "DELETE",
      headers: { "xi-api-key": apiKey() },
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
    const gone = res.ok || alreadyGone(res.status, res.ok ? "" : await res.text().catch(() => ""));
    demoLog({ event: "delete", voice: voiceId, reason, http: res.status, ms: Date.now() - started });
    return gone;
  } catch (e) {
    demoLog({ event: "delete_failed", voice: voiceId, reason, ms: Date.now() - started });
    console.error(`[taos-demo] delete error: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

interface ListedVoice {
  voice_id?: unknown;
  name?: unknown;
  labels?: unknown;
  created_at_unix?: unknown;
}

/** Every voice on the account whose name starts with the demo prefix. */
async function listDemoVoices(): Promise<ListedVoice[]> {
  const out: ListedVoice[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const url = new URL(`${ELEVENLABS}/v2/voices`);
    url.searchParams.set("search", DEMO_VOICE_PREFIX);
    url.searchParams.set("page_size", "100");
    if (pageToken) url.searchParams.set("next_page_token", pageToken);
    const res = await fetch(url, {
      headers: { "xi-api-key": apiKey() },
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
    if (!res.ok) throw new DemoUpstreamError("Listing voices failed.", res.status);
    const body = (await res.json().catch(() => ({}))) as {
      voices?: ListedVoice[];
      has_more?: boolean;
      next_page_token?: string | null;
    };
    for (const v of body.voices ?? []) {
      // `search` is fuzzy; the prefix is the contract.
      if (typeof v.name === "string" && v.name.startsWith(DEMO_VOICE_PREFIX)) out.push(v);
    }
    if (!body.has_more || !body.next_page_token) break;
    pageToken = body.next_page_token;
  }
  return out;
}

/**
 * When does a listed voice expire? Its own `expires` label first (we wrote
 * it), then its creation time plus the TTL. Null when it carries neither —
 * a `taos-demo-*` voice nobody can date is a stray, and strays go.
 */
function listedExpiry(v: ListedVoice): number | null {
  const labels = (v.labels && typeof v.labels === "object" ? v.labels : {}) as Record<string, unknown>;
  const fromLabel = typeof labels.expires === "string" ? Date.parse(labels.expires) : NaN;
  if (Number.isFinite(fromLabel)) return fromLabel;
  if (typeof v.created_at_unix === "number" && v.created_at_unix > 0) {
    return v.created_at_unix * 1000 + DEMO_TTL_MS;
  }
  return null;
}

export interface SweepResult {
  deleted: string[];
  kept: number;
  listError: string | null;
}

/**
 * Delete every demo voice older than ten minutes: the ones this instance
 * remembers, and — because memory does not survive a cold start — every
 * `taos-demo-*` voice ElevenLabs still has whose time is up.
 *
 * Voices still inside their ten minutes are KEPT even when this instance has
 * never heard of them: another instance may be mid-reveal with one.
 */
export async function sweepDemoVoices(now = Date.now()): Promise<SweepResult> {
  const started = Date.now();
  const doomed = new Set<string>();
  for (const [id, v] of live) if (now >= v.expiresAt) doomed.add(id);

  let kept = 0;
  let listError: string | null = null;
  try {
    for (const v of await listDemoVoices()) {
      if (typeof v.voice_id !== "string") continue;
      const expiry = listedExpiry(v);
      if (expiry === null || now >= expiry) doomed.add(v.voice_id);
      else kept += 1;
    }
  } catch (e) {
    // The local half still runs: a failed list must not also skip the voices
    // this instance knows are overdue.
    listError = e instanceof Error ? e.message : String(e);
  }

  const gone: string[] = [];
  for (const id of doomed) if (await deleteDemoVoice(id, "sweep")) gone.push(id);
  demoLog({ event: "sweep", deleted: gone.length, kept, ms: Date.now() - started });
  return { deleted: gone, kept, listError };
}
