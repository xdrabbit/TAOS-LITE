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
}

export async function getProfile(): Promise<Profile | null> {
  // RLS returns only the signed-in user's own profile row.
  const { data, error } = await supabase
    .from("profiles")
    .select(
      "id, email, plan, subscription_status, stripe_customer_id, trial_ends_at, current_period_end"
    )
    .maybeSingle();
  if (error) return null;
  return (data as Profile | null) ?? null;
}

// ── Usage-based free trial ───────────────────────────────────────────────
// New users get a usage allowance instead of a time-limited trial: a handful
// of translations and a few minutes of the conversation tutor. Once a feature's
// allowance is spent, that feature prompts an upgrade. Subscribing unlocks all.
export const TRIAL_TRANSLATIONS = 25;
export const TRIAL_TUTOR_SECONDS = 15 * 60; // 15 minutes of conversation tutor

export interface TrialUsage {
  translations: number;
  tutorSeconds: number;
}

// True for paying/comped users — they bypass all usage gates.
export function isSubscriber(p: Profile | null): boolean {
  return !!p && (p.subscription_status === "active" || p.subscription_status === "comp");
}

// Whole-app gate: subscribers and active trial users get in; the per-feature
// usage gates below handle exhaustion. Canceled/none → paywall.
export function hasAccess(p: Profile | null): boolean {
  if (!p) return false;
  return (
    p.subscription_status === "active" ||
    p.subscription_status === "comp" ||
    p.subscription_status === "trialing"
  );
}

// Counts the signed-in user's lifetime usage (RLS scopes to them). For a trial
// user that equals their trial consumption; subscribers ignore these anyway.
export async function getTrialUsage(): Promise<TrialUsage> {
  const [tx, ts] = await Promise.all([
    supabase.from(TABLE).select("id", { count: "exact", head: true }),
    supabase.from("tutor_sessions").select("seconds").eq("mode", "conversation")
  ]);
  const translations = tx.count ?? 0;
  const rows = (ts.data ?? []) as Array<{ seconds?: number | null }>;
  const tutorSeconds = rows.reduce((a, r) => a + (typeof r.seconds === "number" ? r.seconds : 0), 0);
  return { translations, tutorSeconds };
}

export function translationsLeft(p: Profile | null, u: TrialUsage | null): number {
  if (isSubscriber(p)) return Infinity;
  return Math.max(0, TRIAL_TRANSLATIONS - (u?.translations ?? 0));
}

export function tutorSecondsLeft(p: Profile | null, u: TrialUsage | null): number {
  if (isSubscriber(p)) return Infinity;
  return Math.max(0, TRIAL_TUTOR_SECONDS - (u?.tutorSeconds ?? 0));
}

// Shared Stripe Checkout launcher (used by the paywall and the inline upgrade
// prompts). Redirects the browser to Stripe on success.
export async function startCheckout(): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Please sign in again.");
  const res = await fetch("/api/stripe/checkout", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` }
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
