import { createClient } from "@supabase/supabase-js";

// Server-only client using the service-role key — bypasses RLS so the Stripe
// webhook can update any user's profile. NEVER import this into client code.
const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://duqkmuaceklnfgvoufrz.supabase.co";

export const supabaseAdmin = createClient(
  SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || "service-role-not-set-build-placeholder",
  { auth: { persistSession: false, autoRefreshToken: false } }
);
