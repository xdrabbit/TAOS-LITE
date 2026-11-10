// Mediator v2, against the real flagship. NOT a test: `npm test` never runs it
// (vitest.measure.config.ts), it needs OPENAI_API_KEY and it spends real money
// — about 40 cents for everything, less for one part.
//
//   OPENAI_API_KEY=… npx vitest run --config vitest.measure.config.ts \
//     tests/live-fire/mediator-v2.measure.ts
//
// What it answers, with the briefing, the session object and the cue frames
// the app actually sends (a rig must do what the client does):
//
//   intro    Cued with INTRO_TRIGGER, does the intro leg give the
//            introduction — both languages, each half behind its marker, so
//            the captions split it — and how many SECONDS is it? Is it given
//            once, and is the next thing said interpreted normally?
//   ledger   Deal: after a scripted negotiation with two explicit agreements
//            and three traps (a counter-offer, a "maybe", an "I understand"),
//            what does "mediator, where are we?" read back? And on an empty
//            session? Per response: how much context was re-read, and how
//            much of it came from cache (the Deal cap is 10× the default).
//
// The sentences are the rig's own — nobody's conversation.
//
// Knobs:
//   MEDIATOR_PROBE=intro|ledger|empty|all   (default all)
//   MEDIATOR_PROBE_STYLES=mediator,deal     (intro only: which styles, and skip the rest)
//   MEDIATOR_PROBE_MODEL=gpt-realtime-2.1

import { describe, it } from "vitest";
import { buildLegBriefing } from "@/lib/interpreter/briefing";
import { buildOpenAIRealtimeSession, interpreterContextTokenLimit } from "@/lib/interpreter/session";
import { addUsage, emptyInterpreterTally, estimateUsd } from "@/lib/interpreter/cost";
import { introCueFrames, splitMediatorNotes, type MediatorStyle } from "@/lib/interpreter/mediator";
import type { RealtimeUsage } from "@/lib/call/cost";
import { requireKey, SAMPLE_RATE, synthesize } from "./realtime-driver";

const MODEL = process.env.MEDIATOR_PROBE_MODEL?.trim() || "gpt-realtime-2.1";
const WHICH = (process.env.MEDIATOR_PROBE ?? "all").trim().toLowerCase();
const PAIR = { a: "en", b: "es" };
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const QUIET = Buffer.alloc(BYTES_PER_SECOND / 10).toString("base64");

interface Reply {
  /** First loud sample to last loud sample — what a listener calls its length. */
  voicedSeconds: number;
  /** Silence inside that span (the pause between the two languages). */
  pauseSeconds: number;
  said: string;
  heard: string;
  audioSeconds: number;
  status: string;
  usage: RealtimeUsage | null;
}

/** The audible span of a reply, in 20 ms frames above a low noise floor. */
function voiced(pcm: Buffer): { voicedSeconds: number; pauseSeconds: number } {
  const frame = (SAMPLE_RATE / 50) * 2;
  const loud: boolean[] = [];
  for (let off = 0; off + frame <= pcm.length; off += frame) {
    let peak = 0;
    for (let i = off; i < off + frame; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
    loud.push(peak / 0x8000 >= 0.02);
  }
  const first = loud.indexOf(true);
  const last = loud.lastIndexOf(true);
  if (first < 0) return { voicedSeconds: 0, pauseSeconds: 0 };
  const quiet = loud.slice(first, last + 1).filter((l) => !l).length;
  return { voicedSeconds: (last - first + 1) / 50, pauseSeconds: quiet / 50 };
}

let spent = emptyInterpreterTally("openai-realtime", MODEL, 0);

/** One real leg. `cue()` sends the intro frames; `say()` plays an utterance. */
async function openLeg(direction: { source: string; target: string }, style: MediatorStyle, intro: boolean, voice: string) {
  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`, {
    headers: { Authorization: `Bearer ${requireKey()}` }
  } as unknown as string[]);
  let said = "";
  let heard = "";
  let audioBytes = 0;
  let pcmOut: Buffer[] = [];
  let done = 0;
  let status = "";
  let usage: RealtimeUsage | null = null;
  const errors: string[] = [];
  const phases: string[] = [];
  const seen = new Set<string>();
  ws.onmessage = ({ data }) => {
    const ev = JSON.parse(String(data)) as Record<string, unknown>;
    const type = String(ev.type ?? "");
    seen.add(type);
    if (type === "response.output_audio.delta" && typeof ev.delta === "string") {
      const chunk = Buffer.from(ev.delta, "base64");
      audioBytes += chunk.length;
      pcmOut.push(chunk);
    }
    if (type === "response.output_audio_transcript.delta" && typeof ev.delta === "string") said += ev.delta;
    if (type === "conversation.item.input_audio_transcription.completed" && typeof ev.transcript === "string") {
      heard += ev.transcript;
    }
    // Does a spoken PREAMBLE announce itself? (docs: output[].phase = "commentary")
    if (type === "response.output_item.added" || type === "response.output_item.done") {
      const item = (ev.item ?? {}) as { id?: string; phase?: string; type?: string };
      if (type.endsWith("added")) phases.push(`added:${item.type ?? "?"}:${item.phase ?? "-"}`);
    }
    if (type === "response.done") {
      const out = ((ev.response ?? {}) as { output?: { phase?: string; type?: string }[] }).output ?? [];
      if (out.length) phases.push(`done:[${out.map((o) => `${o.type ?? "?"}:${o.phase ?? "-"}`).join(",")}]`);
      const r = (ev.response ?? {}) as { status?: string; usage?: RealtimeUsage };
      status = r.status ?? "";
      usage = r.usage ?? null;
      spent = addUsage(spent, usage);
      done += 1;
    }
    if (type === "error") errors.push(JSON.stringify(ev.error).slice(0, 300));
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("socket error"));
  });
  const send = (o: unknown) => ws.send(JSON.stringify(o));
  const session = buildOpenAIRealtimeSession({
    model: MODEL,
    voice,
    transcribeModel: "gpt-transcribe",
    pair: PAIR,
    instructions: buildLegBriefing({ direction, style, intro }),
    contextTokenLimit: interpreterContextTokenLimit(style)
  }) as { model?: string; audio?: { input?: Record<string, unknown> } & Record<string, unknown> };
  const { model: _model, ...rest } = session;
  void _model;
  send({
    type: "session.update",
    session: {
      ...rest,
      audio: { ...rest.audio, input: { ...rest.audio?.input, format: { type: "audio/pcm", rate: SAMPLE_RATE } } }
    }
  });
  for (let i = 0; i < 50 && !seen.has("session.updated") && !errors.length; i++) await sleep(100);
  if (errors.length) throw new Error(`session rejected — ${errors[0]}`);

  const reset = () => {
    said = "";
    heard = "";
    audioBytes = 0;
    pcmOut = [];
    status = "";
    usage = null;
  };
  /** Feed silence until a response finishes (or `maxMs`), then a little more. */
  const settle = async (before: number, maxMs: number): Promise<Reply> => {
    let waited = 0;
    while (waited < maxMs) {
      send({ type: "input_audio_buffer.append", audio: QUIET });
      await sleep(100);
      waited += 100;
      if (done > before && waited > 1500) break;
    }
    for (let i = 0; i < 10; i++) {
      send({ type: "input_audio_buffer.append", audio: QUIET });
      await sleep(100);
    }
    return {
      ...voiced(Buffer.concat(pcmOut)),
      said: said.trim(),
      heard: heard.trim(),
      audioSeconds: audioBytes / BYTES_PER_SECOND,
      status: done > before ? status : "no-response",
      usage
    };
  };
  return {
    errors,
    phases,
    cue: async (): Promise<Reply> => {
      reset();
      const before = done;
      for (const frame of introCueFrames("openai-webrtc", "")) send(frame);
      return settle(before, 30_000);
    },
    say: async (pcm: Buffer): Promise<Reply> => {
      reset();
      const before = done;
      const chunk = BYTES_PER_SECOND / 10;
      for (let off = 0; off < pcm.length; off += chunk) {
        send({ type: "input_audio_buffer.append", audio: pcm.subarray(off, off + chunk).toString("base64") });
        await sleep(100);
      }
      return settle(before, 40_000);
    },
    close: () => ws.close()
  };
}

function show(label: string, r: Reply): void {
  const u = r.usage?.input_token_details;
  console.log(
    `  ${label} status=${r.status} audio=${r.audioSeconds.toFixed(1)}s ` +
      `in_audio=${u?.audio_tokens ?? 0} in_text=${u?.text_tokens ?? 0} cached=${u?.cached_tokens ?? 0} ` +
      `out_audio=${r.usage?.output_token_details?.audio_tokens ?? 0}`
  );
  if (r.heard) console.log(`      heard: ${r.heard}`);
  console.log(`      said : ${r.said || "—"}`);
  const split = splitMediatorNotes(r.said, ["en", "es"]);
  if (split.notes.length) {
    console.log(`      → interpretation: ${split.interpretation || "—"}`);
    for (const n of split.notes) console.log(`      → note[${n.lang}]: ${n.text}`);
  }
}

const NEGOTIATION: { lang: "en" | "es"; text: string }[] = [
  { lang: "en", text: "I'd like to rent the apartment starting December first." },
  { lang: "es", text: "Sí, de acuerdo. El primero de diciembre está bien." },
  { lang: "es", text: "La renta es de novecientos dólares al mes." },
  { lang: "en", text: "Could you do eight hundred?" },
  { lang: "es", text: "Mmm, tal vez. Déjeme pensarlo." },
  { lang: "en", text: "Okay. And I will pay a deposit of one month's rent." },
  { lang: "es", text: "De acuerdo, un mes de depósito." },
  { lang: "es", text: "Y no se permiten mascotas." },
  { lang: "en", text: "I understand." }
];

describe("mediator v2 — live probe", () => {
  it("measures the introduction and the terms ledger", async () => {
    if (WHICH === "all" || WHICH === "intro") {
      const hello = await synthesize("Thank you. Shall we start with the schedule?", "ash");
      const styles = (process.env.MEDIATOR_PROBE_STYLES ?? "mediator,entendimiento,deal").split(",") as MediatorStyle[];
      for (const style of styles) {
        console.log(`\n── intro · ${style} · leg es→en (the intro leg) ──`);
        const leg = await openLeg({ source: "es", target: "en" }, style, true, "marin");
        const intro = await leg.cue();
        show("intro ", intro);
        const notes = splitMediatorNotes(intro.said, ["en", "es"]).notes.map((n) => n.lang);
        console.log(
          `      halves: ${notes.join(",") || "none"} · stream ${intro.audioSeconds.toFixed(1)} s · ` +
            `HEARD ${intro.voicedSeconds.toFixed(1)} s (of which pauses ${intro.pauseSeconds.toFixed(1)} s)`
        );
        if (style === "mediator") {
          // English is this leg's OUTPUT language: it must stay quiet, and
          // must not introduce itself again.
          show("after (en → expect silence)", await leg.say(hello.pcm));
        }
        if (leg.errors.length) console.log(`  errors: ${leg.errors.join(" | ")}`);
        leg.close();
      }
      // The OTHER leg is never cued and has no introduction in its briefing:
      // its first turn must be a plain interpretation.
      if (process.env.MEDIATOR_PROBE_STYLES) return;
      console.log(`\n── intro · mediator · leg en→es (NOT the intro leg, never cued) ──`);
      const other = await openLeg({ source: "en", target: "es" }, "mediator", false, "cedar");
      show("first turn", await other.say(hello.pcm));
      other.close();
      console.log(`  spend so far: $${estimateUsd(spent).toFixed(4)}`);
    }

    if (WHICH === "all" || WHICH === "empty") {
      console.log(`\n── ledger · empty session · leg en→es ──`);
      const ask = await synthesize("Mediator, where are we?", "ash");
      const leg = await openLeg({ source: "en", target: "es" }, "deal", false, "cedar");
      show("where are we?", await leg.say(ask.pcm));
      console.log(`      output items: ${leg.phases.join(" ")}`);
      leg.close();
      console.log(`  spend so far: $${estimateUsd(spent).toFixed(4)}`);
    }

    if (WHICH === "all" || WHICH === "ledger") {
      const lines: { lang: string; pcm: Buffer }[] = [];
      for (const line of NEGOTIATION) {
        lines.push({ lang: line.lang, pcm: (await synthesize(line.text, line.lang === "en" ? "ash" : "coral")).pcm });
      }
      const askEn = await synthesize("Mediator, where are we?", "ash");
      const askEs = await synthesize("Mediador, ¿dónde estamos?", "coral");
      for (const [direction, voice, ask] of [
        [{ source: "en", target: "es" }, "cedar", askEn],
        [{ source: "es", target: "en" }, "marin", askEs]
      ] as const) {
        console.log(`\n── ledger · deal · leg ${direction.source}→${direction.target} · cap ${interpreterContextTokenLimit("deal")} ──`);
        console.log(`   expected read-back: (1) start December first, (2) one month's deposit — NOT the rent, NOT pets`);
        const leg = await openLeg(direction, "deal", false, voice);
        for (const [i, line] of lines.entries()) show(`${i + 1} [${line.lang}]`, await leg.say(line.pcm));
        show("where are we?", await leg.say(ask.pcm));
        if (leg.errors.length) console.log(`  errors: ${leg.errors.join(" | ")}`);
        leg.close();
        console.log(`  spend so far: $${estimateUsd(spent).toFixed(4)}`);
      }
    }
    console.log(`\nTOTAL estimated spend (realtime only; TTS for the rig's voices is under a cent): $${estimateUsd(spent).toFixed(4)}`);
  }, 900_000);
});
