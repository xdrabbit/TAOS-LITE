import { createClient, type User } from "@supabase/supabase-js";

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://duqkmuaceklnfgvoufrz.supabase.co";
const SUPABASE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "sb_publishable_LBhw7XTAhPWjNhbmjcf3uA_r_tbaALD";

// Validate the caller's Supabase access token (sent as a Bearer header) and
// return the user, or null if missing/invalid.
export async function getUserFromRequest(req: Request): Promise<User | null> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  const client = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}
