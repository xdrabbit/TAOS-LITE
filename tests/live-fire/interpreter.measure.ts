// Interpreter mode, against the real models. NOT a test: `npm test` never runs
// it (vitest.measure.config.ts), it needs OPENAI_API_KEY and it spends real
// money — a few cents a run.
//
//   OPENAI_API_KEY=… npx vitest run --config vitest.measure.config.ts \
//     tests/live-fire/interpreter.measure.ts
//
// What it answers, with the session objects the mint route actually sends
// (lib/interpreter/session.ts + lib/interpreter/briefing.ts — a rig must do
// what the client does):
//
//   1. Does a ONE-DIRECTION leg stay silent when it hears its own output
//      language? Two legs — one per direction — are what give each direction
//      its own voice, and the whole design rests on the wrong leg keeping
//      quiet. `silent n/n` is the number.
//   2. Does it interpret the right way round, and how long after the speaker
//      stops does the first audio arrive?
//   3. What does a turn cost, and does the context cap hold it flat?
//   4. What does gpt-realtime-translate do with speech that is ALREADY in its
//      output language? (The docs do not say.)
//
// The sentences are the rig's own — nobody's conversation.
//
// Knobs:
//   INTERPRETER_PROBE=legs|single|translate|all   (default all)
//   INTERPRETER_PROBE_MODEL=gpt-realtime-2.1

import { describe, it } from "vitest";
import { buildInterpreterBriefing, buildLegBriefing } from "@/lib/interpreter/briefing";
import { buildOpenAIRealtimeSession, buildOpenAITranslateSession } from "@/lib/interpreter/session";
import { addUsage, emptyInterpreterTally, estimateUsd } from "@/lib/interpreter/cost";
import type { RealtimeUsage } from "@/lib/call/cost";
import { requireKey, SAMPLE_RATE, synthesize, type Utterance } from "./realtime-driver";

const MODEL = process.env.INTERPRETER_PROBE_MODEL?.trim() || "gpt-realtime-2.1";
const WHICH = (process.env.INTERPRETER_PROBE ?? "all").trim().toLowerCase();

// A made-up table context, to prove the briefing is READ: the nickname and
// the regional word below only come out right if the model used it.
const PROBE_CONTEXT = [
  "The English speaker is Sam. The Spanish speaker is Ana; transcribers mishear her name as 'Anna Ma'.",
  "Ana's everyday words: 'sale' means okay/deal; 'me da cosa' means I feel bad about it; 'flojera' means feeling lazy."
].join("\n");

const SCRIPT: { lang: "en" | "es"; text: string }[] = [
  { lang: "en", text: "So how was your day? Did you get to rest at all?" },
  { lang: "es", text: "Más o menos. Me dio flojera salir, así que me quedé en casa toda la tarde." },
  { lang: "en", text: "That sounds nice, honestly. Do you want to go out for dinner tomorrow?" },
  { lang: "es", text: "Sale. Pero me da cosa dejar a mi hija sola otra vez." },
  { lang: "es", text: "Dijo que venía a las ocho." },
  { lang: "en", text: "Okay." }
];

const BYTES_PER_SAMPLE = 2;
const silence = (ms: number) => Buffer.alloc(Math.round((SAMPLE_RATE * BYTES_PER_SAMPLE * ms) / 1000));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Loudest sample in a base64 PCM16 chunk, 0..1 — is "audio" actually sound? */
function peakOf(b64: string): number {
  const buf = Buffer.from(b64, "base64");
  let peak = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const v = Math.abs(buf.readInt16LE(i));
    if (v > peak) peak = v;
  }
  return peak / 0x8000;
}

interface TurnProbe {
  lang: string;
  /** Peak of everything the model played this turn, 0..1. */
  peak: number;
  said: string;
  heard: string;
  spoke: boolean;
  firstAudioMs: number | null;
  status: string;
  usage: RealtimeUsage | null;
}

/** Drive one realtime leg with the script; one TurnProbe per utterance. */
async function runRealtimeLeg(
  label: string,
  session: Record<string, unknown>,
  utterances: (Utterance & { lang: string })[]
): Promise<TurnProbe[]> {
  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`, {
    headers: { Authorization: `Bearer ${requireKey()}` }
  } as unknown as string[]);

  let said = "";
  let heard = "";
  let audioAt: number | null = null;
  let doneCount = 0;
  let lastStatus = "";
  let lastUsage: RealtimeUsage | null = null;
  let spokeAudio = false;
  let peak = 0;
  let fatal: string | null = null;
  const seen = new Set<string>();

  ws.onmessage = ({ data }) => {
    const ev = JSON.parse(String(data)) as Record<string, unknown>;
    const type = String(ev.type ?? "");
    seen.add(type);
    if (type === "response.output_audio.delta") {
      spokeAudio = true;
      audioAt ??= Date.now();
      if (typeof ev.delta === "string") peak = Math.max(peak, peakOf(ev.delta));
    }
    if (type === "response.output_audio_transcript.delta" && typeof ev.delta === "string") said += ev.delta;
    if (type === "conversation.item.input_audio_transcription.completed" && typeof ev.transcript === "string") {
      heard += ev.transcript;
    }
    if (type === "response.done") {
      const r = (ev.response ?? {}) as { status?: string; usage?: RealtimeUsage };
      lastStatus = r.status ?? "";
      lastUsage = r.usage ?? null;
      doneCount += 1;
    }
    if (type === "error") {
      fatal = JSON.stringify(ev.error).slice(0, 300);
    }
  };

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`${label}: socket error`));
  });
  const send = (o: unknown) => ws.send(JSON.stringify(o));

  const { model: _m, ...rest } = session as { model?: string };
  const audio = (rest as { audio?: Record<string, unknown> }).audio ?? {};
  const input = (audio as { input?: Record<string, unknown> }).input ?? {};
  send({
    type: "session.update",
    session: { ...rest, audio: { ...audio, input: { ...input, format: { type: "audio/pcm", rate: SAMPLE_RATE } } } }
  });
  for (let i = 0; i < 50 && !seen.has("session.updated") && !fatal; i++) await sleep(100);
  if (fatal) {
    ws.close();
    throw new Error(`${label}: session rejected — ${fatal}`);
  }

  const out: TurnProbe[] = [];
  const chunk = (SAMPLE_RATE * BYTES_PER_SAMPLE) / 10;
  for (const u of utterances) {
    said = "";
    heard = "";
    audioAt = null;
    spokeAudio = false;
    peak = 0;
    lastStatus = "";
    lastUsage = null;
    const before = doneCount;
    for (let off = 0; off < u.pcm.length; off += chunk) {
      send({ type: "input_audio_buffer.append", audio: u.pcm.subarray(off, off + chunk).toString("base64") });
      await sleep(100);
    }
    const endedAt = Date.now();
    // Silence until the turn's response is done, the way a quiet table sounds.
    const quiet = silence(100).toString("base64");
    let waited = 0;
    while (waited < 15_000) {
      send({ type: "input_audio_buffer.append", audio: quiet });
      await sleep(100);
      waited += 100;
      if (doneCount > before && waited > 1500) break;
      if (fatal) break;
    }
    // Let a late transcription land.
    for (let i = 0; i < 10; i++) {
      send({ type: "input_audio_buffer.append", audio: quiet });
      await sleep(100);
    }
    out.push({
      lang: u.lang,
      said: said.trim(),
      heard: heard.trim(),
      spoke: spokeAudio,
      peak,
      firstAudioMs: audioAt === null ? null : audioAt - endedAt,
      status: doneCount > before ? lastStatus : "no-response",
      usage: lastUsage
    });
    if (fatal) break;
  }
  ws.close();
  if (fatal) console.log(`  ${label}: ERROR ${fatal}`);
  return out;
}

/**
 * Did the table HEAR anything? Audio frames alone do not say: a leg told to
 * stay silent still returns a short run of frames, and what matters is
 * whether they carry sound. Words in the transcript, or a peak above the
 * noise floor.
 */
const AUDIBLE_PEAK = 0.02;
const audible = (t: TurnProbe) => t.said.length > 0 || t.peak >= AUDIBLE_PEAK;

function report(label: string, turns: TurnProbe[], expectSpeak: (lang: string) => boolean): void {
  let tally = emptyInterpreterTally("openai-realtime", MODEL, 0);
  console.log(`\n── ${label} ──`);
  let silentOk = 0;
  let silentWanted = 0;
  let spokeOk = 0;
  let spokeWanted = 0;
  for (const [i, t] of turns.entries()) {
    tally = addUsage(tally, t.usage);
    const want = expectSpeak(t.lang);
    if (want) {
      spokeWanted += 1;
      if (audible(t)) spokeOk += 1;
    } else {
      silentWanted += 1;
      if (!audible(t)) silentOk += 1;
    }
    const u = t.usage?.input_token_details;
    console.log(
      `  ${i + 1} [${t.lang}] ${want ? "SPEAK " : "SILENT"} → ${t.spoke ? "spoke " : "silent"} ` +
        `first_audio=${t.firstAudioMs ?? "-"}ms status=${t.status} ` +
        `in_audio=${u?.audio_tokens ?? 0} in_text=${u?.text_tokens ?? 0} cached=${u?.cached_tokens ?? 0} ` +
        `out_audio=${t.usage?.output_token_details?.audio_tokens ?? 0} out_text=${t.usage?.output_token_details?.text_tokens ?? 0}`
    );
    console.log(`      heard: ${t.heard || "—"}`);
    console.log(`      said : ${t.said || "—"}`);
  }
  console.log(
    `  spoke ${spokeOk}/${spokeWanted} · silent ${silentOk}/${silentWanted} · est $${estimateUsd(tally).toFixed(4)}`
  );
}

async function runTranslate(target: "en" | "es", utterances: (Utterance & { lang: string })[]): Promise<void> {
  const model = "gpt-realtime-translate";
  const ws = new WebSocket(`wss://api.openai.com/v1/realtime/translations?model=${model}`, {
    headers: { Authorization: `Bearer ${requireKey()}` }
  } as unknown as string[]);
  const types = new Map<string, number>();
  let outText = "";
  let inText = "";
  let audioBytes = 0;
  let outPeak = 0;
  let firstAudioAt: number | null = null;
  const errors: string[] = [];
  ws.onmessage = ({ data }) => {
    const ev = JSON.parse(String(data)) as Record<string, unknown>;
    const type = String(ev.type ?? "");
    types.set(type, (types.get(type) ?? 0) + 1);
    if (type === "session.output_transcript.delta" && typeof ev.delta === "string") outText += ev.delta;
    if (type === "session.input_transcript.delta" && typeof ev.delta === "string") inText += ev.delta;
    if (type === "session.output_audio.delta" && typeof ev.delta === "string") {
      audioBytes += Math.floor((ev.delta.length * 3) / 4);
      outPeak = Math.max(outPeak, peakOf(ev.delta));
      firstAudioAt ??= Date.now();
    }
    if (type === "error") errors.push(JSON.stringify(ev.error).slice(0, 300));
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("translate: socket error"));
  });
  const send = (o: unknown) => ws.send(JSON.stringify(o));
  const { model: _m, ...session } = buildOpenAITranslateSession({
    model,
    direction: { source: target === "es" ? "en" : "es", target },
    transcribeModel: "gpt-realtime-whisper"
  }) as { model?: string };
  send({ type: "session.update", session });
  await sleep(800);

  console.log(`\n── gpt-realtime-translate → ${target} ──`);
  const chunk = (SAMPLE_RATE * BYTES_PER_SAMPLE) / 5; // 200 ms, as the guide recommends
  for (const u of utterances) {
    outText = "";
    inText = "";
    audioBytes = 0;
    outPeak = 0;
    firstAudioAt = null;
    const startedAt = Date.now();
    const withTail = Buffer.concat([u.pcm, silence(6000)]);
    for (let off = 0; off < withTail.length; off += chunk) {
      send({ type: "session.input_audio_buffer.append", audio: withTail.subarray(off, off + chunk).toString("base64") });
      await sleep(200);
    }
    const outSeconds = audioBytes / (SAMPLE_RATE * BYTES_PER_SAMPLE);
    console.log(
      `  [${u.lang}→${target}] ${u.lang === target ? "SAME LANGUAGE" : "translate    "} ` +
        `out_audio=${outSeconds.toFixed(1)}s peak=${outPeak.toFixed(3)} first_audio=${firstAudioAt === null ? "-" : firstAudioAt - startedAt}ms`
    );
    console.log(`      heard: ${inText.trim() || "—"}`);
    console.log(`      said : ${outText.trim() || "—"}`);
  }
  send({ type: "session.close" });
  await sleep(1500);
  ws.close();
  console.log(`  events: ${[...types.entries()].map(([k, v]) => `${k}×${v}`).join(" ")}`);
  if (errors.length) console.log(`  errors: ${errors.join(" | ")}`);
}

describe("interpreter mode — live probe", () => {
  it("measures the engines", async () => {
    const utterances: (Utterance & { lang: string })[] = [];
    for (const line of SCRIPT) {
      // Two different stock voices, so the rig's "two people" do not sound alike.
      const u = await synthesize(line.text, line.lang === "en" ? "ash" : "coral");
      utterances.push({ ...u, lang: line.lang });
    }
    const pair = { a: "en", b: "es" };
    const common = { model: MODEL, transcribeModel: "gpt-transcribe", pair };

    if (WHICH === "all" || WHICH === "legs") {
      const enEs = buildOpenAIRealtimeSession({
        ...common,
        voice: "cedar",
        instructions: buildLegBriefing({ direction: { source: "en", target: "es" }, context: PROBE_CONTEXT })
      });
      report(`leg en→es (${MODEL}, cedar)`, await runRealtimeLeg("en→es", enEs, utterances), (l) => l === "en");
      const esEn = buildOpenAIRealtimeSession({
        ...common,
        voice: "marin",
        instructions: buildLegBriefing({ direction: { source: "es", target: "en" }, context: PROBE_CONTEXT })
      });
      report(`leg es→en (${MODEL}, marin)`, await runRealtimeLeg("es→en", esEn, utterances), (l) => l === "es");
    }

    if (WHICH === "all" || WHICH === "single") {
      const both = buildOpenAIRealtimeSession({
        ...common,
        voice: "marin",
        instructions: buildInterpreterBriefing({ pair, context: PROBE_CONTEXT })
      });
      report(`single session, both ways (${MODEL})`, await runRealtimeLeg("single", both, utterances), () => true);
    }

    if (WHICH === "all" || WHICH === "translate") {
      await runTranslate("es", utterances.slice(0, 2));
      await runTranslate("en", utterances.slice(0, 2));
    }
  });
});
