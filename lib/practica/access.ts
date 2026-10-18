import { isFounder } from "@/lib/release";

/** Server-only release switch. Unset, malformed, or any value except `1` is off. */
export function practicaEnabled(raw = process.env.TAOS_PRACTICA_ENABLED): boolean {
  return raw?.trim() === "1";
}

/**
 * The page needs all three values before it can offer a session. Keeping this
 * stricter than the release flag makes a half-configured preview fail closed.
 */
export function practicaConfigured(
  env: Record<string, string | undefined> = process.env
): boolean {
  const voiceReady =
    practicaEnabled(env.TAOS_PRACTICA_ENABLED) &&
    Boolean(env.ELEVENLABS_API_KEY?.trim()) &&
    Boolean(env.ELEVENLABS_AGENT_ID?.trim());
  if (!voiceReady) return false;

  if (env.TAOS_PRACTICA_FACE?.trim().toLowerCase() !== "anam") return true;
  return (
    Boolean(env.ANAM_API_KEY?.trim()) &&
    Boolean(env.ANAM_AVATAR_ID?.trim()) &&
    env.ANAM_ZERO_DATA_RETENTION_CONFIRMED?.trim() === "1"
  );
}

/** The same two-part decision is used by the page and every paid API route. */
export function practicaVisibleTo(
  email: string | null | undefined,
  enabled = practicaEnabled()
): boolean {
  return enabled && isFounder(email);
}

export const PRACTICA_NOT_ENABLED = "Not enabled · No habilitado";
