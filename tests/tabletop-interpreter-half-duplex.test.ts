// Interpreter mode, half-duplex — the fix for the table test of 2026-11-09.
//
// Tom and Liz, a real phone, ElevenLabs Realtime, commit ef73ba5. The engine
// translated well and its replies died after two or three sentences. The two
// exported timelines said why:
//
//   1. `input_audio_buffer.speech_started` on BOTH legs within ~60 ms, again
//      and again, with no commit after it: the interpreter's own voice coming
//      back in through the microphone. Each one was treated as a barge-in and
//      cut the spoken translation off.
//   2. `held-dropped` rows of 226,560 / 76,800 / 372,480 bytes: three finished
//      translations thrown away unplayed.
//
// What is pinned here (Tom's brief, same day): "while the gated player is
// audibly playing on a leg, don't treat speech_started as human barge-in …
// until playback finishes plus a short tail"; "a completed response whose
// audio was held should PLAY … rather than be discarded"; "the echo guard
// between the two sessions must stay"; and the timeline must "tag
// speech_started events that never led to a commit (phantom vs real)".

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createAudioGate } from "@/lib/interpreter/audioGate";
import {
  createHalfDuplex,
  engineIsHalfDuplex,
  gateFollows,
  HALF_DUPLEX_TAIL_MS,
  speakerActionFor
} from "@/lib/interpreter/halfDuplex";
import { createPeerHeard, createRealtimeReader, type LegSink } from "@/lib/interpreter/legEvents";
import {
  createSessionTimeline,
  parseTimelineDigest,
  PHANTOM_AFTER_MS,
  summarizeLegDigest,
  timelineLogLine
} from "@/lib/interpreter/timeline";

const SPEECH = { type: "input_audio_buffer.speech_started" };
const cancelled = (reason: string) => ({
  type: "response.done",
  response: { id: "r1", status: "cancelled", status_details: { reason } }
});

describe("half-duplex: the microphone while we are speaking", () => {
  it("is silenced on every leg while ANY leg plays, and for a short tail after", () => {
    const duplex = createHalfDuplex();
    expect(duplex.micMuted(1_000)).toBe(false);
    // Leg 0 schedules audio until t=5000. Leg 1 never plays — and is muted too:
    // both legs clone one microphone, the echo reaches both.
    duplex.playing(0, 5_000);
    expect(duplex.speaking(1_000)).toBe(true);
    expect(duplex.micMuted(4_999)).toBe(true);
    expect(duplex.speaking(5_000)).toBe(false);
    expect(duplex.micMuted(5_000 + HALF_DUPLEX_TAIL_MS - 1)).toBe(true);
    expect(duplex.micMuted(5_000 + HALF_DUPLEX_TAIL_MS)).toBe(false);
  });

  it("the tail is the 200–300 ms Tom asked for", () => {
    expect(HALF_DUPLEX_TAIL_MS).toBeGreaterThanOrEqual(200);
    expect(HALF_DUPLEX_TAIL_MS).toBeLessThanOrEqual(300);
  });

  it("follows the LAST leg still playing; chunks only extend, a cut ends it now", () => {
    const duplex = createHalfDuplex(300);
    duplex.playing(0, 3_000);
    duplex.playing(0, 2_000); // an earlier end never shortens it
    duplex.playing(1, 6_000);
    expect(duplex.micMuted(5_000)).toBe(true);
    duplex.cut(1, 5_000);
    expect(duplex.speaking(5_000)).toBe(false);
    // …but the room still rings: the tail runs from the cut.
    expect(duplex.micMuted(5_299)).toBe(true);
    expect(duplex.micMuted(5_300)).toBe(false);
    // A cut on a leg that already finished changes nothing.
    duplex.cut(0, 9_000);
    expect(duplex.micMuted(9_000)).toBe(false);
  });

  it("is ElevenLabs only — Grok was behaving at the same table and is left alone", () => {
    expect(engineIsHalfDuplex("elevenlabs-realtime")).toBe(true);
    for (const engine of ["grok-voice", "openai-realtime", "openai-translate", "openai-live", "gemini-live"]) {
      expect(engineIsHalfDuplex(engine)).toBe(false);
    }
  });

  it("the transport sends SILENCE, not a gap, and never the room", () => {
    const client = readFileSync("lib/interpreter/client.ts", "utf8");
    const muted = client.slice(client.indexOf("if (halfDuplex && duplex.micMuted(Date.now()))"));
    expect(muted.indexOf("new Int16Array(pcm.length)")).toBeGreaterThan(0);
    // The silent frame goes out and the function returns before the real one is built.
    expect(muted.indexOf("ws.send(silentFrame.frame)")).toBeLessThan(muted.indexOf("bytesToBase64(s16ToLeBytes(pcm))"));
    expect(muted.indexOf("return;")).toBeLessThan(muted.indexOf("bytesToBase64(s16ToLeBytes(pcm))"));
    // The echo canceller is still asked for: half-duplex is on top of it.
    expect(client).toContain("echoCancellation: true");
    // One clock for the whole session, fed by the player itself.
    expect(client.match(/createHalfDuplex\(\)/g)).toHaveLength(1);
    // (The player moved to lib/interpreter/pcmPlayer.ts on 2026-11-09; same rule,
    // and tests/tabletop-interpreter-pcm-player.test.ts runs it.)
    const player = readFileSync("lib/interpreter/pcmPlayer.ts", "utf8");
    expect(player).toContain("watch.playing(now() + (queued + latency) * 1000)");
    expect(client).toContain("playing: (untilMs) => duplex.playing(legIndex, untilMs)");
  });
});

describe("half-duplex: what cuts the speaker", () => {
  it("speech_started does NOT — it was mostly our own voice", () => {
    expect(speakerActionFor(SPEECH, true)).toBeNull();
  });

  it("the provider cancelling a reply for a new turn DOES", () => {
    expect(speakerActionFor(cancelled("turn_detected"), true)).toBe("cut");
    expect(speakerActionFor(cancelled("client_cancelled"), true)).toBeNull();
    expect(
      speakerActionFor({ type: "response.done", response: { id: "r1", status: "completed" } }, true)
    ).toBeNull();
  });

  it("full duplex (Grok) is exactly as it was: speech_started cuts, a cancel does nothing more", () => {
    expect(speakerActionFor(SPEECH, false)).toBe("cut");
    expect(speakerActionFor(cancelled("turn_detected"), false)).toBeNull();
  });

  it("a new reply re-arms the gate either way", () => {
    for (const half of [true, false]) {
      expect(speakerActionFor({ type: "response.created", response: { id: "r2" } }, half)).toBe("rearm");
    }
  });

  it("the transport and the live-fire rig both run that one rule", () => {
    const client = readFileSync("lib/interpreter/client.ts", "utf8");
    expect(client).toContain("speakerActionFor(msg, halfDuplex)");
    expect(client).not.toMatch(/speech_started"\)\s*player\.flush\(\)/);
    const rig = readFileSync("tests/live-fire/interpreter-engines.measure.ts", "utf8");
    expect(rig).toContain("speakerActionFor(msg, HALF_DUPLEX)");
    expect(rig).not.toContain('"input_audio_buffer.speech_started") gate.flush()');
  });
});

// ── The table, replayed ────────────────────────────────────────────────────
// A leg's transport in miniature: the real reader, the real gate, the real
// speaker rule — everything but the socket and the loudspeaker.
function tableLeg(halfDuplex: boolean) {
  const played: number[] = [];
  const events: string[] = [];
  const gate = createAudioGate<Uint8Array>(
    { play: (chunk) => played.push(chunk.length), flush: () => events.push("flush") },
    true,
    { onOpen: () => events.push("open"), onDropped: (bytes) => events.push(`dropped:${bytes}`) }
  );
  const captions = new Map<string, string>();
  const sink: LegSink = {
    caption: (update) => captions.set(update.id, update.said ?? ""),
    activity: () => {},
    usage: () => {},
    geminiUsage: () => {},
    transcribed: () => {},
    billed: () => {},
    bargeIn: () => {},
    gate: (open) => {
      if (gateFollows(open, halfDuplex)) gate.setAudible(open);
    },
    flushAudio: gate.flush,
    responseSilent: gate.dropHeld,
    error: () => {},
    closed: () => {}
  };
  const reader = createRealtimeReader({ index: 0, source: "en", target: "es" }, sink, {
    echoGuard: true,
    peers: createPeerHeard()
  });
  const recv = (msg: Record<string, unknown>) => {
    const action = speakerActionFor(msg, halfDuplex);
    if (action === "rearm") gate.rearm();
    else if (action === "cut") gate.flush();
    if (msg.type === "response.output_audio.delta") gate.play(new Uint8Array(4800));
    reader.handle(msg);
  };
  return { recv, played, events, captions };
}

/** A turn is heard and its reply begins: words first, then the first audio frame. */
function beginReply(leg: ReturnType<typeof tableLeg>, n: number, heard: string, said: string) {
  leg.recv({ type: "input_audio_buffer.speech_started" });
  leg.recv({ type: "input_audio_buffer.committed", item_id: `i${n}` });
  leg.recv({ type: "conversation.item.input_audio_transcription.completed", item_id: `i${n}`, transcript: heard });
  leg.recv({ type: "response.created", response: { id: `r${n}` } });
  leg.recv({ type: "response.output_audio_transcript.delta", response_id: `r${n}`, delta: said });
  leg.recv({ type: "response.output_audio.delta", response_id: `r${n}`, delta: "AAAA" });
}
const audio = (leg: ReturnType<typeof tableLeg>, n: number, frames: number) => {
  for (let k = 0; k < frames; k++) leg.recv({ type: "response.output_audio.delta", response_id: `r${n}`, delta: "AAAA" });
};
const done = (leg: ReturnType<typeof tableLeg>, n: number) =>
  leg.recv({ type: "response.done", response: { id: `r${n}`, status: "completed" } });

describe("the 2026-11-09 table, replayed against the reader + gate + speaker rule", () => {
  // What the provider sent when it heard our own voice a second into a reply:
  // speech_started, then output_audio_buffer.cleared for the reply — and then
  // the REST of that reply's audio, and a normal response.done.
  const echoMidReply = (leg: ReturnType<typeof tableLeg>, n: number) => {
    beginReply(leg, n, "How was your day?", "¿Cómo estuvo tu día?");
    audio(leg, n, 4);
    leg.recv({ type: "input_audio_buffer.speech_started" }); // our own playback
    leg.recv({ type: "output_audio_buffer.cleared", response_id: `r${n}` });
    audio(leg, n, 40);
    done(leg, n);
  };

  it("BEFORE (full-duplex rule): the echo cuts the reply and the rest is held, then dropped", () => {
    const leg = tableLeg(false);
    echoMidReply(leg, 1);
    beginReply(leg, 2, "Did you rest?", "¿Descansaste?");
    expect(leg.events).toContain("flush");
    // 40 frames × 4800 bytes of a finished translation, never played.
    expect(leg.events).toContain(`dropped:${40 * 4800}`);
    expect(leg.played.length).toBeLessThan(46);
  });

  it("AFTER (half-duplex): every frame of the reply is played, nothing is dropped, nothing is cut", () => {
    const leg = tableLeg(true);
    echoMidReply(leg, 1);
    beginReply(leg, 2, "Did you rest?", "¿Descansaste?");
    audio(leg, 2, 9);
    done(leg, 2);
    expect(leg.played).toHaveLength(1 + 4 + 40 + 1 + 9);
    expect(leg.events.filter((e) => e.startsWith("dropped"))).toEqual([]);
    expect(leg.events).not.toContain("flush");
    expect([...leg.captions.values()]).toEqual(["¿Cómo estuvo tu día?", "¿Descansaste?"]);
  });

  it("a phantom speech_started BEFORE a reply is audible no longer throws the reply away", () => {
    const leg = tableLeg(true);
    leg.recv({ type: "input_audio_buffer.committed", item_id: "i1" });
    leg.recv({ type: "conversation.item.input_audio_transcription.completed", item_id: "i1", transcript: "Thanks a lot" });
    leg.recv({ type: "response.created", response: { id: "r1" } });
    // Audio leads the words by a few frames: held behind the gate…
    audio(leg, 1, 3);
    expect(leg.played).toEqual([]);
    // …and speech "starts" while it is held. It used to be flushed here.
    leg.recv({ type: "input_audio_buffer.speech_started" });
    leg.recv({ type: "response.output_audio_transcript.delta", response_id: "r1", delta: "Muchas gracias" });
    audio(leg, 1, 5);
    done(leg, 1);
    expect(leg.played).toHaveLength(8);
    expect(leg.events.filter((e) => e !== "open")).toEqual([]);
  });

  it("THE ECHO GUARD STAYS: a reply that repeats what it heard is still held and dropped, not played", () => {
    const leg = tableLeg(true);
    beginReply(leg, 1, "So how was your day today?", "So how was your day today?");
    audio(leg, 1, 20);
    done(leg, 1);
    expect(leg.played).toEqual([]);
    expect(leg.captions.size).toBe(0);
    expect(leg.events).toEqual([`dropped:${21 * 4800}`]);
    // …and the real interpretation that follows is not muted by it.
    beginReply(leg, 2, "Did you rest?", "¿Descansaste?");
    audio(leg, 2, 2);
    expect(leg.played).toHaveLength(3);
  });

  it("a wordless reply (the quiet leg) is still dropped; a later one still plays", () => {
    const leg = tableLeg(true);
    leg.recv({ type: "response.created", response: { id: "r1" } });
    audio(leg, 1, 6);
    done(leg, 1);
    expect(leg.played).toEqual([]);
    expect(leg.events).toEqual([`dropped:${6 * 4800}`]);
  });

  it("a REAL barge-in still stops the speaker: the provider cancels the reply for a new turn", () => {
    const leg = tableLeg(true);
    beginReply(leg, 1, "How was your day?", "¿Cómo estuvo");
    audio(leg, 1, 3);
    leg.recv({ type: "input_audio_buffer.speech_started" });
    expect(leg.events).not.toContain("flush");
    leg.recv({
      type: "response.done",
      response: { id: "r1", status: "cancelled", status_details: { reason: "turn_detected" } }
    });
    expect(leg.events).toContain("flush");
  });
});

describe("the timeline says phantom from real", () => {
  function clock() {
    let t = 1_000_000;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  }
  const meta = (source: string, target: string) => ({ source, target, transport: "realtime-ws" });

  it("tags every speech_started: committed, peer, phantom, open — and whether we were speaking", () => {
    const c = clock();
    const timeline = createSessionTimeline({ engine: "elevenlabs-realtime", model: "eleven_realtime_v1_mini", now: c.now });
    const en = timeline.leg(0, meta("en", "es"));
    const es = timeline.leg(1, meta("es", "en"));

    // An English turn: both legs hear it start; only the en→es leg commits.
    en.recv(SPEECH, 80);
    c.advance(45);
    es.recv(SPEECH, 80);
    c.advance(2000);
    en.recv({ type: "input_audio_buffer.committed", item_id: "a" }, 90);

    // Our own playback, heard by both legs within 60 ms. Nobody commits.
    c.advance(1000);
    en.recv(SPEECH, 80, { speaker: true });
    c.advance(60);
    es.recv(SPEECH, 80, { speaker: true });

    // A Spanish turn: es→en commits; the en leg only ever heard it start.
    c.advance(5000);
    en.recv(SPEECH, 80);
    es.recv(SPEECH, 80);
    c.advance(1500);
    es.recv({ type: "input_audio_buffer.committed", item_id: "b" }, 90);

    // And one more start, just before Stop.
    c.advance(500);
    en.recv(SPEECH, 80);
    c.advance(200);

    const exported = timeline.export();
    const speech = (leg: number) =>
      exported.rows
        .filter((r) => r.leg === leg && r.type === "input_audio_buffer.speech_started")
        .map((r) => `${r.speech}${r.spk ? "+spk" : ""}`);
    expect(speech(0)).toEqual(["committed", "phantom+spk", "peer", "open"]);
    expect(speech(1)).toEqual(["peer", "phantom+spk", "committed"]);

    const [d0, d1] = exported.digest;
    expect(d0).toMatchObject({ speechStarted: 4, speechCommitted: 1, speechPeer: 1, speechPhantom: 1, speechInPlayback: 1 });
    expect(d1).toMatchObject({ speechStarted: 3, speechCommitted: 1, speechPeer: 1, speechPhantom: 1, speechInPlayback: 1 });
  });

  it("an unanswered speech_started is called a phantom once it is old — in the export, not for good", () => {
    const c = clock();
    const timeline = createSessionTimeline({ engine: "elevenlabs-realtime", model: "m", now: c.now });
    const leg = timeline.leg(0, meta("en", "es"));
    leg.recv(SPEECH, 80);
    c.advance(PHANTOM_AFTER_MS - 1);
    expect(timeline.export().rows[0].speech).toBe("open");
    c.advance(1);
    const late = timeline.export();
    expect(late.rows[0].speech).toBe("phantom");
    expect(late.digest[0].speechPhantom).toBe(1);
    // It commits after all (a very long sentence): the next export says so.
    leg.recv({ type: "input_audio_buffer.committed", item_id: "a" }, 90);
    const told = timeline.export();
    expect(told.rows[0].speech).toBe("committed");
    expect(told.digest[0]).toMatchObject({ speechPhantom: 0, speechCommitted: 1 });
  });

  it("a commit does not claim another leg's speech_started from a different moment", () => {
    const c = clock();
    const timeline = createSessionTimeline({ engine: "elevenlabs-realtime", model: "m", now: c.now });
    const en = timeline.leg(0, meta("en", "es"));
    const es = timeline.leg(1, meta("es", "en"));
    es.recv(SPEECH, 80); // a noise only one leg reacted to
    c.advance(8000);
    en.recv(SPEECH, 80);
    c.advance(1000);
    en.recv({ type: "input_audio_buffer.committed", item_id: "a" }, 90);
    const rows = timeline.export().rows.filter((r) => r.type === "input_audio_buffer.speech_started");
    expect(rows.map((r) => `${r.leg}:${r.speech}`)).toEqual(["1:open", "0:committed"]);
  });

  it("records the muted stretches, the cuts and what the mic really granted — as numbers and tokens", () => {
    const c = clock();
    const timeline = createSessionTimeline({ engine: "elevenlabs-realtime", model: "m", now: c.now });
    const leg = timeline.leg(0, meta("en", "es"));
    leg.note("mic-settings", { cfg: { ec: true, ns: true, agc: false, rate: 48_000, label: "iPhone Microphone of Tom" } });
    // 2 s of our own playback, then quiet, then 1 s more.
    for (let k = 0; k < 20; k++) {
      leg.note("mic-muted", { bytes: 4800, ms: 100 });
      c.advance(100);
    }
    c.advance(3000);
    for (let k = 0; k < 10; k++) {
      leg.note("mic-muted", { bytes: 4800, ms: 100 });
      c.advance(100);
    }
    leg.note("speaker-cut");

    const exported = timeline.export();
    const settings = exported.rows.find((r) => r.type === "mic-settings");
    // Booleans and numbers pass; a device label (it has spaces) cannot.
    expect(settings?.cfg).toEqual({ ec: "true", ns: "true", agc: "false", rate: "48000" });
    const muted = exported.rows.filter((r) => r.type === "mic-muted");
    expect(muted.map((r) => r.n)).toEqual([20, 10]);
    expect(exported.digest[0]).toMatchObject({ micMutedMs: 3000, speakerCuts: 1 });

    const summary = summarizeLegDigest(exported.digest[0]);
    expect(summary).toMatchObject({ mic_muted_ms: 3000, speaker_cuts: 1, speech_phantom: 0 });
    const line = timelineLogLine("elevenlabs-realtime", summary);
    expect(line).toContain(" speech_phantom=0 speech_in_playback=0 mic_muted_ms=3000 speaker_cuts=1 ");
    expect(parseTimelineDigest([summary])).toEqual([summary]);
  });

  it("a phone still on the old build posts no half-duplex numbers: its digest is read, as zeros", () => {
    const timeline = createSessionTimeline({ engine: "grok-voice", model: "m" });
    timeline.leg(0, meta("en", "es")).recv({ type: "session.created", session: {} }, 100);
    const summary = summarizeLegDigest(timeline.export().digest[0]) as unknown as Record<string, unknown>;
    for (const key of ["speech_committed", "speech_peer", "speech_phantom", "speech_in_playback", "mic_muted_ms", "speaker_cuts"]) {
      delete summary[key];
    }
    const parsed = parseTimelineDigest([summary]);
    expect(parsed?.[0]).toMatchObject({ speech_phantom: 0, mic_muted_ms: 0, speaker_cuts: 0 });
    // …and a smuggled string where a number belongs still drops the lot.
    expect(parseTimelineDigest([{ ...summary, mic_muted_ms: "hola mi amor" }])).toBeNull();
  });
});
