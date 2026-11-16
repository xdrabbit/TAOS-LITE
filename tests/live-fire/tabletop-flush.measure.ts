// Live-fire probe for the /tabletop end-of-turn flush (Tom + Liz, 2026-11-15:
// "it holds on like it's holding its breath, and when it holds too long it
// passes out and we don't get the translation").
//
// It is not a test — it costs real money (cents) and needs OPENAI_API_KEY:
//
//   OPENAI_API_KEY=… npx vitest run --config vitest.measure.config.ts tests/live-fire/tabletop-flush.measure.ts
//
// What only the real API can answer, and the docs do not:
//   1. Soft speech under the shipped VAD (threshold 0.6): does server VAD ever
//      commit it? If not, is the audio still in the input buffer at turn end?
//   2. `input_audio_buffer.commit` while server_vad is ON: accepted, or an
//      error? Does it create a response by itself (`create_response: true`)?
//   3. The same with VAD switched off first — the path the guide documents.
//   4. One long, unbroken segment: how long after the voice stops does the
//      translation finish, and is it whole (max_output_tokens, context cap)?
//   5. A turn nobody spoke in: does a flush make the model invent something?
//
// Cases, comma-separated in FLUSH_PROBE_CASES (default: the fix itself):
//   soft-vad-on, soft-vad-off   speech at FLUSH_PROBE_GAIN, then a manual commit
//   silence, noise              5 s nobody spoke in, then a manual commit
//   long                        38 s with its natural pauses
//   seg-<s>[-<cap|off>][-rescue]  ONE unbroken segment of <s> seconds
//   steady-<s>[-<cap>]          four unbroken <s>-second segments in a row
//   forced-<s>                  unbroken speech, committed by hand every <s> s
//   overlap                     a short phrase right behind a long one
//   open                        the audio just stops, mid-voice; manual commit
//   ctl-<cap>[-nohint], ctl-open   lib/tabletop/turnFlush.ts ITSELF on the wire
//
// What it found, 2026-11-15 (gpt-realtime, shipped session, cap 100):
//   - seg-5/7/9 read (56/76/96 audio tokens); seg-12, seg-25: audio_tokens 0
//     and an invented sentence. seg-25-400 and seg-25-off: whole, < 2 s.
//   - steady-4 and steady-6 read every time; steady-7 reads the first and
//     gets audio_tokens 0 on the other three.
//   - silence/noise/soft: audio VAD has not called speech is NOT in the
//     buffer — "buffer only has 0.00ms of audio". Nothing to flush.
//   - open: manual commit with server_vad on → committed in ~55 ms, no
//     response of its own; response.create → a faithful translation.
//   - ctl-100: 31 s unbroken → 6 segments, audio_in 56,56,55,56,54,30, 0 dropped.
//
// The session is the shipped builder's, and each case sends the session.update
// the client's beginTurn sends (the realtime-driver.ts lesson). Prints event
// TYPES, timings, token counts and the rig's own synthesized sentences —
// nobody's conversation.
import { describe, expect, it } from "vitest";
import { requireKey, SAMPLE_RATE, synthesize } from "./realtime-driver";
import { buildTabletopSession, tabletopMaxSegmentMs } from "@/lib/tabletop/session";
import { buildTurnInstructions, withContinuation } from "@/lib/tabletop/instructions";
import { createTurnFlush } from "@/lib/tabletop/turnFlush";

const DIRECTION = { source: "es", target: "en" };
const MODEL = process.env.OPENAI_TABLETOP_REALTIME_MODEL?.trim() || "gpt-realtime";
const CASES = (process.env.FLUSH_PROBE_CASES ?? "ctl-100,ctl-open,steady-7")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SOFT_GAIN = Number(process.env.FLUSH_PROBE_GAIN ?? 0.03);

const SHORT =
  "Ayer fui al mercado con mi hermana y compramos tomates, cebollas y un poco de queso fresco para la cena de esta noche.";
const LONG =
  "Te cuento lo que pasó el fin de semana. Salimos temprano hacia la montaña porque queríamos llegar antes del mediodía, " +
  "pero a medio camino se nos ponchó una llanta y tuvimos que parar en un pueblito que ninguno de nosotros conocía. " +
  "El señor del taller fue muy amable, nos invitó un café mientras arreglaba la llanta y nos recomendó un restaurante " +
  "donde preparan el mejor mole de toda la región. Así que al final no llegamos a la montaña, pero comimos delicioso, " +
  "caminamos por la plaza, compramos pan dulce y regresamos a casa ya de noche, cansados pero muy contentos.";

interface Ev {
  t: number;
  type: string;
  ev: Record<string, unknown>;
}

async function openSession(sessionPatch: Record<string, unknown> = {}) {
  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`, {
    headers: { Authorization: `Bearer ${requireKey()}` }
  } as unknown as string[]);
  const events: Ev[] = [];
  const t0 = performance.now();
  ws.onmessage = ({ data }) => {
    try {
      const ev = JSON.parse(String(data)) as Record<string, unknown>;
      events.push({ t: performance.now() - t0, type: String(ev.type ?? ""), ev });
    } catch {
      /* not json */
    }
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("ws error"));
  });
  const send = (o: unknown) => ws.send(JSON.stringify(o));
  const now = () => performance.now() - t0;
  const waitFor = async (pred: (e: Ev) => boolean, ms: number, from = 0): Promise<Ev | null> => {
    const until = performance.now() + ms;
    while (performance.now() < until) {
      const hit = events.find((e) => e.t >= from && pred(e));
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 25));
    }
    return null;
  };
  await waitFor((e) => e.type === "session.created", 15_000);
  const built = buildTabletopSession({
    direction: DIRECTION,
    model: MODEL,
    transcribeModel: "gpt-4o-mini-transcribe"
  }) as { model?: string; audio: { input: Record<string, unknown> } };
  const { model: _m, ...rest } = built;
  void _m;
  send({
    type: "session.update",
    session: {
      ...rest,
      ...sessionPatch,
      audio: { ...built.audio, input: { ...built.audio.input, format: { type: "audio/pcm", rate: SAMPLE_RATE } } }
    }
  });
  await waitFor((e) => e.type === "session.updated", 15_000);
  // Exactly what beginTurn sends.
  send({ type: "session.update", session: { type: "realtime", instructions: buildTurnInstructions(DIRECTION) } });
  const stream = async (pcm: Buffer) => {
    const chunk = (SAMPLE_RATE * 2) / 10;
    for (let off = 0; off < pcm.length; off += chunk) {
      send({ type: "input_audio_buffer.append", audio: pcm.subarray(off, off + chunk).toString("base64") });
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  return { ws, events, send, now, waitFor, stream, close: () => ws.close() };
}

const silence = (ms: number) => Buffer.alloc(Math.round((SAMPLE_RATE * 2 * ms) / 1000));
function gain(pcm: Buffer, g: number): Buffer {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i + 1 < pcm.length; i += 2) out.writeInt16LE(Math.round(pcm.readInt16LE(i) * g), i);
  return out;
}
function noise(ms: number, amp: number): Buffer {
  const out = silence(ms);
  for (let i = 0; i + 1 < out.length; i += 2) out.writeInt16LE(Math.round((Math.random() * 2 - 1) * amp), i);
  return out;
}


/** Shorten every pause to ~120 ms so server VAD sees ONE unbroken segment. */
function squeeze(pcm: Buffer): Buffer {
  const frame = (SAMPLE_RATE * 2 * 20) / 1000;
  const out: Buffer[] = [];
  let quietRun = 0;
  for (let off = 0; off + frame <= pcm.length; off += frame) {
    let sum = 0;
    for (let i = off; i < off + frame; i += 2) sum += Math.abs(pcm.readInt16LE(i));
    const quiet = sum / (frame / 2) < 150;
    quietRun = quiet ? quietRun + 1 : 0;
    if (quietRun <= 6) out.push(pcm.subarray(off, off + frame));
  }
  return Buffer.concat(out);
}
const secs = (pcm: Buffer, s: number) => pcm.subarray(0, Math.round(SAMPLE_RATE * s) * 2);
function audioIn(e: Ev | null): number {
  const r = (e?.ev.response ?? {}) as { usage?: { input_token_details?: { audio_tokens?: number } } };
  return r.usage?.input_token_details?.audio_tokens ?? -1;
}

function count(events: Ev[], type: string, from = 0): number {
  return events.filter((e) => e.type === type && e.t >= from).length;
}
function textOf(events: Ev[], from = 0): string {
  return events
    .filter((e) => e.t >= from && (e.type === "response.output_text.delta" || e.type === "response.text.delta"))
    .map((e) => String(e.ev.delta ?? ""))
    .join("");
}
function describeDone(e: Ev | null): string {
  if (!e) return "none";
  const r = (e.ev.response ?? {}) as {
    status?: string;
    status_details?: unknown;
    usage?: { input_token_details?: { audio_tokens?: number }; output_token_details?: { text_tokens?: number } };
  };
  return `status=${r.status} details=${JSON.stringify(r.status_details ?? null)} audio_in=${r.usage?.input_token_details?.audio_tokens ?? "?"} text_out=${r.usage?.output_token_details?.text_tokens ?? "?"}`;
}

/** Commit by hand, then ask for a response if the server did not start one. */
async function flush(s: Awaited<ReturnType<typeof openSession>>, label: string, vadOff: boolean) {
  const at = s.now();
  if (vadOff) {
    send(s, { type: "session.update", session: { type: "realtime", audio: { input: { turn_detection: null } } } });
    const upd = await s.waitFor((e) => e.type === "session.updated" || e.type === "error", 5000, at);
    console.log(`[flush-probe] ${label} vad-off update -> ${upd?.type} ${upd?.type === "error" ? JSON.stringify(upd.ev.error) : ""}`);
  }
  const commitAt = s.now();
  s.send({ type: "input_audio_buffer.commit" });
  const res = await s.waitFor((e) => e.type === "input_audio_buffer.committed" || e.type === "error", 5000, commitAt);
  console.log(
    `[flush-probe] ${label} manual commit -> ${res?.type ?? "NOTHING"} after ${res ? Math.round(res.t - commitAt) : "-"}ms ${res?.type === "error" ? JSON.stringify(res.ev.error) : ""}`
  );
  if (res?.type !== "input_audio_buffer.committed") return;
  const autoResp = await s.waitFor((e) => e.type === "response.created", 2000, commitAt);
  console.log(`[flush-probe] ${label} server auto-created a response after the manual commit: ${autoResp ? "YES" : "no"}`);
  const askAt = s.now();
  if (!autoResp) s.send({ type: "response.create" });
  const created = autoResp ?? (await s.waitFor((e) => e.type === "response.created" || e.type === "error", 8000, askAt));
  const first = await s.waitFor((e) => e.type === "response.output_text.delta", 20_000, commitAt);
  const done = await s.waitFor((e) => e.type === "response.done", 45_000, commitAt);
  const heard = await s.waitFor((e) => e.type === "conversation.item.input_audio_transcription.completed", 8000, commitAt);
  console.log(
    `[flush-probe] ${label} response.created=${created?.type} first_delta_ms=${first ? Math.round(first.t - commitAt) : "none"} done_ms=${done ? Math.round(done.t - commitAt) : "none"} ${describeDone(done)}`
  );
  console.log(`[flush-probe] ${label} heard=${JSON.stringify(heard?.ev.transcript ?? null)}`);
  console.log(`[flush-probe] ${label} translation=${JSON.stringify(textOf(s.events, commitAt))}`);
  const errs = s.events.filter((e) => e.type === "error" && e.t >= at).map((e) => JSON.stringify(e.ev.error));
  if (errs.length) console.log(`[flush-probe] ${label} errors: ${errs.join(" | ")}`);
}
function send(s: { send: (o: unknown) => void }, o: unknown) {
  s.send(o);
}

describe("tabletop end-of-turn flush, live", () => {
  it("answers the five questions", async () => {
    const short = await synthesize(SHORT, "nova");
    console.log(`[flush-probe] model=${MODEL} short=${short.seconds.toFixed(1)}s gain=${SOFT_GAIN}`);

    for (const vadOff of [false, true]) {
      const label = vadOff ? "soft-vad-off" : "soft-vad-on";
      if (!CASES.includes(label)) continue;
      const s = await openSession();
      await s.stream(gain(short.pcm, SOFT_GAIN));
      await s.stream(silence(900)); // the client's ENDTURN_VAD_GRACE_MS
      console.log(
        `[flush-probe] ${label} after soft speech + 900ms grace: speech_started=${count(s.events, "input_audio_buffer.speech_started")} committed=${count(s.events, "input_audio_buffer.committed")} response.created=${count(s.events, "response.created")}`
      );
      await flush(s, label, vadOff);
      s.close();
    }

    if (CASES.includes("long")) {
      const long = await synthesize(LONG, "nova");
      const s = await openSession();
      await s.stream(long.pcm);
      const endAt = s.now();
      console.log(
        `[flush-probe] long ${long.seconds.toFixed(1)}s streamed: speech_started=${count(s.events, "input_audio_buffer.speech_started")} committed=${count(s.events, "input_audio_buffer.committed")} responses_done=${count(s.events, "response.done")}`
      );
      // The muted mic: silence keeps flowing while the drain waits.
      const tail = s.stream(silence(12_000));
      const stopped = await s.waitFor((e) => e.type === "input_audio_buffer.speech_stopped", 6000, endAt - 400);
      const created = await s.waitFor((e) => e.type === "response.created", 8000, endAt - 400);
      const first = await s.waitFor((e) => e.type === "response.output_text.delta", 20_000, created?.t ?? endAt);
      const done = await s.waitFor((e) => e.type === "response.done", 40_000, created?.t ?? endAt);
      await tail;
      console.log(
        `[flush-probe] long after voice stopped: speech_stopped=${stopped ? Math.round(stopped.t - endAt) : "none"}ms response.created=${created ? Math.round(created.t - endAt) : "none"}ms first_delta=${first ? Math.round(first.t - endAt) : "none"}ms done=${done ? Math.round(done.t - endAt) : "none"}ms`
      );
      const dones = s.events.filter((e) => e.type === "response.done");
      dones.forEach((d, i) => console.log(`[flush-probe] long response #${i}: at=${Math.round(d.t - endAt)}ms ${describeDone(d)}`));
      console.log(`[flush-probe] long translation (${textOf(s.events).length} chars)=${JSON.stringify(textOf(s.events))}`);
      s.close();
    }

    for (const kind of ["silence", "noise"] as const) {
      if (!CASES.includes(kind)) continue;
      const s = await openSession();
      await s.stream(kind === "silence" ? silence(5000) : noise(5000, 300));
      console.log(
        `[flush-probe] ${kind} 5s: speech_started=${count(s.events, "input_audio_buffer.speech_started")} committed=${count(s.events, "input_audio_buffer.committed")}`
      );
      await flush(s, kind, false);
      s.close();
    }

    // One UNBROKEN segment of N seconds, on the shipped session (or with the
    // context cap changed): is the model handed the audio it must translate?
    const segCases = CASES.filter((c) => c.startsWith("seg-"));
    if (segCases.length || CASES.includes("open")) {
      const long = squeeze((await synthesize(LONG, "nova")).pcm);
      console.log(`[flush-probe] squeezed monologue = ${(long.length / (SAMPLE_RATE * 2)).toFixed(1)}s`);
      for (const c of segCases) {
        // seg-<seconds>[-<cap|off>][-rescue]
        const [, n, capRaw] = c.split("-");
        const cap = capRaw === undefined || capRaw === "rescue" ? undefined : capRaw === "off" ? null : Number(capRaw);
        const s = await openSession(
          cap === undefined
            ? {}
            : (() => {
                const b = buildTabletopSession({ direction: DIRECTION, model: MODEL, transcribeModel: "gpt-4o-mini-transcribe", contextTokenLimit: cap }) as Record<string, unknown>;
                return cap === null ? { truncation: "disabled" } : { truncation: b.truncation };
              })()
        );
        await s.stream(secs(long, Number(n)));
        const endAt = s.now();
        const tail = s.stream(silence(2500));
        const committed = await s.waitFor((e) => e.type === "input_audio_buffer.committed", 5000);
        const done = await s.waitFor((e) => e.type === "response.done", 30_000, endAt);
        await tail;
        console.log(
          `[flush-probe] ${c}: segments=${count(s.events, "input_audio_buffer.committed")} done_ms=${done ? Math.round(done.t - endAt) : "none"} ${describeDone(done)}`
        );
        console.log(`[flush-probe] ${c}: translation=${JSON.stringify(textOf(s.events))}`);
        if (c.endsWith("rescue") && committed) {
          const at = s.now();
          s.send({
            type: "response.create",
            response: {
              conversation: "none",
              output_modalities: ["text"],
              max_output_tokens: 1200,
              input: [{ type: "item_reference", id: committed.ev.item_id }]
            }
          });
          const rdone = await s.waitFor((e) => e.type === "response.done" || e.type === "error", 40_000, at);
          console.log(`[flush-probe] ${c}: RESCUE (input=item_reference, conversation=none) -> ${rdone?.type} done_ms=${rdone ? Math.round(rdone.t - at) : "none"} ${rdone?.type === "error" ? JSON.stringify(rdone.ev.error) : describeDone(rdone)}`);
          console.log(`[flush-probe] ${c}: RESCUE translation=${JSON.stringify(textOf(s.events, at))}`);
        }
        s.close();
      }
      if (CASES.includes("open")) {
        // The mic stops delivering audio with the voice still "open" — no
        // trailing silence at all, so VAD cannot close the segment.
        const s = await openSession();
        await s.stream(secs(long, 6));
        const endAt = s.now();
        await new Promise((r) => setTimeout(r, 1500));
        console.log(
          `[flush-probe] open: 1.5s after audio stopped arriving: speech_started=${count(s.events, "input_audio_buffer.speech_started")} speech_stopped=${count(s.events, "input_audio_buffer.speech_stopped")} committed=${count(s.events, "input_audio_buffer.committed")}`
        );
        void endAt;
        await flush(s, "open", false);
        const after = s.now();
        await s.stream(silence(1500));
        console.log(
          `[flush-probe] open: silence after the manual commit -> speech_stopped=${count(s.events, "input_audio_buffer.speech_stopped", after)} committed=${count(s.events, "input_audio_buffer.committed", after)} response.created=${count(s.events, "response.created", after)} errors=${count(s.events, "error", after)}`
        );
        s.close();
      }
    }

    // Steady state: several unbroken L-second segments in ONE session — the
    // cap is on the whole retained context, not on one item.
    const usageOf = (e: Ev) => JSON.stringify(((e.ev.response ?? {}) as { usage?: { input_token_details?: unknown } }).usage?.input_token_details ?? null);
    const capPatch = (cap: number) => ({
      truncation: (buildTabletopSession({ direction: DIRECTION, model: MODEL, transcribeModel: "gpt-4o-mini-transcribe", contextTokenLimit: cap }) as Record<string, unknown>).truncation
    });
    for (const c of CASES.filter((x) => x.startsWith("steady-"))) {
      // steady-<seconds>[-<cap>]
      const [, n, capRaw] = c.split("-");
      const long = squeeze((await synthesize(LONG, "nova")).pcm);
      const L = Number(n);
      const s = await openSession(capRaw ? capPatch(Number(capRaw)) : {});
      const parts = Math.min(4, Math.floor(long.length / (SAMPLE_RATE * 2) / L));
      for (let i = 0; i < parts; i++) {
        const from = s.now();
        await s.stream(long.subarray(Math.round(SAMPLE_RATE * L * i) * 2, Math.round(SAMPLE_RATE * L * (i + 1)) * 2));
        const tail = s.stream(silence(1500));
        const done = await s.waitFor((e) => e.type === "response.done", 20_000, from);
        await tail;
        console.log(`[flush-probe] ${c} #${i}: audio_in=${audioIn(done)} usage=${done ? usageOf(done) : "none"} out=${JSON.stringify(textOf(s.events, from)).slice(0, 110)}`);
      }
      console.log(`[flush-probe] ${c}: committed=${count(s.events, "input_audio_buffer.committed")} responses=${count(s.events, "response.done")}`);
      s.close();
    }

    // THE candidate fix: unbroken speech, and the client commits by hand every
    // X seconds while the voice is still open (VAD on, shipped session).
    for (const c of CASES.filter((x) => x.startsWith("forced-"))) {
      const X = Number(c.split("-")[1]);
      const long = squeeze((await synthesize(LONG, "nova")).pcm);
      const s = await openSession();
      const total = long.length / (SAMPLE_RATE * 2);
      let manual = 0;
      const streaming = s.stream(Buffer.concat([long, silence(2500)]));
      const started = await s.waitFor((e) => e.type === "input_audio_buffer.speech_started", 5000);
      let openSince = started?.t ?? s.now();
      while (s.now() - (started?.t ?? 0) < total * 1000 - 800) {
        await new Promise((r) => setTimeout(r, 50));
        if (s.now() - openSince < X * 1000) continue;
        const at = s.now();
        s.send({ type: "input_audio_buffer.commit" });
        const res = await s.waitFor((e) => e.type === "input_audio_buffer.committed" || e.type === "error", 3000, at);
        if (res?.type !== "input_audio_buffer.committed") {
          console.log(`[flush-probe] ${c}: manual commit failed ${JSON.stringify(res?.ev.error ?? null)}`);
          break;
        }
        openSince = s.now();
        manual += 1;
        s.send({ type: "response.create" });
      }
      await streaming;
      await new Promise((r) => setTimeout(r, 2500));
      const dones = s.events.filter((e) => e.type === "response.done");
      console.log(
        `[flush-probe] ${c}: ${total.toFixed(1)}s unbroken, manual_commits=${manual} committed=${count(s.events, "input_audio_buffer.committed")} speech_stopped=${count(s.events, "input_audio_buffer.speech_stopped")} responses=${dones.length} audio_in=[${dones.map((d) => audioIn(d)).join(",")}] errors=${s.events.filter((e) => e.type === "error").map((e) => JSON.stringify((e.ev.error as { code?: string })?.code)).join(",")}`
      );
      const perResp: string[] = [];
      let cur = "";
      for (const e of s.events) {
        if (e.type === "response.output_text.delta") cur += String(e.ev.delta ?? "");
        if (e.type === "response.done") {
          perResp.push(cur);
          cur = "";
        }
      }
      perResp.forEach((t, i) => console.log(`[flush-probe] ${c} resp#${i}: ${JSON.stringify(t)}`));
      s.close();
    }

    // A second segment that commits while the first one's response is still
    // being written (interrupt_response:false): does it ever get its own?
    if (CASES.includes("overlap")) {
      const a = await synthesize("Mañana por la tarde vamos a visitar a mis abuelos en el rancho y regresamos el domingo.", "nova");
      const b = await synthesize("Sí, claro.", "nova");
      for (const gap of [600, 700]) {
        const s = await openSession();
        await s.stream(Buffer.concat([a.pcm, silence(gap), b.pcm, silence(4000)]));
        const order = s.events
          .filter((e) => /speech_stopped|committed|response\.created|response\.done/.test(e.type))
          .map((e) => `${e.type.replace("input_audio_buffer.", "")}@${Math.round(e.t)}`);
        console.log(`[flush-probe] overlap gap=${gap}: committed=${count(s.events, "input_audio_buffer.committed")} response.created=${count(s.events, "response.created")} | ${order.join(" ")}`);
        console.log(`[flush-probe] overlap gap=${gap}: out=${JSON.stringify(textOf(s.events))}`);
        s.close();
      }
    }

    // THE FIX, as shipped: lib/tabletop/turnFlush.ts itself, fed the real
    // session's events and sending into it — the same object live.ts runs.
    //   ctl-<cap>[-nohint]   31 s of unbroken speech, then the mic closes
    //   ctl-open             the mic stops delivering mid-voice; no silence
    for (const c of CASES.filter((x) => x.startsWith("ctl-"))) {
      const open = c === "ctl-open";
      const cap = open ? 100 : Number(c.split("-")[1]);
      const hint = !c.endsWith("nohint");
      const long = squeeze((await synthesize(LONG, "nova")).pcm);
      const s = await openSession(cap === 100 ? {} : capPatch(cap));
      const base = buildTurnInstructions(DIRECTION);
      let segs: { id: string | null; text: string }[] = [];
      const assembled = () => segs.map((x) => x.text.trim()).filter(Boolean).join(" ");
      const audioIns: number[] = [];
      let droppedSeen = 0;
      const flusher = createTurnFlush({
        send: s.send,
        maxSegmentMs: tabletopMaxSegmentMs(cap, undefined),
        responseInstructions: (continuing) => (continuing && hint ? withContinuation(base, assembled()) : undefined)
      });
      let fed = 0;
      const pump = setInterval(() => {
        while (fed < s.events.length) {
          const e = s.events[fed++];
          const v = flusher.handle(e.ev);
          if (e.type === "response.created" && v.forTurn) segs.push({ id: v.responseId, text: "" });
          if (e.type === "response.output_text.delta" && v.forTurn) {
            const seg = segs.find((x) => x.id === v.responseId) ?? segs[segs.length - 1];
            if (seg) seg.text += String(e.ev.delta ?? "");
          }
          if (e.type === "response.done" && v.forTurn) {
            audioIns.push(audioIn(e));
            if (v.dropped) {
              droppedSeen += 1;
              segs = segs.filter((x) => x.id !== v.responseId);
            }
          }
          if (e.type === "error" && !v.swallow) console.log(`[flush-probe] ${c}: UNHANDLED error ${JSON.stringify(e.ev.error)}`);
        }
      }, 10);
      fed = s.events.length; // session setup events are not the turn's
      flusher.beginTurn();
      await s.stream(open ? secs(long, 4) : long);
      // The muted mic: silence keeps flowing — unless this is the open case.
      const tail = open ? Promise.resolve() : s.stream(silence(9000));
      const drain = await flusher.endTurn();
      await tail;
      clearInterval(pump);
      console.log(
        `[flush-probe] ${c}: max_segment_ms=${tabletopMaxSegmentMs(cap, undefined)} hint=${hint} drain=${JSON.stringify(drain)} audio_in=[${audioIns.join(",")}] dropped=${droppedSeen}`
      );
      segs.forEach((x, i) => console.log(`[flush-probe] ${c} seg#${i}: ${JSON.stringify(x.text)}`));
      s.close();
    }
    expect(true).toBe(true);
  });
});
