// The two socket engines of Interpreter mode — Grok Voice and ElevenLabs
// Realtime — against the real providers. NOT a test: `npm test` never runs it
// (vitest.measure.config.ts), it needs keys and it spends real money (a few
// cents a run).
//
//   set -a; . ./.env.local; set +a
//   INTERPRETER_WS_ENGINE=grok npx vitest run --config vitest.measure.config.ts \
//     tests/live-fire/interpreter-engines.measure.ts
//
// Written after Tom's table test of 2026-11-09 (Grok: one fragment, then
// silence; ElevenLabs: right, but slow). A rig must do what the client does,
// so everything that can be shared with the shipped code IS the shipped code:
//
//   · the plan and both briefings        lib/interpreter/plan.ts
//   · the mint body and session.update   lib/interpreter/session.ts
//   · the browser's handshake order      session.created → session.update →
//                                        session.updated → audio (client.ts)
//   · the browser's authentication       the secret as a WebSocket subprotocol
//   · what the events MEAN               createRealtimeReader (legEvents.ts)
//   · the speaker gate                   createAudioGate (audioGate.ts)
//   · the diagnostics                    createSessionTimeline (timeline.ts)
//
// What is NOT the phone: the microphone. The "table" here is a synthesised
// script streamed to BOTH legs at once in 100 ms chunks at wall-clock pace,
// with room tone between sentences — the rig's own sentences, nobody's
// conversation. There is no loudspeaker, so no echo: INTERPRETER_WS_ECHO=1
// mixes each leg's own output back into what both legs hear, which is the
// worst case a phone's echo canceller is there to prevent.
//
// Knobs:
//   INTERPRETER_WS_ENGINE=grok|elevenlabs|both      (default both)
//   INTERPRETER_WS_LEGS=1|2                         (default 2, as shipped)
//   INTERPRETER_WS_PEER_CLEAR=off                   ElevenLabs without the
//                                                   cross-leg clear (the
//                                                   "before" of the fix)
//   INTERPRETER_WS_ECHO=1                           feed the output back in
//   INTERPRETER_WS_ECHO_GAIN=0.3                    how loud the echo is
//   INTERPRETER_WS_ROWS=1                           print every timeline row
//   plus every TAOS_INTERPRETER_* knob the mint route reads.
//
// What it prints: the events that mark a turn as they happen, each leg's
// [taos-interpreter-diag] line (the same one the phone posts), and — the
// number the events alone cannot give — the time from each speaker's last
// audible sample to the first audio frame of the leg that answers.
//
// 2026-11-09, ElevenLabs (xAI could not be run: no key on the build machine):
// lib/interpreter/session.ts carries the latency and two-leg tables this
// produced; lib/interpreter/cost.ts the billing check.

import { describe, it } from "vitest";
import { createAudioGate } from "@/lib/interpreter/audioGate";
import { engineIsHalfDuplex, gateFollows, speakerActionFor } from "@/lib/interpreter/halfDuplex";
import type { CaptionUpdate } from "@/lib/interpreter/captions";
import { engineApiKey, grokReasoning, type InterpreterEngine } from "@/lib/interpreter/engine";
import { createPeerHeard, createRealtimeReader, type LegSink } from "@/lib/interpreter/legEvents";
import { buildInterpreterPlan, type LegPlan } from "@/lib/interpreter/plan";
import {
  buildElevenLabsRealtimeSession,
  buildGrokSecretSession,
  buildGrokSessionUpdate,
  INTERPRETER_SECRET_TTL_SECONDS,
  INTERPRETER_WS_INPUT_RATE,
  interpreterEagerness
} from "@/lib/interpreter/session";
import {
  createSessionTimeline,
  summarizeLegDigest,
  timelineLogLine,
  type LegTimeline
} from "@/lib/interpreter/timeline";
import { SAMPLE_RATE, synthesize } from "./realtime-driver";

const WHICH = (process.env.INTERPRETER_WS_ENGINE ?? "both").trim().toLowerCase();
const ECHO = process.env.INTERPRETER_WS_ECHO === "1";
const ECHO_GAIN = Number(process.env.INTERPRETER_WS_ECHO_GAIN ?? "0.3") || 0.3;
const PRINT_ROWS = process.env.INTERPRETER_WS_ROWS === "1";
/** `off` = do not clear the other legs' input when a leg takes a turn. */
const PEER_CLEAR = (process.env.INTERPRETER_WS_PEER_CLEAR ?? "").trim().toLowerCase() !== "off";

/** Audio frames per reply: arrival time and decoded size. Never the audio. */
const WIRE = new Map<string, { t: number; bytes: number }[]>();

const XAI_BASE = "https://api.x.ai/v1";
const XAI_WS_URL = "wss://api.x.ai/v1/realtime";
const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";
const ELEVENLABS_WS_URL = "wss://api.elevenlabs.io/v1/convai/realtime";

const PROBE_CONTEXT = "The English speaker is Sam. The Spanish speaker is Ana.";

/**
 * The table. `gapMs` is the quiet AFTER the line. The first three lines are
 * one person thinking out loud with short pauses — what Tom was doing when
 * Grok stalled ("…or if it's just taking a long time").
 */
const SCRIPT: { lang: "en" | "es"; text: string; gapMs: number }[] = [
  { lang: "en", text: "Okay, I am testing the interpreter now.", gapMs: 1200 },
  { lang: "en", text: "I can't tell if it heard me.", gapMs: 900 },
  { lang: "en", text: "Or if it's simply taking a long time.", gapMs: 7000 },
  { lang: "es", text: "Te escucho bien. ¿Quieres que pidamos la cena ahora?", gapMs: 7000 },
  { lang: "en", text: "Yes, let's order. What do you feel like eating tonight?", gapMs: 7000 },
  { lang: "es", text: "Me gustaría algo ligero, quizá una sopa.", gapMs: 8000 }
];

/** Bytes into a clip at which its last audible sample sits (TTS pads the end). */
function speechEndBytes(pcm: Buffer): number {
  for (let i = pcm.length - 2; i >= 0; i -= 2) {
    if (Math.abs(pcm.readInt16LE(i)) > 700) return i + 2;
  }
  return pcm.length;
}

const CLEAR_INPUT_FRAME = JSON.stringify({ type: "input_audio_buffer.clear" });
const CHUNK_MS = 100;
const CHUNK_BYTES = (SAMPLE_RATE * 2 * CHUNK_MS) / 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Room tone: a real microphone never sends digital zero. */
function roomTone(bytes: number): Buffer {
  const out = Buffer.alloc(bytes);
  for (let i = 0; i + 1 < bytes; i += 2) out.writeInt16LE(Math.round((Math.random() - 0.5) * 60), i);
  return out;
}

function mix(base: Buffer, add: Buffer, gain: number): Buffer {
  const out = Buffer.from(base);
  const n = Math.min(base.length, add.length);
  for (let i = 0; i + 1 < n; i += 2) {
    const v = base.readInt16LE(i) + Math.round(add.readInt16LE(i) * gain);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i);
  }
  return out;
}

interface LegRun {
  index: number;
  plan: LegPlan;
  ws: WebSocket;
  captions: Map<string, CaptionUpdate>;
  /** Bytes that reached the "speaker" (through the gate). */
  played: number;
  /** Output waiting to be echoed back into the room. */
  echo: Buffer[];
  keysByType: Map<string, string>;
  config: Record<string, unknown>;
  closed: string | null;
  tl: LegTimeline;
  /** Wall-clock ms of every response's FIRST audio frame. */
  firstAudioAt: number[];
  /** What each response said, raw — the rig's own sentences, so printable. */
  saidRaw: Map<string, string>;
}

function secretFrom(payload: Record<string, unknown> | null): string {
  const nested = (payload?.client_secret ?? null) as Record<string, unknown> | null;
  return (
    (typeof payload?.value === "string" && payload.value) ||
    (nested && typeof nested.value === "string" && nested.value) ||
    ""
  );
}

/** The part of a session object that is configuration, not briefing. */
function configOf(session: unknown): Record<string, unknown> {
  const s = (session ?? {}) as Record<string, unknown>;
  const { instructions, ...rest } = s;
  return { ...rest, instructions_chars: typeof instructions === "string" ? instructions.length : null };
}

async function mint(engine: InterpreterEngine, model: string, leg: LegPlan): Promise<{
  wsUrl: string;
  protocols: string[];
  sessionUpdate: Record<string, unknown> | null;
}> {
  const apiKey = engineApiKey(engine);
  if (!apiKey) throw new Error(`No key for ${engine} in this environment.`);
  if (engine === "grok-voice") {
    const reasoning = grokReasoning();
    const res = await fetch(`${XAI_BASE}/realtime/client_secrets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        expires_after: { seconds: INTERPRETER_SECRET_TTL_SECONDS },
        session: buildGrokSecretSession({ model, reasoning })
      })
    });
    const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const secret = secretFrom(payload);
    if (!res.ok || !secret) throw new Error(`xAI mint ${res.status}`);
    return {
      wsUrl: `${XAI_WS_URL}?model=${encodeURIComponent(model)}&reasoning.effort=${reasoning}`,
      protocols: [`xai-client-secret.${secret}`],
      sessionUpdate: buildGrokSessionUpdate({ instructions: leg.instructions ?? "", voice: leg.voice ?? "", reasoning })
    };
  }
  const res = await fetch(`${ELEVENLABS_BASE}/convai/realtime/client_secrets`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      expires_after: { anchor: "created_at", seconds: INTERPRETER_SECRET_TTL_SECONDS },
      session: buildElevenLabsRealtimeSession({
        model,
        instructions: leg.instructions ?? "",
        voice: leg.voice ?? "",
        language: leg.direction?.source ?? null,
        maxSeconds: 600,
        eagerness: interpreterEagerness()
      })
    })
  });
  const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const secret = secretFrom(payload);
  if (!res.ok || !secret) {
    const detail = JSON.stringify(payload ?? {}).slice(0, 300);
    throw new Error(`ElevenLabs mint ${res.status} ${detail}`);
  }
  return {
    wsUrl: ELEVENLABS_WS_URL,
    protocols: ["realtime", `openai-insecure-api-key.${secret}`],
    sessionUpdate: null
  };
}

async function runEngine(engine: InterpreterEngine): Promise<void> {
  const env = { ...process.env, TAOS_INTERPRETER_LEGS: process.env.INTERPRETER_WS_LEGS ?? "2" };
  const plan = buildInterpreterPlan({ engine, pair: { a: "en", b: "es" }, context: PROBE_CONTEXT, env });
  const gated = plan.legs.length > 1;
  const HALF_DUPLEX = engineIsHalfDuplex(engine);
  console.log(`\n══ ${engine} · ${plan.model} · legs=${plan.legs.length} · echo=${ECHO ? ECHO_GAIN : "off"} ══`);

  const clips = await Promise.all(SCRIPT.map((line) => synthesize(line.text, line.lang === "en" ? "ash" : "coral")));
  const timeline = createSessionTimeline({ engine, model: plan.model });
  const peers = createPeerHeard();
  const t0 = Date.now();
  const at = () => `${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s`;

  const live: LegRun[] = [];
  const peersOf = () => live;
  const legs = await Promise.all(
    plan.legs.map(async (legPlan, index): Promise<LegRun> => {
      const ticket = await mint(engine, plan.model, legPlan);
      const tl = timeline.leg(index, {
        source: legPlan.direction?.source ?? null,
        target: legPlan.direction?.target ?? null,
        transport: "realtime-ws"
      });
      const run: LegRun = {
        index,
        plan: legPlan,
        ws: new WebSocket(ticket.wsUrl, ticket.protocols),
        captions: new Map(),
        played: 0,
        echo: [],
        keysByType: new Map(),
        config: {},
        closed: null,
        tl,
        firstAudioAt: [],
        saidRaw: new Map()
      };
      live.push(run);
      const gate = createAudioGate<Buffer>(
        {
          play: (bytes) => {
            run.played += bytes.length;
            if (ECHO) run.echo.push(bytes);
          },
          flush: () => {
            run.echo = [];
          }
        },
        gated,
        {
          onOpen: () => tl.note("gate-open"),
          onDropped: (bytes) => tl.note("held-dropped", { bytes })
        }
      );
      const sink: LegSink = {
        caption: (update) => {
          const fresh = !run.captions.has(update.id);
          run.captions.set(update.id, update);
          if (fresh || !update.live) {
            console.log(
              `${at()} leg${index} caption${update.live ? "" : " (final)"}: heard="${update.heard}" said="${update.said}"`
            );
          }
        },
        activity: () => {},
        usage: () => {},
        geminiUsage: () => {},
        transcribed: () => {},
        billed: (seconds) => console.log(`${at()} leg${index} billable_audio_seconds=${seconds}`),
        bargeIn: () => console.log(`${at()} leg${index} BARGE-IN`),
        gate: (open) => {
          if (gated && gateFollows(open, HALF_DUPLEX)) gate.setAudible(open);
        },
        flushAudio: gate.flush,
        responseSilent: () => {
          if (gated) gate.dropHeld();
        },
        error: (message) => console.log(`${at()} leg${index} ERROR ${message}`),
        closed: () => {},
        // What client.ts does (clearPeersOnTurn): ElevenLabs, two legs.
        tookTurn: () => {
          if (!PEER_CLEAR || engine !== "elevenlabs-realtime" || !gated) return;
          for (const other of peersOf()) {
            if (other.index === index || other.ws.readyState !== WebSocket.OPEN) continue;
            other.ws.send(CLEAR_INPUT_FRAME);
            other.tl.sent("input_audio_buffer.clear", CLEAR_INPUT_FRAME.length);
          }
        }
      };
      const reader = createRealtimeReader(
        { index, source: legPlan.direction?.source ?? null, target: legPlan.direction?.target ?? null },
        sink,
        { echoGuard: engine === "elevenlabs-realtime" && gated, peers }
      );

      const audioSeen = new Set<string>();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`leg${index}: no session in 15 s`)), 15_000);
        let updateSent = false;
        let ready = false;
        // Node's built-in WebSocket: the browser's API, as client.ts uses it.
        run.ws.onopen = () => tl.note("socket-open");
        run.ws.onclose = (ev) => {
          tl.note("socket-close", { reason: ev.code });
          run.closed = String(ev.code);
          if (!ready) reject(new Error(`leg${index}: closed ${ev.code} before ready`));
        };
        run.ws.onerror = () => console.log(`${at()} leg${index} socket error`);
        run.ws.onmessage = (ev) => {
          const raw = String(ev.data);
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            return;
          }
          const type = typeof msg.type === "string" ? msg.type : "";
          tl.recv(msg, raw.length);
          if (!run.keysByType.has(type)) run.keysByType.set(type, Object.keys(msg).sort().join(","));
          if (type === "session.created" || type === "session.updated") run.config = configOf(msg.session);
          if (type === "session.created" && !ready) {
            if (ticket.sessionUpdate) {
              const frame = JSON.stringify({ type: "session.update", session: ticket.sessionUpdate });
              run.ws.send(frame);
              tl.sent("session.update", frame.length);
              updateSent = true;
            } else {
              ready = true;
              clearTimeout(timer);
              resolve();
            }
            return;
          }
          if (type === "session.updated" && updateSent && !ready) {
            ready = true;
            clearTimeout(timer);
            resolve();
            return;
          }
          // Exactly what connectRealtimeWsLeg does with these. (The rig has no
          // loudspeaker, so the half-duplex MIC rule has nothing to silence
          // here — the browser check with the scripted provider covers that.)
          const action = speakerActionFor(msg, HALF_DUPLEX);
          if (action === "rearm") gate.rearm();
          else if (action === "cut") gate.flush();
          if (type === "response.output_audio.delta" || type === "response.audio.delta") {
            if (typeof msg.delta === "string" && msg.delta) gate.play(Buffer.from(msg.delta, "base64"));
            const rid = String(msg.response_id ?? "");
            // The WIRE, for the playback path: how big each frame is and when
            // it lands. Sizes and times — never the audio.
            if (typeof msg.delta === "string") {
              const wire = WIRE.get(`leg${index} ${rid.slice(-6)}`) ?? [];
              wire.push({ t: Date.now(), bytes: Buffer.from(msg.delta, "base64").length });
              WIRE.set(`leg${index} ${rid.slice(-6)}`, wire);
            }
            if (!audioSeen.has(rid)) {
              audioSeen.add(rid);
              run.firstAudioAt.push(Date.now());
            }
          }
          if (type === "response.output_audio_transcript.delta" || type === "response.audio_transcript.delta") {
            const rid = String(msg.response_id ?? "");
            run.saidRaw.set(rid, (run.saidRaw.get(rid) ?? "") + String(msg.delta ?? ""));
          }
          if (type === "conversation.item.input_audio_transcription.completed") {
            console.log(`${at()} leg${index} heard: "${String(msg.transcript ?? "")}"`);
          }
          if (
            type === "input_audio_buffer.speech_started" ||
            type === "input_audio_buffer.speech_stopped" ||
            type === "input_audio_buffer.committed" ||
            type === "response.created" ||
            type === "response.done" ||
            type === "error"
          ) {
            const response = (msg.response ?? {}) as Record<string, unknown>;
            const extra =
              type === "response.done"
                ? ` status=${String(response.status)} reason=${String((response.status_details as Record<string, unknown> | undefined)?.reason ?? "")}`
                : type === "error"
                  ? ` ${JSON.stringify(msg.error ?? msg).slice(0, 240)}`
                  : "";
            console.log(`${at()} leg${index} ${type}${extra}`);
          }
          reader.handle(msg);
        };
      });
      console.log(`${at()} leg${index} ready (${legPlan.direction?.source ?? "both"}→${legPlan.direction?.target ?? "both"})`);
      console.log(`         config: ${JSON.stringify(run.config).slice(0, 900)}`);
      return run;
    })
  );

  // ── The table: one microphone, every leg hears the same thing ────────────
  const sendChunk = (chunk: Buffer) => {
    let heard = chunk;
    if (ECHO) {
      for (const leg of legs) {
        // What that leg's speaker would be playing during this 100 ms.
        let need = chunk.length;
        const parts: Buffer[] = [];
        while (need > 0 && leg.echo.length) {
          const head = leg.echo[0];
          if (head.length <= need) {
            parts.push(head);
            need -= head.length;
            leg.echo.shift();
          } else {
            parts.push(head.subarray(0, need));
            leg.echo[0] = head.subarray(need);
            need = 0;
          }
        }
        if (parts.length) heard = mix(heard, Buffer.concat(parts), ECHO_GAIN);
      }
    }
    const frame = JSON.stringify({ type: "input_audio_buffer.append", audio: heard.toString("base64") });
    for (const leg of legs) {
      if (leg.ws.readyState !== WebSocket.OPEN) continue;
      leg.ws.send(frame);
      leg.tl.sent("input_audio_buffer.append", frame.length, heard.length);
    }
  };
  const stream = async (pcm: Buffer) => {
    let next = Date.now();
    for (let off = 0; off < pcm.length; off += CHUNK_BYTES) {
      let chunk = pcm.subarray(off, off + CHUNK_BYTES);
      if (chunk.length < CHUNK_BYTES) chunk = Buffer.concat([chunk, roomTone(CHUNK_BYTES - chunk.length)]);
      sendChunk(chunk);
      next += CHUNK_MS;
      await sleep(Math.max(0, next - Date.now()));
    }
  };

  const speechEnds: { line: number; at: number }[] = [];
  await stream(roomTone(SAMPLE_RATE * 2));
  for (let i = 0; i < SCRIPT.length; i++) {
    console.log(`${at()} ── ${SCRIPT[i].lang}: "${SCRIPT[i].text}" (${clips[i].seconds.toFixed(1)} s)`);
    const startedAt = Date.now();
    speechEnds.push({ line: i, at: startedAt + (speechEndBytes(clips[i].pcm) / (SAMPLE_RATE * 2)) * 1000 });
    await stream(clips[i].pcm);
    console.log(`${at()} ── (quiet ${SCRIPT[i].gapMs} ms)`);
    await stream(roomTone(Math.round((SAMPLE_RATE * 2 * SCRIPT[i].gapMs) / 1000 / 2) * 2));
  }
  for (const leg of legs) leg.ws.close();
  await sleep(300);

  // ── What happened ────────────────────────────────────────────────────────
  const exported = timeline.export();
  if (PRINT_ROWS) {
    for (const row of exported.rows) {
      const { t, t2, leg, dir, type, ...rest } = row;
      console.log(
        `${(t / 1000).toFixed(2).padStart(7)} ${t2 ? `→${(t2 / 1000).toFixed(2)}` : "       "} leg${leg} ${dir.padEnd(4)} ${type} ${JSON.stringify(rest)}`
      );
    }
  }
  for (const leg of legs) {
    console.log(`\nleg${leg.index} event shapes:`);
    for (const [type, keys] of leg.keysByType) console.log(`  ${type}: ${keys}`);
    console.log(`leg${leg.index} played=${leg.played} bytes (${(leg.played / (SAMPLE_RATE * 2)).toFixed(1)} s) closed=${leg.closed}`);
  }
  for (const digest of exported.digest) {
    console.log(timelineLogLine(engine, summarizeLegDigest(digest)));
    console.log(`  counts: ${JSON.stringify(digest.counts)}`);
    console.log(`  turn→audio ms: ${JSON.stringify(digest.turnToAudioMs)}  created→audio ms: ${JSON.stringify(digest.firstAudioMs)}`);
  }
  // ── The wire, as a PLAYER sees it (fix/interpreter-pcm-playback) ────────
  // Per reply: how many audio frames, their sizes, whether any is an ODD
  // number of bytes (half a sample), and how fast they land against the
  // audio's own length (pace 1.0 = real time; 20 = a burst).
  console.log("\naudio frames per reply (sizes and times only):");
  for (const [key, frames] of WIRE) {
    const bytes = frames.reduce((n, f) => n + f.bytes, 0);
    const seconds = bytes / (SAMPLE_RATE * 2);
    const span = (frames[frames.length - 1].t - frames[0].t) / 1000;
    const sizes = new Map<number, number>();
    for (const f of frames) sizes.set(f.bytes, (sizes.get(f.bytes) ?? 0) + 1);
    const gaps = frames.slice(1).map((f, i) => f.t - frames[i].t);
    const top = [...sizes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([b, n]) => `${b}×${n}`);
    console.log(
      `  ${key}: frames=${frames.length} audio=${seconds.toFixed(2)}s landed_in=${span.toFixed(2)}s ` +
        `pace=${span > 0 ? (seconds / span).toFixed(1) : "burst"} odd_frames=${frames.filter((f) => f.bytes % 2).length} ` +
        `total_odd=${bytes % 2} max_gap_ms=${gaps.length ? Math.max(...gaps) : 0} sizes=[${top.join(" ")}]${sizes.size > 6 ? ` (+${sizes.size - 6} more)` : ""}`
    );
  }

  // THE latency number: from the speaker's last audible sample to the first
  // audio frame of whichever leg answers. (A cascade can emit speech_stopped,
  // committed, response.created and the first frame in the same millisecond,
  // so the events alone say nothing about the wait.)
  console.log("\nspeech end → first audio:");
  for (const end of speechEnds) {
    const next = speechEnds.find((e) => e.line === end.line + 1)?.at ?? Infinity;
    const want = SCRIPT[end.line].lang === "en" ? "es" : "en";
    for (const leg of legs) {
      const first = leg.firstAudioAt.find((t) => t >= end.at - 300 && t < next);
      const mark = (leg.plan.direction?.target ?? want) === want ? "" : "  (the QUIET leg)";
      console.log(
        `  line ${end.line + 1} [${SCRIPT[end.line].lang}] leg${leg.index}: ${first === undefined ? "—" : `${Math.round(first - end.at)} ms`}${mark}`
      );
    }
  }
  for (const leg of legs) {
    for (const [, said] of leg.saidRaw) console.log(`  leg${leg.index} raw said: "${said}"`);
  }

  const finals = legs.flatMap((leg) => [...leg.captions.values()].map((c) => ({ leg: leg.index, ...c })));
  console.log(`\ncaptions: ${finals.length} for ${SCRIPT.length} lines`);
  for (const c of finals.sort((a, b) => a.at - b.at)) {
    console.log(`  leg${c.leg} ${c.source}→${c.target}  heard="${c.heard}"  said="${c.said}"`);
  }
}

describe("interpreter socket engines (live)", () => {
  it.runIf(WHICH === "grok" || WHICH === "both")("grok-voice", async () => {
    await runEngine("grok-voice");
  });
  it.runIf(WHICH === "elevenlabs" || WHICH === "both")("elevenlabs-realtime", async () => {
    await runEngine("elevenlabs-realtime");
  });
});
