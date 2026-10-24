// The ElevenLabs half of the voice-clone screens (/demo and /voz): add an
// instant clone, delete it, list the ones a prefix names, and speak in one.
//
// Neither screen keeps a voice: each names its clones with its own prefix
// (`taos-demo-*`, `taos-voz-*`) and writes an `expires` label, and its sweep
// lists by that prefix and deletes what is past due. The prefix is the
// contract — it is what lets one sweep tell its voices from Tom's and Liz's.

const ELEVENLABS = "https://api.elevenlabs.io";
const UPSTREAM_TIMEOUT_MS = 30_000;

function apiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set");
  return key;
}

export class VoiceUpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/** Make an instant clone. Returns its voice id. The caller has done every check. */
export async function addInstantVoice(input: {
  name: string;
  sample: Blob;
  fileName: string;
  removeBackgroundNoise: boolean;
  description: string;
  labels: Record<string, string>;
  /** `[taos-demo]` / `[taos-voz]` — whose failure line this is. */
  logTag: string;
}): Promise<string> {
  const form = new FormData();
  form.append("name", input.name);
  form.append("files", input.sample, input.fileName);
  form.append("remove_background_noise", input.removeBackgroundNoise ? "true" : "false");
  form.append("description", input.description);
  form.append("labels", JSON.stringify(input.labels));

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
    console.error(`${input.logTag} event=clone_failed http=${res.status} ${detail.slice(0, 200)}`);
    throw new VoiceUpstreamError("Voice cloning failed.", res.status);
  }
  const payload = (await res.json().catch(() => ({}))) as { voice_id?: unknown };
  const voiceId = typeof payload.voice_id === "string" ? payload.voice_id : "";
  if (!voiceId) throw new VoiceUpstreamError("Voice cloning returned no voice.", 502);
  return voiceId;
}

/**
 * "Already gone" is NOT a 404 here. Probed against the real API 2026-10-24:
 * a second DELETE answers 400 with `detail.code: "voice_not_found"`. Matching
 * only 404 would have reported every second delete as a failure.
 */
export function alreadyGone(status: number, body: string): boolean {
  return status === 404 || (status === 400 && body.includes("voice_not_found"));
}

/** DELETE one voice. `gone` is true when it is gone, including already-gone. Throws on network failure. */
export async function deleteVoice(voiceId: string): Promise<{ gone: boolean; http: number }> {
  const res = await fetch(`${ELEVENLABS}/v1/voices/${encodeURIComponent(voiceId)}`, {
    method: "DELETE",
    headers: { "xi-api-key": apiKey() },
    cache: "no-store",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
  });
  const gone = res.ok || alreadyGone(res.status, res.ok ? "" : await res.text().catch(() => ""));
  return { gone, http: res.status };
}

export interface ListedVoice {
  voice_id?: unknown;
  name?: unknown;
  labels?: unknown;
  created_at_unix?: unknown;
}

/** Every voice on the account whose name starts with `prefix`. */
export async function listVoicesByPrefix(prefix: string): Promise<ListedVoice[]> {
  const out: ListedVoice[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const url = new URL(`${ELEVENLABS}/v2/voices`);
    url.searchParams.set("search", prefix);
    url.searchParams.set("page_size", "100");
    if (pageToken) url.searchParams.set("next_page_token", pageToken);
    const res = await fetch(url, {
      headers: { "xi-api-key": apiKey() },
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
    if (!res.ok) throw new VoiceUpstreamError("Listing voices failed.", res.status);
    const body = (await res.json().catch(() => ({}))) as {
      voices?: ListedVoice[];
      has_more?: boolean;
      next_page_token?: string | null;
    } | null;
    for (const v of body?.voices ?? []) {
      // `search` is fuzzy; the prefix is the contract.
      if (typeof v.name === "string" && v.name.startsWith(prefix)) out.push(v);
    }
    if (!body?.has_more || !body.next_page_token) break;
    pageToken = body.next_page_token;
  }
  return out;
}

/**
 * When does a listed voice expire? Its own `expires` label first (we wrote
 * it), then its creation time plus `ttlMs`. Null when it carries neither —
 * a prefixed voice nobody can date is a stray, and strays go.
 */
export function listedExpiry(v: ListedVoice, ttlMs: number): number | null {
  const labels = (v.labels && typeof v.labels === "object" ? v.labels : {}) as Record<string, unknown>;
  const fromLabel = typeof labels.expires === "string" ? Date.parse(labels.expires) : NaN;
  if (Number.isFinite(fromLabel)) return fromLabel;
  if (typeof v.created_at_unix === "number" && v.created_at_unix > 0) {
    return v.created_at_unix * 1000 + ttlMs;
  }
  return null;
}

/**
 * Speak `text` in an instant clone. Same model choice as /api/tts's
 * ElevenLabs path: Cantonese needs the v3 family, everything else turbo.
 */
export async function speakInVoice(text: string, voiceId: string, targetLanguage: string): Promise<ArrayBuffer> {
  const model =
    targetLanguage === "yue"
      ? process.env.ELEVENLABS_YUE_MODEL?.trim() || "eleven_v3"
      : process.env.ELEVENLABS_MODEL?.trim() || "eleven_turbo_v2_5";
  const res = await fetch(
    `${ELEVENLABS}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": apiKey(), "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: model, voice_settings: { stability: 0.4, similarity_boost: 0.8 } }),
      cache: "no-store",
      signal: AbortSignal.timeout(45_000)
    }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[taos-voz] event=tts_failed http=${res.status} ${detail.slice(0, 200)}`);
    throw new VoiceUpstreamError("Voice playback failed.", res.status);
  }
  return res.arrayBuffer();
}
