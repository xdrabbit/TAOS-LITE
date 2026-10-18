const API = "https://api.elevenlabs.io/v1/convai";
const NAME = "TAOS Practica con Liz (spike)";
const LIZ_VOICE_ID = "tpOaz7u8rY4nup9rRUmh";
const NPC_VOICE_ID = "pNInz6obpgDQGcFmaJgB"; // Adam, ElevenLabs premade English voice.

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function eleven(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      "xi-api-key": required("ELEVENLABS_API_KEY"),
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers
    }
  });
}

async function main(): Promise<void> {
  const search = await eleven(
    `/agents?page_size=100&created_by_user_id=%40me&search=${encodeURIComponent(NAME)}`
  );
  if (!search.ok) throw new Error(`ElevenLabs list failed: ${search.status} ${await search.text()}`);
  const listed = (await search.json()) as {
    agents?: Array<{ agent_id?: string; name?: string; archived?: boolean }>;
  };
  const existing = listed.agents?.find((agent) => agent.name === NAME && !agent.archived);
  if (existing?.agent_id) {
    process.stdout.write(`${existing.agent_id}\n`);
    return;
  }

  const created = await eleven("/agents/create", {
    method: "POST",
    body: JSON.stringify({
      name: NAME,
      tags: ["taos", "practica", "founders-spike"],
      conversation_config: {
        asr: { quality: "high", provider: "scribe_realtime", user_input_audio_format: "pcm_16000" },
        turn: { turn_eagerness: "normal", turn_timeout: 10, silence_end_call_timeout: 90 },
        tts: {
          model_id: "eleven_v3_conversational",
          voice_id: LIZ_VOICE_ID,
          supported_voices: [
            {
              label: "NPC",
              voice_id: NPC_VOICE_ID,
              language: "en",
              model_family: "v3_conversational",
              description: "The English-speaking clerk, cashier, officer, ranger, or server in the current scene."
            }
          ],
          agent_output_audio_format: "pcm_16000",
          stability: 0.5,
          similarity_boost: 0.8
        },
        conversation: { max_duration_seconds: 300 },
        agent: {
          first_message: "La práctica está lista. Empecemos.",
          language: "es",
          max_conversation_duration_message: "Llegamos al límite de cinco minutos. Terminemos con una breve reflexión.",
          prompt: {
            llm: "gemini-2.5-flash",
            temperature: 0.2,
            prompt:
              "You are Liz, a bilingual Spanish-speaking language tutor. The per-session system prompt supplies the scene. Follow it exactly."
          }
        }
      },
      platform_settings: {
        auth: { enable_auth: true },
        overrides: {
          conversation_config_override: {
            agent: { first_message: true, prompt: { prompt: true } }
          }
        },
        privacy: {
          record_voice: false,
          delete_transcript_and_pii: true,
          delete_audio: true,
          zero_retention_mode: true
        },
        call_limits: { agent_concurrency_limit: 2, daily_limit: 50 },
        queueing_config: { enabled: false }
      }
    })
  });
  if (!created.ok) throw new Error(`ElevenLabs create failed: ${created.status} ${await created.text()}`);
  const payload = (await created.json()) as { agent_id?: string };
  if (!payload.agent_id) throw new Error("ElevenLabs returned no agent_id.");
  process.stdout.write(`${payload.agent_id}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
