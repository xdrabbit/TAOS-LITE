import { createClient } from "@supabase/supabase-js";

// The publishable key is PUBLIC by design — it ships in the browser bundle of
// every Supabase app. Security comes from Row-Level Security on the table, not
// from hiding this key. The service_role key is the secret one and is NEVER
// used in the client.
// Dedicated TAOS-LITE Supabase project (isolated from other apps).
const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://duqkmuaceklnfgvoufrz.supabase.co";
const SUPABASE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "sb_publishable_LBhw7XTAhPWjNhbmjcf3uA_r_tbaALD";

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // Needed to complete the Google OAuth redirect (PKCE) back into the app.
    detectSessionInUrl: true,
    flowType: "pkce"
  }
});

const TABLE = "taos_lite_translations";

export interface HistoryRow {
  id: string;
  created_at: string;
  source_lang: string;
  target_lang: string;
  tone: string;
  original_text: string;
  translation_text: string;
  engine: string | null;
}

export interface NewTranslation {
  source_lang: string;
  target_lang: string;
  tone: string;
  original_text: string;
  translation_text: string;
  engine?: string | null;
}

// user_id is filled server-side by the column default auth.uid(); RLS guarantees
// the row can only belong to the signed-in user.
export async function saveTranslation(input: NewTranslation): Promise<void> {
  const { error } = await supabase.from(TABLE).insert(input);
  if (error) throw error;
}

export async function listHistory(limit = 200): Promise<HistoryRow[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as HistoryRow[];
}

export async function deleteHistoryItem(id: string): Promise<void> {
  const { error } = await supabase.from(TABLE).delete().eq("id", id);
  if (error) throw error;
}

export async function clearHistory(): Promise<void> {
  // RLS scopes this to the signed-in user's rows only. The neq sentinel matches
  // every real row (no row has the all-zero UUID).
  const { error } = await supabase
    .from(TABLE)
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");
  if (error) throw error;
}

export interface Profile {
  id: string;
  email: string | null;
  plan: string;
  subscription_status: string;
  stripe_customer_id: string | null;
  trial_ends_at: string;
  current_period_end: string | null;
  tier: string | null; // 'basic' | 'premium' | null (set by the Stripe webhook)
  bonus_seconds: number | null; // add-on pack balance for bonus_period
  bonus_period: string | null; // 'YYYY-MM' the bonus applies to
}

export async function getProfile(): Promise<Profile | null> {
  // RLS returns only the signed-in user's own profile row.
  const { data, error } = await supabase
    .from("profiles")
    .select(
      "id, email, plan, subscription_status, stripe_customer_id, trial_ends_at, current_period_end, tier, bonus_seconds, bonus_period"
    )
    .maybeSingle();
  if (error) return null;
  return (data as Profile | null) ?? null;
}

// ── Tiered plans with monthly-resetting quotas ───────────────────────────
// Free: a small monthly allowance. Basic/Premium: unlimited translation, more
// tutor minutes. Comp: unlimited everything. Quotas reset on the calendar month.
export type Tier = "free" | "basic" | "premium" | "comp";

export interface TierQuota {
  translations: number; // per month (Infinity = unlimited)
  tutorSeconds: number; // per month (Infinity = unlimited)
}

export const QUOTAS: Record<Tier, TierQuota> = {
  free: { translations: 25, tutorSeconds: 15 * 60 },
  basic: { translations: Infinity, tutorSeconds: 45 * 60 },
  premium: { translations: Infinity, tutorSeconds: 200 * 60 },
  comp: { translations: Infinity, tutorSeconds: Infinity }
};

export const TIER_LABEL: Record<Tier, string> = {
  free: "Free",
  basic: "Basic",
  premium: "Premium",
  comp: "Comp"
};

export interface MonthlyUsage {
  translations: number;
  tutorSeconds: number;
}

// A user's effective tier. Canceled/expired subscribers fall back to Free (they
// keep the free monthly allowance rather than being locked out).
export function getTier(p: Profile | null): Tier {
  if (!p) return "free";
  if (p.subscription_status === "comp") return "comp";
  if (p.subscription_status === "active") {
    return p.tier === "premium" ? "premium" : "basic";
  }
  return "free";
}

// Paid or comped → unlimited translation, no banners.
export function isSubscriber(p: Profile | null): boolean {
  const t = getTier(p);
  return t === "basic" || t === "premium" || t === "comp";
}

// Every signed-in user with a profile has access (at least the free tier).
export function hasAccess(p: Profile | null): boolean {
  return !!p;
}

function startOfMonthISO(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export function monthKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Add-on pack minutes only count if they were bought for the current month.
export function bonusSeconds(p: Profile | null): number {
  if (!p || p.bonus_period !== monthKey()) return 0;
  return typeof p.bonus_seconds === "number" ? p.bonus_seconds : 0;
}

// Usage within the current calendar month (RLS scopes to the signed-in user).
export async function getMonthlyUsage(): Promise<MonthlyUsage> {
  const since = startOfMonthISO();
  const [tx, ts] = await Promise.all([
    supabase.from(TABLE).select("id", { count: "exact", head: true }).gte("created_at", since),
    supabase
      .from("tutor_sessions")
      .select("seconds")
      .eq("mode", "conversation")
      .gte("created_at", since)
  ]);
  const translations = tx.count ?? 0;
  const rows = (ts.data ?? []) as Array<{ seconds?: number | null }>;
  const tutorSeconds = rows.reduce((a, r) => a + (typeof r.seconds === "number" ? r.seconds : 0), 0);
  return { translations, tutorSeconds };
}

// Back-compat alias (callers may still import getTrialUsage / TrialUsage).
export const getTrialUsage = getMonthlyUsage;
export type TrialUsage = MonthlyUsage;

export function translationsLeft(p: Profile | null, u: MonthlyUsage | null): number {
  const cap = QUOTAS[getTier(p)].translations;
  if (!Number.isFinite(cap)) return Infinity;
  return Math.max(0, cap - (u?.translations ?? 0));
}

export function tutorSecondsLeft(p: Profile | null, u: MonthlyUsage | null): number {
  const cap = QUOTAS[getTier(p)].tutorSeconds;
  if (!Number.isFinite(cap)) return Infinity;
  // Monthly quota + any add-on pack minutes bought this month.
  return Math.max(0, cap + bonusSeconds(p) - (u?.tutorSeconds ?? 0));
}

// Launch Stripe Checkout for a chosen plan; redirects the browser on success.
export async function startCheckout(plan: "basic" | "premium" = "basic"): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Please sign in again.");
  const res = await fetch("/api/stripe/checkout", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ plan })
  });
  const payload = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!res.ok || !payload.url) throw new Error(payload.error || "Could not start checkout.");
  window.location.href = payload.url;
}

// Buy a one-time add-on minute pack (paid users only). Redirects to Stripe.
export async function startPackCheckout(pack: "100" | "200" = "100"): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Please sign in again.");
  const res = await fetch("/api/stripe/pack", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ pack })
  });
  const payload = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!res.ok || !payload.url) throw new Error(payload.error || "Could not start checkout.");
  window.location.href = payload.url;
}

export interface TutorAttemptInput {
  course?: string;
  lesson_id: string;
  target_phrase: string;
  transcript?: string | null;
  target_lang?: string;
  accuracy_score?: number | null;
  fluency_score?: number | null;
  completeness_score?: number | null;
  prosody_score?: number | null;
  pron_score?: number | null;
  word_scores?: unknown;
}

// RLS + the user_id default(auth.uid()) keep each attempt private to its user.
export async function saveTutorAttempt(input: TutorAttemptInput): Promise<void> {
  const { error } = await supabase.from("tutor_attempts").insert(input);
  if (error) throw error;
}

export interface TutorSessionStart {
  mode?: string;
  learn_lang?: string;
  level?: string;
  focus?: string | null;
  model?: string | null;
}

// Conversation-tutor metering. Realtime is the priciest path, so we log a row at
// start and stamp the duration at end for cost visibility. RLS keeps it private.
export async function startTutorSession(input: TutorSessionStart): Promise<string | null> {
  const { data, error } = await supabase
    .from("tutor_sessions")
    .insert({ ...input, mode: input.mode ?? "conversation" })
    .select("id")
    .single();
  if (error) return null;
  return (data as { id: string } | null)?.id ?? null;
}

export async function endTutorSession(id: string, seconds: number): Promise<void> {
  // Best-effort; never block the UI on metering.
  await supabase
    .from("tutor_sessions")
    .update({ seconds: Math.max(0, Math.round(seconds)), ended_at: new Date().toISOString() })
    .eq("id", id);
}
