// /voz — the public "Tu voz" — the server half: who is asking, may they,
// clone, authorize a line, delete, sweep.
//
// /demo (#105) is a founder holding the phone. /voz is a stranger on THEIR
// OWN phone, from a link Tom texted, with no account. So the whole of this
// file is /demo's promise ("your voice is deleted, nothing is kept") plus the
// fences an anonymous front door needs:
//
//   consent  — the record button is useless without a CONSENT token, minted
//              when "Acepto · I agree" is tapped and good for 15 minutes; the
//              clone route refuses any sample that does not carry one. That
//              is how "only the page's own recorder" is enforced: there is no
//              way to clone without first walking through the consent screen.
//   per day  — 1 try anonymous, 3 signed in, 10 subscribed. Counted in a
//              signed httpOnly cookie AND in this instance's memory keyed by
//              the account (signed in) or the device + an IP-and-UA hash
//              (anonymous), and the larger of the counts wins.
//   global   — TAOS_VOZ_DAILY_CAP anonymous clones per UTC day (default 50),
//              and TAOS_VOZ_MAX_LIVE voices alive at once (default 20).
//   per IP   — VOZ_CLONES_PER_IP_PER_HOUR clone attempts.
//
// ── Be honest about what is per instance ───────────────────────────────────
// Same caveat as lib/spendGuard.ts: the day counters, the IP bucket and the
// global daily cap live in module memory, so they are per Vercel instance and
// reset on a cold start. The cookie survives instances but not "clear
// cookies". The ONE count here that is truly global is the live-voice
// ceiling: it is read from ElevenLabs itself (list `taos-voz-*`), which is the
// thing that actually costs a slot. No migrations were allowed for this, and
// a durable counter is the upgrade if the front door is ever abused for real.
//
// ── What is stored ─────────────────────────────────────────────────────────
// The sample: nowhere — forwarded to ElevenLabs in the clone request and
// dropped. The voice: on ElevenLabs, ≤ VOZ_TTL_MS. The cookie: a random
// device id, today's date and a try count — no name, no audio, no text. No
// database row and no tts_log row: lines never touch /api/tts.

import { createHash, randomBytes } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import type { User } from "@supabase/supabase-js";
import { callerIp, hit } from "@/lib/spendGuard";
import { isFounder } from "@/lib/release";
import { supabaseAdmin, hasServiceRoleKey } from "@/lib/supabaseAdmin";
import { tierFromProfile } from "@/lib/tutor/meter";
import {
  addInstantVoice,
  deleteVoice,
  listVoicesByPrefix,
  listedExpiry
} from "./elevenlabs";
import { mintSignedToken, readSignedToken } from "./token";
import {
  VOZ_CLONES_PER_IP_PER_HOUR,
  VOZ_CONSENT_TTL_MS,
  VOZ_DEFAULT_DAILY_CAP,
  VOZ_DEFAULT_MAX_LIVE,
  VOZ_MAX_LINES,
  VOZ_TRIES_PER_DAY,
  VOZ_TTL_MS,
  VOZ_VOICE_PREFIX,
  type VozTier
} from "./limits";

/** Server-only flag (`TAOS_VOZ_ENABLED=1`). Unset → every /api/voz route is a 404. */
export function vozEnabled(): boolean {
  const flag = (process.env.TAOS_VOZ_ENABLED ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true";
}

function positiveEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export function vozDailyCap(): number {
  return positiveEnv("TAOS_VOZ_DAILY_CAP", VOZ_DEFAULT_DAILY_CAP);
}

export function vozMaxLive(): number {
  return positiveEnv("TAOS_VOZ_MAX_LIVE", VOZ_DEFAULT_MAX_LIVE);
}

/** One line per event: no audio, no text, no name. `[taos-voz] event=… tier=…`. */
export function vozLog(fields: Record<string, string | number>): void {
  const parts = Object.entries(fields).map(
    ([k, v]) => `${k}=${String(v).replace(/[^0-9A-Za-z_.:-]/g, "").slice(0, 48) || "?"}`
  );
  console.log(["[taos-voz]", ...parts].join(" "));
}

/** The refusal a stranger sees when a ceiling is hit. */
export const COME_BACK_TOMORROW = "Vuelve mañana · Come back tomorrow";

// ── Tokens and the cookie ──────────────────────────────────────────────────

const DOMAIN = "taos-voz-token:v1";
export const VOZ_COOKIE = "taos_voz";

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** The device cookie: a random id, a UTC day, and the tries made that day. */
export interface VozDevice {
  id: string;
  day: string;
  tries: number;
}

export function readDeviceCookie(raw: string | undefined, now = Date.now()): VozDevice | null {
  const p = readSignedToken(DOMAIN, raw);
  if (!p || p.k !== "dev" || typeof p.i !== "string" || typeof p.d !== "string" || typeof p.c !== "number") {
    return null;
  }
  const today = utcDay(now);
  return { id: p.i, day: today, tries: p.d === today ? p.c : 0 };
}

export function deviceCookieValue(device: VozDevice): string {
  return mintSignedToken(DOMAIN, { k: "dev", i: device.id, d: device.day, c: device.tries });
}

export function setDeviceCookie(res: NextResponse, device: VozDevice): void {
  res.cookies.set(VOZ_COOKIE, deviceCookieValue(device), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/voz",
    maxAge: 60 * 60 * 24 * 365
  });
}

// ── Who is asking ──────────────────────────────────────────────────────────

export interface VozCaller {
  /** `u:<user id>` signed in, `d:<device id>` anonymous. Tokens are bound to it. */
  owner: string;
  tier: VozTier;
  userId: string | null;
  device: VozDevice;
  ip: string;
  /** Hash of IP + user agent: the second anonymous bucket, for a cleared cookie. */
  ipua: string;
}

/** Subscriber (or comp, or founder) → 10 a day. A failed lookup is "free", never "subscriber". */
async function isSubscriberUser(user: User): Promise<boolean> {
  if (isFounder(user.email)) return true;
  if (!hasServiceRoleKey) return false;
  try {
    const { data } = await supabaseAdmin
      .from("profiles")
      .select("tier, subscription_status")
      .eq("id", user.id)
      .maybeSingle();
    return tierFromProfile(data as { tier?: string | null; subscription_status?: string | null } | null) !== "free";
  } catch {
    return false;
  }
}

export async function identifyCaller(req: NextRequest, user: User | null, now = Date.now()): Promise<VozCaller> {
  const device =
    readDeviceCookie(req.cookies.get(VOZ_COOKIE)?.value, now) ??
    ({ id: randomBytes(12).toString("base64url"), day: utcDay(now), tries: 0 } satisfies VozDevice);
  const ip = callerIp(req);
  const ipua = createHash("sha256")
    .update(`${ip}|${req.headers.get("user-agent") ?? ""}`)
    .digest("base64url")
    .slice(0, 16);
  const tier: VozTier = user ? ((await isSubscriberUser(user)) ? "subscriber" : "free") : "anonymous";
  return { owner: user ? `u:${user.id}` : `d:${device.id}`, tier, userId: user?.id ?? null, device, ip, ipua };
}

// ── Per-instance state ─────────────────────────────────────────────────────

interface Day {
  day: string;
  count: number;
}

/** owner / `ipua:<hash>` → tries on `day`. */
const triesByKey = new Map<string, Day>();
let anonymousToday: Day = { day: "", count: 0 };
const ipHour = new Map<string, { count: number; resetAt: number }>();
/** Consent nonces already turned into a clone on this instance. */
const spentConsent = new Set<string>();

interface LiveVoice {
  owner: string;
  expiresAt: number;
  linesUsed: number;
}
const live = new Map<string, LiveVoice>();
const deleted = new Set<string>();

/** Tests only: a fresh instance is the production reset. */
export function resetVozState(): void {
  triesByKey.clear();
  anonymousToday = { day: "", count: 0 };
  ipHour.clear();
  spentConsent.clear();
  live.clear();
  deleted.clear();
}

function countFor(key: string, today: string): number {
  const e = triesByKey.get(key);
  return e && e.day === today ? e.count : 0;
}

function bump(key: string, today: string): void {
  triesByKey.set(key, { day: today, count: countFor(key, today) + 1 });
  if (triesByKey.size > 5000) for (const [k, v] of triesByKey) if (v.day !== today) triesByKey.delete(k);
}

/** Tries left today for this caller, by the largest count any of its buckets holds. */
export function triesLeft(caller: VozCaller, now = Date.now()): number {
  const today = utcDay(now);
  let used = Math.max(caller.device.tries, countFor(caller.owner, today));
  if (caller.tier === "anonymous") used = Math.max(used, countFor(`ipua:${caller.ipua}`, today));
  return Math.max(0, VOZ_TRIES_PER_DAY[caller.tier] - used);
}

export interface VozRefusal {
  status: number;
  code: "daily" | "cap" | "live" | "rate" | "consent";
  error: string;
}

/** May this caller start a try at all? Checked at consent AND again at clone. Spends nothing. */
export function checkAllowance(caller: VozCaller, now = Date.now()): VozRefusal | null {
  if (triesLeft(caller, now) <= 0) {
    return {
      status: 429,
      code: "daily",
      error:
        caller.tier === "anonymous"
          ? "Ya usaste tu prueba de hoy · You've used today's free try"
          : COME_BACK_TOMORROW
    };
  }
  if (caller.tier === "anonymous") {
    const today = utcDay(now);
    const used = anonymousToday.day === today ? anonymousToday.count : 0;
    if (used >= vozDailyCap()) return { status: 429, code: "cap", error: COME_BACK_TOMORROW };
  }
  return null;
}

/** Count one clone attempt from this IP. False once the hour's allowance is gone. */
export function ipAllows(ip: string, now = Date.now()): boolean {
  return hit(ipHour, `ip:${ip}`, VOZ_CLONES_PER_IP_PER_HOUR, 3_600_000, now);
}

/** Count a try that produced a voice: every bucket, the cookie, the global day. */
export function countTry(caller: VozCaller, now = Date.now()): void {
  const today = utcDay(now);
  bump(caller.owner, today);
  if (caller.tier === "anonymous") {
    bump(`ipua:${caller.ipua}`, today);
    anonymousToday =
      anonymousToday.day === today ? { day: today, count: anonymousToday.count + 1 } : { day: today, count: 1 };
  }
  caller.device = { ...caller.device, day: today, tries: caller.device.tries + 1 };
}

// ── Consent token ──────────────────────────────────────────────────────────

export function mintConsentToken(owner: string, now = Date.now()): { token: string; expiresAt: number } {
  const expiresAt = now + VOZ_CONSENT_TTL_MS;
  const nonce = randomBytes(9).toString("base64url");
  return { token: mintSignedToken(DOMAIN, { k: "c", o: owner, n: nonce, e: expiresAt }), expiresAt };
}

/** The nonce if this is a live consent token for `owner`, else null. Does not spend it. */
export function checkConsentToken(token: unknown, owner: string, now = Date.now()): string | null {
  const p = readSignedToken(DOMAIN, token);
  if (!p || p.k !== "c" || p.o !== owner || typeof p.n !== "string" || typeof p.e !== "number") return null;
  if (now >= p.e || spentConsent.has(p.n)) return null;
  return p.n;
}

export function spendConsent(nonce: string): void {
  spentConsent.add(nonce);
  if (spentConsent.size > 5000) spentConsent.delete(spentConsent.values().next().value as string);
}

// ── Voice token ────────────────────────────────────────────────────────────

interface VoicePayload {
  v: string;
  o: string;
  e: number;
}

export function readVoiceToken(token: unknown): VoicePayload | null {
  const p = readSignedToken(DOMAIN, token);
  if (!p || p.k !== "v" || typeof p.v !== "string" || typeof p.o !== "string" || typeof p.e !== "number") {
    return null;
  }
  return { v: p.v, o: p.o, e: p.e };
}

export type VozLineAuthorization =
  | { ok: true; linesLeft: number }
  | { ok: false; reason: "token" | "voice" | "owner" | "expired" | "deleted" | "lines" };

/**
 * May this caller have one more line spoken in `voiceId`? Only the voice its
 * own consent made, inside its ten minutes, for its first VOZ_MAX_LINES. Does
 * not count the line: the route counts it after the audio exists, so a
 * provider failure does not eat one of the two.
 */
export function authorizeLine(input: {
  voiceId: unknown;
  token: unknown;
  owner: string;
  now?: number;
}): VozLineAuthorization {
  const { voiceId, token, owner, now = Date.now() } = input;
  if (typeof voiceId !== "string" || !voiceId) return { ok: false, reason: "voice" };
  const p = readVoiceToken(token);
  if (!p) return { ok: false, reason: "token" };
  if (p.v !== voiceId) return { ok: false, reason: "voice" };
  if (p.o !== owner) return { ok: false, reason: "owner" };
  if (deleted.has(voiceId)) return { ok: false, reason: "deleted" };
  let entry = live.get(voiceId);
  const expiresAt = entry ? Math.min(entry.expiresAt, p.e) : p.e;
  if (now >= expiresAt) return { ok: false, reason: "expired" };
  if (!entry) {
    // Cloned on another instance; the signature proves it was ours.
    entry = { owner, expiresAt: p.e, linesUsed: 0 };
    live.set(voiceId, entry);
  }
  if (entry.linesUsed >= VOZ_MAX_LINES) return { ok: false, reason: "lines" };
  return { ok: true, linesLeft: VOZ_MAX_LINES - entry.linesUsed };
}

/** Count one spoken line. Returns lines left. */
export function countLine(voiceId: string): number {
  const entry = live.get(voiceId);
  if (!entry) return 0;
  entry.linesUsed += 1;
  return Math.max(0, VOZ_MAX_LINES - entry.linesUsed);
}

// ── ElevenLabs ─────────────────────────────────────────────────────────────

export interface VozClone {
  voiceId: string;
  token: string;
  expiresAt: number;
  linesLeft: number;
}

export async function createVozVoice(input: {
  sample: Blob;
  fileName: string;
  caller: VozCaller;
  removeBackgroundNoise: boolean;
  now?: number;
}): Promise<VozClone> {
  const now = input.now ?? Date.now();
  const expiresAt = now + VOZ_TTL_MS;
  const started = Date.now();
  const voiceId = await addInstantVoice({
    name: `${VOZ_VOICE_PREFIX}${randomBytes(4).toString("hex")}`,
    sample: input.sample,
    fileName: input.fileName,
    removeBackgroundNoise: input.removeBackgroundNoise,
    description: "TAOS public Tu voz try. Deleted automatically within 10 minutes.",
    labels: { taos: "voz", expires: new Date(expiresAt).toISOString() },
    logTag: "[taos-voz]"
  });
  live.set(voiceId, { owner: input.caller.owner, expiresAt, linesUsed: 0 });
  vozLog({ event: "clone", voice: voiceId, tier: input.caller.tier, ms: Date.now() - started });
  return {
    voiceId,
    token: mintSignedToken(DOMAIN, { k: "v", v: voiceId, o: input.caller.owner, e: expiresAt }),
    expiresAt,
    linesLeft: VOZ_MAX_LINES
  };
}

export async function deleteVozVoice(voiceId: string, reason: string): Promise<boolean> {
  const started = Date.now();
  live.delete(voiceId);
  deleted.add(voiceId);
  if (deleted.size > 500) deleted.delete(deleted.values().next().value as string);
  try {
    const { gone, http } = await deleteVoice(voiceId);
    vozLog({ event: "delete", voice: voiceId, reason, http, ms: Date.now() - started });
    return gone;
  } catch (e) {
    vozLog({ event: "delete_failed", voice: voiceId, reason, ms: Date.now() - started });
    console.error(`[taos-voz] delete error: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

export interface VozSweepResult {
  deleted: string[];
  /** `taos-voz-*` voices still inside their ten minutes, account-wide. */
  kept: number;
  listError: string | null;
}

/**
 * Delete every `taos-voz-*` voice past its ten minutes — the ones this
 * instance remembers, and every one ElevenLabs still lists (memory does not
 * survive a cold start). Fresh voices are kept even when unknown here:
 * another instance may be mid-reveal with one.
 */
export async function sweepVozVoices(now = Date.now()): Promise<VozSweepResult> {
  const started = Date.now();
  const doomed = new Set<string>();
  for (const [id, v] of live) if (now >= v.expiresAt) doomed.add(id);
  let kept = 0;
  let listError: string | null = null;
  try {
    for (const v of await listVoicesByPrefix(VOZ_VOICE_PREFIX)) {
      if (typeof v.voice_id !== "string") continue;
      const expiry = listedExpiry(v, VOZ_TTL_MS);
      if (expiry === null || now >= expiry) doomed.add(v.voice_id);
      else kept += 1;
    }
  } catch (e) {
    listError = e instanceof Error ? e.message : String(e);
  }
  const gone: string[] = [];
  for (const id of doomed) if (await deleteVozVoice(id, "sweep")) gone.push(id);
  vozLog({ event: "sweep", deleted: gone.length, kept, ms: Date.now() - started });
  return { deleted: gone, kept, listError };
}

/**
 * How many voz voices are alive right now, account-wide — after sweeping the
 * overdue ones. Falls back to this instance's own count if ElevenLabs will
 * not list (refusing every stranger because a list call failed would be the
 * outage, not the fence).
 */
export async function liveVozVoices(now = Date.now()): Promise<number> {
  const result = await sweepVozVoices(now);
  if (result.listError === null) return result.kept;
  let local = 0;
  for (const v of live.values()) if (now < v.expiresAt) local += 1;
  return local;
}

/** Start a sweep without making the caller wait. Never throws. */
export function kickVozSweep(): void {
  try {
    waitUntil(sweepVozVoices().catch(() => undefined));
  } catch {
    // Outside a Vercel request context (tests, local) the promise still runs.
  }
}
