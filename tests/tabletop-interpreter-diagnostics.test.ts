// The Interpreter-mode diagnostics timeline (lib/interpreter/timeline.ts) and
// the speaker gate it reports on (lib/interpreter/audioGate.ts).
//
// Added after the table test of 2026-11-09, where Grok produced one fragment
// and then nothing and the screen could not say why. The fence here is the
// one Tom drew in the brief: "event types + timestamps + byte counts only,
// never transcript content". Every test that records an event puts a marker
// sentence where a transcript would be and looks for it in what comes out.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createAudioGate, GATE_MAX_HELD_BYTES } from "@/lib/interpreter/audioGate";
import {
  base64Bytes,
  createSessionTimeline,
  DIAG_STORAGE_KEY,
  FOLD_WINDOW_MS,
  parseTimelineDigest,
  resolveDiagnostics,
  safeToken,
  sessionConfigTokens,
  summarizeLegDigest,
  timelineFileName,
  timelineLogLine,
  TIMELINE_MAX_ROWS
} from "@/lib/interpreter/timeline";

const SECRET_WORDS = "hola mi amor SMUGGLED-TRANSCRIPT";
const B64 = Buffer.from(new Uint8Array(4800)).toString("base64");

function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return { now: () => t, advance: (ms) => (t += ms) };
}

/** One spoken turn on a leg, the way a realtime provider sends it. */
function playTurn(
  leg: ReturnType<ReturnType<typeof createSessionTimeline>["leg"]>,
  c: ReturnType<typeof clock>,
  n: number,
  status = "completed"
): void {
  leg.recv({ type: "input_audio_buffer.speech_started", item_id: `i${n}` }, 90);
  c.advance(2000);
  leg.recv({ type: "input_audio_buffer.speech_stopped", item_id: `i${n}` }, 90);
  leg.recv({ type: "input_audio_buffer.committed", item_id: `i${n}` }, 95);
  leg.recv(
    { type: "conversation.item.input_audio_transcription.completed", item_id: `i${n}`, transcript: SECRET_WORDS },
    200
  );
  c.advance(300);
  leg.recv({ type: "response.created", response: { id: `resp_${n}` } }, 150);
  c.advance(700);
  for (let k = 0; k < 5; k++) {
    leg.recv({ type: "response.output_audio.delta", response_id: `resp_${n}`, delta: B64 }, B64.length + 120);
    leg.recv({ type: "response.output_audio_transcript.delta", response_id: `resp_${n}`, delta: SECRET_WORDS }, 160);
    c.advance(100);
  }
  leg.recv(
    {
      type: "response.done",
      response: {
        id: `resp_${n}`,
        status,
        status_details: status === "cancelled" ? { reason: "turn_detected" } : undefined,
        output: [{ content: [{ transcript: SECRET_WORDS }] }]
      }
    },
    900
  );
}

describe("the diagnostics timeline", () => {
  it("records shape — type, time, count, size — and not one word or sample", () => {
    const c = clock();
    const timeline = createSessionTimeline({ engine: "grok-voice", model: "grok-voice-3.0", now: c.now });
    const leg = timeline.leg(0, { source: "en", target: "es", transport: "realtime-ws" });
    leg.note("socket-open");
    leg.recv(
      {
        type: "session.created",
        session: { model: "grok-voice-3.0", instructions: SECRET_WORDS, voice: "CLONE-ID-SMUGGLED", reasoning: { effort: "high" } }
      },
      4000
    );
    leg.sent("session.update", 3900);
    c.advance(50);
    for (let k = 0; k < 20; k++) {
      leg.sent("input_audio_buffer.append", 6500, 4800);
      c.advance(100);
    }
    playTurn(leg, c, 1);
    leg.recv({ type: "error", error: { code: "rate_limit_exceeded", message: SECRET_WORDS } }, 300);
    leg.recv({ type: SECRET_WORDS }, 10);
    leg.note("socket-close", { reason: 1006 });

    const out = timeline.export();
    const json = JSON.stringify(out);
    expect(json).not.toContain("SMUGGLED");
    expect(json).not.toContain("hola");
    expect(json).not.toContain("amor");
    expect(json).not.toContain(B64.slice(0, 24));
    // A type that is not a protocol token is recorded as "?", never verbatim.
    expect(out.rows.some((r) => r.type === "?")).toBe(true);

    // The transcript is a LENGTH; the audio is a BYTE COUNT; the id an ordinal.
    const heard = out.rows.find((r) => r.type === "conversation.item.input_audio_transcription.completed")!;
    expect(heard).toMatchObject({ chars: SECRET_WORDS.length, i: 1, n: 1 });
    const audio = out.rows.find((r) => r.type === "response.output_audio.delta")!;
    expect(audio).toMatchObject({ r: 1, n: 5, audioBytes: 5 * 4800 });
    expect(audio.t2).toBeGreaterThan(audio.t);
    const said = out.rows.find((r) => r.type === "response.output_audio_transcript.delta")!;
    expect(said).toMatchObject({ r: 1, n: 5, chars: 5 * SECRET_WORDS.length });
    expect(out.rows.find((r) => r.type === "response.done")).toMatchObject({ status: "completed", r: 1 });
    // An error keeps its CODE and loses its message.
    expect(out.rows.find((r) => r.type === "error")).toMatchObject({ code: "rate_limit_exceeded" });
    // Twenty mic chunks (2 s) are one row; a run is cut every five seconds,
    // so the row still says WHEN the microphone was flowing.
    expect(out.rows.filter((r) => r.type === "input_audio_buffer.append")).toHaveLength(1);
    const long = createSessionTimeline({ engine: "grok-voice", model: "m", now: c.now });
    const mic = long.leg(0, { source: "en", target: "es", transport: "realtime-ws" });
    for (let k = 0; k < 120; k++) {
      mic.sent("input_audio_buffer.append", 6500, 4800);
      c.advance(100);
    }
    const micRows = long.export().rows;
    expect(micRows).toHaveLength(Math.ceil(12_000 / FOLD_WINDOW_MS));
    expect(micRows.reduce((a, r) => a + r.n, 0)).toBe(120);
    expect(out.rows.find((r) => r.type === "input_audio_buffer.append")).toMatchObject({ n: 20, audioBytes: 20 * 4800, dir: "out" });
    // What the provider says the session IS: tokens, without the briefing or the voice.
    expect(out.rows.find((r) => r.type === "session.created")?.cfg).toEqual({ model: "grok-voice-3.0", reasoning: "high" });
    expect(out.legs).toEqual([{ leg: 0, source: "en", target: "es", transport: "realtime-ws" }]);
  });

  it("every string in a row is a protocol token: there is nowhere to put a sentence", () => {
    expect(safeToken("response.output_audio.delta")).toBe("response.output_audio.delta");
    expect(safeToken("turn_detected")).toBe("turn_detected");
    expect(safeToken(1006)).toBe("1006");
    for (const bad of ["two words", "¿qué?", "a".repeat(65), "", null, undefined, {}, ["x"], "line\nbreak", 'q"uote']) {
      expect(safeToken(bad)).toBe("?");
    }
    // The config pick-list reads no free text: instructions and voice are not in it.
    const cfg = sessionConfigTokens({
      model: "eleven_realtime_v1_mini",
      instructions: SECRET_WORDS,
      max_duration_seconds: 660,
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          transcription: { language: "es" },
          turn_detection: { type: "semantic_vad", eagerness: "medium" }
        },
        output: { format: { type: "audio/pcm" }, voice: "CLONE-ID-SMUGGLED" }
      }
    });
    expect(cfg).toEqual({ model: "eleven_realtime_v1_mini", vad: "semantic_vad", eagerness: "medium", in_rate: "24000", max_s: "660" });
    // xAI keeps turn detection at the top of the session.
    expect(sessionConfigTokens({ turn_detection: { type: "server_vad" }, reasoning: { effort: "none" } })).toEqual({
      reasoning: "none",
      vad: "server_vad"
    });
    expect(sessionConfigTokens({ turn_detection: null }).vad).toBe("null");
    // Fenced in the source too: the recorder never ASSIGNS a transcript, a
    // delta or an error message — it only measures them.
    const src = readFileSync("lib/interpreter/timeline.ts", "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    expect(src).not.toMatch(/\.message\b/);
    for (const m of src.matchAll(/msg\.(delta|transcript)\b[^;\n]*/g)) {
      expect(m[0], m[0]).toMatch(/^msg\.(delta|transcript)\)(\.length)?\)?$/);
    }
    expect(src.match(/str\(msg\.delta\)\.length|base64Bytes\(str\(msg\.delta\)\)|str\(msg\.transcript\)\.length/g)?.length).toBe(4);
  });

  it("the digest says where a session went quiet", () => {
    const c = clock();
    const timeline = createSessionTimeline({ engine: "grok-voice", model: "m", now: c.now });
    const leg = timeline.leg(0, { source: "en", target: "es", transport: "realtime-ws" });
    playTurn(leg, c, 1, "cancelled");
    playTurn(leg, c, 2, "completed");
    // Then the stall of the table test: speech keeps arriving, nothing answers.
    c.advance(4000);
    leg.recv({ type: "input_audio_buffer.speech_started", item_id: "i3" }, 90);
    c.advance(1500);
    leg.recv({ type: "input_audio_buffer.committed", item_id: "i3" }, 95);
    c.advance(20_000);
    leg.note("mic-dropped", { bytes: 4800 });
    leg.note("gate-open");
    leg.note("held-dropped", { bytes: 96_000 });

    const digest = timeline.export().digest[0];
    expect(digest).toMatchObject({
      speechStarted: 3,
      committed: 3,
      responsesCreated: 2,
      responsesDone: { cancelled: 1, completed: 1 },
      responsesWithAudio: 2,
      responsesWithWords: 2,
      heardTranscripts: 2,
      audioOutBytes: 2 * 5 * 4800,
      micDropped: 1,
      gateOpens: 1,
      heldDroppedBytes: 96_000,
      lastInType: "input_audio_buffer.committed",
      lastInAgoMs: 20_000
    });
    // created → first audio, and commit → first audio, per turn.
    expect(digest.firstAudioMs).toEqual([700, 700]);
    expect(digest.turnToAudioMs).toEqual([1000, 1000]);
    expect(digest.longestInGapMs).toBe(4000);

    const summary = summarizeLegDigest(digest);
    expect(summary).toMatchObject({
      committed: 3,
      responses: 2,
      done_completed: 1,
      done_cancelled: 1,
      done_other: 0,
      first_audio_p50_ms: 700,
      turn_audio_max_ms: 1000,
      last_in: "input_audio_buffer.committed",
      last_in_ago_ms: 20_000,
      close: "none",
      reasoning: "unset",
      vad: "unset"
    });
    const line = timelineLogLine("grok-voice", summary);
    expect(line.startsWith("[taos-interpreter-diag] engine=grok-voice leg=0 transport=realtime-ws ")).toBe(true);
    for (const part of line.split(" ").slice(1)) expect(part).toMatch(/^[a-z_0-9]+=[A-Za-z0-9.\-_]+$/);
    // Round trip: what the phone posts is what the server accepts.
    expect(parseTimelineDigest(JSON.parse(JSON.stringify([summary])))).toEqual([summary]);
  });

  it("times a WebRTC engine's first audio from output_audio_buffer.started (its audio is on a track)", () => {
    const c = clock();
    const timeline = createSessionTimeline({ engine: "openai-realtime", model: "m", now: c.now });
    const leg = timeline.leg(0, { source: "en", target: "es", transport: "openai-webrtc" });
    leg.recv({ type: "input_audio_buffer.committed", item_id: "i1" }, 90);
    c.advance(400);
    leg.recv({ type: "response.created", response: { id: "r1" } }, 150);
    c.advance(250);
    leg.recv({ type: "response.output_audio_transcript.delta", response_id: "r1", delta: SECRET_WORDS }, 160);
    c.advance(250);
    leg.recv({ type: "output_audio_buffer.started", response_id: "r1" }, 90);
    leg.recv({ type: "output_audio_buffer.started", response_id: "r1" }, 90);
    const digest = timeline.export().digest[0];
    expect(digest).toMatchObject({ responsesWithAudio: 1, responsesWithWords: 1, audioOutBytes: 0 });
    expect(digest.firstAudioMs).toEqual([500]);
    expect(digest.turnToAudioMs).toEqual([900]);
  });

  it("a long dinner keeps its tail, and says how much of the front it let go", () => {
    const c = clock();
    const timeline = createSessionTimeline({ engine: "openai-realtime", model: "m", now: c.now });
    const leg = timeline.leg(0, { source: "en", target: "es", transport: "openai-webrtc" });
    for (let n = 0; n < TIMELINE_MAX_ROWS + 500; n++) {
      leg.recv({ type: n % 2 ? "input_audio_buffer.speech_started" : "input_audio_buffer.speech_stopped" }, 80);
      c.advance(10);
    }
    leg.note("socket-close", { reason: 1000 });
    const out = timeline.export();
    expect(out.rows.length).toBeLessThanOrEqual(TIMELINE_MAX_ROWS);
    expect(out.dropped).toBeGreaterThan(0);
    expect(out.dropped + out.rows.length).toBe(TIMELINE_MAX_ROWS + 501);
    expect(out.rows.at(-1)).toMatchObject({ type: "socket-close", reason: "1000" });
    // The digest counted everything, dropped rows included.
    expect(out.digest[0].speechStarted).toBe((TIMELINE_MAX_ROWS + 500) / 2);
    expect(out.digest[0].closeCode).toBe("1000");
  });

  it("is on unless this device turned it off, and ?diag= wins", () => {
    expect(DIAG_STORAGE_KEY).toBe("taos.interpreter.diag");
    expect(resolveDiagnostics({ stored: null })).toBe(true);
    expect(resolveDiagnostics({ stored: "1" })).toBe(true);
    expect(resolveDiagnostics({ stored: "0" })).toBe(false);
    expect(resolveDiagnostics({ stored: "0", query: "1" })).toBe(true);
    expect(resolveDiagnostics({ stored: "1", query: "0" })).toBe(false);
    expect(resolveDiagnostics({ stored: "0", query: "yes" })).toBe(false);
    const out = createSessionTimeline({ engine: "grok-voice", model: "m", now: () => Date.UTC(2026, 10, 9, 18, 2, 11) }).export();
    expect(timelineFileName(out)).toBe("taos-interpreter-grok-voice-2026-11-09T18-02-11.json");
    expect(base64Bytes(B64)).toBe(4800);
    expect(base64Bytes("")).toBe(0);
    expect(base64Bytes("QQ==")).toBe(1);
  });

  it("is only ever switched on from the founders' screen, and only posted through the summary's door", () => {
    const client = readFileSync("lib/interpreter/client.ts", "utf8");
    expect(client).toContain("timeline = opts.diagnostics ? createSessionTimeline(");
    const screen = readFileSync("components/tabletop/InterpreterMode.tsx", "utf8");
    expect(screen).toContain("diagnostics: diag");
    expect(screen).toContain("timeline.digest.map(summarizeLegDigest)");
    // The full timeline never leaves the phone by itself: no fetch carries it.
    expect(screen).not.toMatch(/body: JSON\.stringify\(\s*(timeline|lastTimeline)\b/);
    const route = readFileSync("app/api/tabletop/interpreter/usage/route.ts", "utf8");
    expect(route.indexOf("guardInterpreter(req)")).toBeLessThan(route.indexOf("parseTimelineDigest("));
    expect(route).toContain("timelineLogLine(summary.engine, leg)");
  });
});

describe("the speaker gate", () => {
  function rig(startHeld: boolean) {
    const played: number[] = [];
    const events: string[] = [];
    const gate = createAudioGate<Uint8Array>(
      { play: (chunk) => played.push(chunk.length), flush: () => events.push("flush") },
      startHeld,
      { onOpen: () => events.push("open"), onDropped: (bytes) => events.push(`dropped:${bytes}`) }
    );
    return { gate, played, events };
  }
  const chunk = (n: number) => new Uint8Array(n);

  it("holds a response's audio until it has words, then plays all of it in order", () => {
    const { gate, played, events } = rig(true);
    gate.rearm();
    gate.play(chunk(100));
    gate.play(chunk(200));
    expect(played).toEqual([]);
    gate.setAudible(true);
    expect(played).toEqual([100, 200]);
    gate.play(chunk(300));
    expect(played).toEqual([100, 200, 300]);
    expect(events).toEqual(["open"]);
  });

  it("throws away a wordless response's audio, and says how much", () => {
    const { gate, played, events } = rig(true);
    gate.rearm();
    gate.play(chunk(4800));
    gate.play(chunk(4800));
    gate.dropHeld();
    gate.rearm();
    gate.play(chunk(100));
    gate.setAudible(true);
    expect(played).toEqual([100]);
    expect(events).toEqual(["dropped:9600", "open"]);
    // A new response shuts it again; a barge-in drops what is held AND queued.
    gate.rearm();
    gate.play(chunk(50));
    gate.flush();
    expect(events.slice(2)).toEqual(["dropped:50", "flush"]);
  });

  it("holds nothing on a one-leg table, and never more than ~20 s on a two-leg one", () => {
    const one = rig(false);
    one.gate.rearm();
    one.gate.play(chunk(10));
    expect(one.played).toEqual([10]);
    expect(one.events).toEqual([]);

    const two = rig(true);
    for (let n = 0; n < 30; n++) two.gate.play(chunk(48_000));
    two.gate.setAudible(true);
    expect(two.played.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(GATE_MAX_HELD_BYTES);
  });
});
