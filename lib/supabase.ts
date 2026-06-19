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

// Gate: active/comp subscribers always in; trial users in until trial_ends_at.
export function hasAccess(p: Profile | null): boolean {
  if (!p) return false;
  if (p.subscription_status === "active" || p.subscription_status === "comp") return true;
  if (p.subscription_status === "trialing") {
    return !p.trial_ends_at || new Date(p.trial_ends_at).getTime() > Date.now();
  }
  return false;
}
