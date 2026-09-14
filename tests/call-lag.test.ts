// The /call lag telemetry, and the Resync button that goes with it.
//
// Field report 2026-09-13: Tom and Liz, 90–120 minutes on /call. Quality held;
// latency grew monotonically from about the 20-minute mark, in the captions
// too, and only a rejoin reset it. Two candidates survive code reading — the
// input bridge accumulating delay (1) or the conversation history on OpenAI's
// side (2) — and [taos-call-lag] exists to tell them apart from an ordinary
// call. So what is pinned here is not only that the numbers exist, but that
// each candidate produces a DIFFERENT signature in them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import {
  createCallLagLog,
  lagLogLine,
  sanitizeLagRecord,
  type CallLagLog,
  type LagRecord,
  type LagSession
} from "@/lib/call/lag";

// ── A clock, a log, and what it wrote ─────────────────────────────────────

interface Rig {
  log: CallLagLog;
  lines: string[];
  sent: Array<{ records: LagRecord[]; dropped: number }>;
  at: (ms: number) => void;
}

function rig(overrides: Partial<Parameters<typeof createCallLagLog>[0]> = {}): Rig {
  let t = 0;
  const lines: string[] = [];
  const sent: Rig["sent"] = [];
  const log = createCallLagLog({
    room: "AB123",
    pair: () => "es->en",
    now: () => t,
    echo: (line) => lines.push(line),
    send: async (records, dropped) => {
      sent.push({ records, dropped });
    },
    flushIntervalMs: 0,
    ...overrides
  });
  return { log, lines, sent, at: (ms) => (t = ms) };
}

function field(line: string | undefined, name: string): string | undefined {
  return line?.match(new RegExp(`(?:^| )${name}=(\\S+)`))?.[1];
}

function turnLines(lines: string[]): string[] {
  return lines.filter((l) => l.startsWith("[taos-call-lag] turn "));
}

/**
 * One utterance, start to finish, at absolute times on the rig's clock.
 * `spokenEndAudioMs` is OpenAI's audio_end_ms; the session opened at
 * `openedAt`, so the speech really ended at openedAt + spokenEndAudioMs.
 */
function utterance(
  r: Rig,
  s: LagSession,
  u: {
    id: string;
    spokenEndAudioMs: number;
    arrival?: number | null;
    stoppedAt: number;
    transcribedAt: number;
    renderedAt?: number;
    requestedAt?: number;
    tokenAt: number;
    doneAt: number;
  }
): void {
  r.at(u.stoppedAt);
  s.speechStopped(u.id, u.spokenEndAudioMs, u.arrival ?? 0);
  r.at(u.transcribedAt);
  s.transcribed(u.id);
  if (u.renderedAt !== undefined) {
    r.at(u.renderedAt);
    r.log.heardRendered();
  }
  r.at(u.requestedAt ?? u.transcribedAt);
  s.requested();
  r.at(u.tokenAt);
  s.token();
  s.token(); // only the first counts
  r.at(u.doneAt);
  s.done();
}

describe("a turn line", () => {
  it("carries every number, each measured on the one monotonic clock", () => {
    const r = rig();
    const s = r.log.session();
    r.at(1000);
    s.opened();
    // Speech ended at 1000 + 5000 = 6000 on this phone. speech_stopped
    // arrived 600ms later, the transcript 400ms after that, the heard line
    // was on screen 16ms after THAT, and the model took 800ms to its first
    // token and 600ms more to finish.
    utterance(r, s, {
      id: "item_1",
      spokenEndAudioMs: 5000,
      arrival: 3,
      stoppedAt: 6600,
      transcribedAt: 7000,
      renderedAt: 7016,
      tokenAt: 7800,
      doneAt: 8400
    });

    expect(turnLines(r.lines)).toEqual([
      "[taos-call-lag] turn room=AB123 pair=es->en session=1 turn=1 session_age_ms=7400" +
        " call_age_ms=8400 audio_arrival_ms=3 vad_lag_ms=600 transcription_ms=400" +
        " heard_ms=1016 gate_ms=0 wait_ms=800 generation_ms=600 segments=1"
    ]);
  });

  it("always prints heard_ms, as ? when it was not measured", () => {
    // heard_ms is the single unanswered diagnostic in the investigation: the
    // heard line waits behind nothing, so it separates the two candidates
    // when nothing else can. It must never quietly fall off the line.
    const r = rig();
    const s = r.log.session();
    s.opened();
    utterance(r, s, {
      id: "a",
      spokenEndAudioMs: 100,
      stoppedAt: 700,
      transcribedAt: 1000,
      tokenAt: 1500,
      doneAt: 2000
    });
    expect(field(turnLines(r.lines)[0], "heard_ms")).toBe("?");
  });
});

describe("the two candidates leave different fingerprints", () => {
  it("candidate 1 (the bridge holds audio back): heard_ms and vad_lag_ms climb, transcription_ms does not", () => {
    const r = rig();
    const s = r.log.session();
    r.at(0);
    s.opened();
    for (let k = 0; k < 4; k++) {
      const spokenEnd = 60_000 * (k + 1); // one utterance a minute
      const held = 1000 * k; // and the bridge is a second further behind each time
      const stoppedAt = spokenEnd + 600 + held;
      utterance(r, s, {
        id: `c1-${k}`,
        spokenEndAudioMs: spokenEnd,
        arrival: held,
        stoppedAt,
        transcribedAt: stoppedAt + 400,
        renderedAt: stoppedAt + 416,
        tokenAt: stoppedAt + 1200,
        doneAt: stoppedAt + 1800
      });
    }
    const lines = turnLines(r.lines);
    expect(lines.map((l) => field(l, "audio_arrival_ms"))).toEqual(["0", "1000", "2000", "3000"]);
    expect(lines.map((l) => field(l, "heard_ms"))).toEqual(["1016", "2016", "3016", "4016"]);
    expect(lines.map((l) => field(l, "vad_lag_ms"))).toEqual(["600", "1600", "2600", "3600"]);
    // The event-relative numbers stay flat — which is exactly why they cannot
    // be the discriminator on their own.
    expect(new Set(lines.map((l) => field(l, "transcription_ms")))).toEqual(new Set(["400"]));
    expect(new Set(lines.map((l) => field(l, "wait_ms")))).toEqual(new Set(["800"]));
  });

  it("candidate 2 (history on OpenAI's side): wait_ms climbs while heard_ms and audio_arrival_ms hold", () => {
    const r = rig();
    const s = r.log.session();
    r.at(0);
    s.opened();
    for (let k = 0; k < 4; k++) {
      const spokenEnd = 60_000 * (k + 1);
      const stoppedAt = spokenEnd + 600;
      utterance(r, s, {
        id: `c2-${k}`,
        spokenEndAudioMs: spokenEnd,
        arrival: 0,
        stoppedAt,
        transcribedAt: stoppedAt + 400,
        renderedAt: stoppedAt + 416,
        tokenAt: stoppedAt + 400 + 800 + 700 * k,
        doneAt: stoppedAt + 400 + 1400 + 700 * k
      });
    }
    const lines = turnLines(r.lines);
    expect(lines.map((l) => field(l, "wait_ms"))).toEqual(["800", "1500", "2200", "2900"]);
    expect(new Set(lines.map((l) => field(l, "heard_ms")))).toEqual(new Set(["1016"]));
    expect(new Set(lines.map((l) => field(l, "audio_arrival_ms")))).toEqual(new Set(["0"]));
    expect(new Set(lines.map((l) => field(l, "gate_ms")))).toEqual(new Set(["0"]));
  });

  it("a speech backlog shows up in gate_ms, so it is not mistaken for candidate 2", () => {
    // The client holds a turn until the previous translation finished playing.
    // Two people talking faster than the clone voice can read grows wait_ms
    // too — gate_ms is what says the model was not the slow part.
    const r = rig();
    const s = r.log.session();
    r.at(0);
    s.opened();
    utterance(r, s, {
      id: "g",
      spokenEndAudioMs: 10_000,
      stoppedAt: 10_600,
      transcribedAt: 11_000,
      requestedAt: 14_000,
      tokenAt: 14_800,
      doneAt: 15_400
    });
    const line = turnLines(r.lines)[0];
    expect(field(line, "gate_ms")).toBe("3000");
    expect(field(line, "wait_ms")).toBe("3800");
  });

  it("times a response against the segment it actually covers, even when events interleave", () => {
    const r = rig();
    const s = r.log.session();
    r.at(0);
    s.opened();
    r.at(5600);
    s.speechStopped("first", 5000, 0);
    r.at(6600);
    s.speechStopped("second", 6000, 0);
    r.at(7000);
    s.transcribed("first");
    r.at(7200);
    s.transcribed("second");
    s.requested();
    r.at(8000);
    s.token();
    r.at(8500);
    s.done();
    const line = turnLines(r.lines)[0];
    // Timed against "second", the newest segment the response covers.
    expect(field(line, "transcription_ms")).toBe("600");
    expect(field(line, "segments")).toBe("2");
  });
});

describe("a rejoin is visible, not a silent reset", () => {
  it("opens every session with a session_reset that says what came before", () => {
    const r = rig();
    const first = r.log.session();
    r.at(100);
    first.opened();
    expect(r.lines[0]).toBe(
      "[taos-call-lag] session_reset room=AB123 pair=es->en reason=start session=1" +
        " prev_turns=0 prev_session_age_ms=0 call_age_ms=100"
    );
    for (let k = 0; k < 3; k++) {
      utterance(r, first, {
        id: `t${k}`,
        spokenEndAudioMs: 1000 * (k + 1),
        stoppedAt: 1700 + 1000 * k,
        transcribedAt: 1800 + 1000 * k,
        tokenAt: 1900 + 1000 * k,
        doneAt: 2000 + 1000 * k
      });
    }
    r.at(1_200_100);
    r.log.nextReason("auto_end_idle");
    first.closed();

    const second = r.log.session();
    r.at(1_500_000);
    second.opened();
    const reset = r.lines.filter((l) => l.includes(" session_reset "))[1];
    expect(field(reset, "reason")).toBe("auto_end_idle");
    expect(field(reset, "session")).toBe("2");
    expect(field(reset, "prev_turns")).toBe("3");
    expect(field(reset, "prev_session_age_ms")).toBe("1200000");
    expect(field(reset, "call_age_ms")).toBe("1500000");

    // turn and session_age_ms start again with the new session.
    utterance(r, second, {
      id: "after",
      spokenEndAudioMs: 2000,
      stoppedAt: 1_502_600,
      transcribedAt: 1_503_000,
      tokenAt: 1_503_500,
      doneAt: 1_504_000
    });
    const last = turnLines(r.lines).at(-1);
    expect(field(last, "session")).toBe("2");
    expect(field(last, "turn")).toBe("1");
    expect(field(last, "session_age_ms")).toBe("4000");
  });

  it("logs manual_resync on the press, and names it as the cause of the next session", () => {
    const r = rig();
    const s = r.log.session();
    r.at(0);
    s.opened();
    utterance(r, s, {
      id: "x",
      spokenEndAudioMs: 1000,
      stoppedAt: 1600,
      transcribedAt: 2000,
      tokenAt: 2500,
      doneAt: 3000
    });
    r.at(900_000);
    r.log.manualResync();
    expect(r.lines.at(-1)).toBe(
      "[taos-call-lag] manual_resync room=AB123 pair=es->en session=1 turn=1" +
        " session_age_ms=900000 call_age_ms=900000"
    );
    s.closed();
    const next = r.log.session();
    next.opened();
    expect(field(r.lines.at(-1), "reason")).toBe("manual_resync");
  });

  it("gives a session that is not the open one no way to write", () => {
    // A straggling event from a session being torn down must not land in its
    // successor's numbers.
    const r = rig();
    const old = r.log.session();
    old.opened();
    const fresh = r.log.session();
    fresh.opened();
    const before = r.lines.length;
    old.speechStopped("late", 100, 0);
    old.transcribed("late");
    old.requested();
    old.done();
    expect(r.lines.length).toBe(before);

    // And a handle that never connected never claims the log.
    const neverOpened = r.log.session();
    neverOpened.closed();
    utterance(r, fresh, {
      id: "ok",
      spokenEndAudioMs: 100,
      stoppedAt: 700,
      transcribedAt: 800,
      tokenAt: 900,
      doneAt: 1000
    });
    expect(turnLines(r.lines)).toHaveLength(1);
  });
});

describe("it stays cheap on a two-hour call", () => {
  it("never holds more than its cap, and says how many it dropped", () => {
    const r = rig({ maxBuffered: 5, flushEvery: 100 });
    for (let k = 0; k < 8; k++) r.log.manualResync();
    r.log.flush();
    return Promise.resolve().then(async () => {
      await Promise.resolve();
      expect(r.sent).toHaveLength(1);
      expect(r.sent[0].records).toHaveLength(5);
      expect(r.sent[0].dropped).toBe(3);
    });
  });

  it("posts in batches, and counts a failed post instead of retrying it", async () => {
    let fail = true;
    const sent: Array<{ records: LagRecord[]; dropped: number }> = [];
    const r = rig({
      flushEvery: 3,
      send: async (records, dropped) => {
        if (fail) throw new Error("no signal");
        sent.push({ records, dropped });
      }
    });
    for (let k = 0; k < 3; k++) r.log.manualResync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fail = false;
    for (let k = 0; k < 3; k++) r.log.manualResync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toHaveLength(1);
    expect(sent[0].records).toHaveLength(3);
    expect(sent[0].dropped).toBe(3);
  });

  it("flushes at hang-up and is silent afterwards", async () => {
    const r = rig({ flushEvery: 100 });
    r.log.manualResync();
    r.log.end();
    r.log.manualResync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(r.sent).toHaveLength(1);
    expect(r.lines).toHaveLength(1);
  });
});

describe("what reaches the log is rebuilt, not trusted", () => {
  it("cannot forge a second line or an unknown kind", () => {
    expect(sanitizeLagRecord({ kind: "usd", pair: "es->en", values: {} })).toBeNull();
    const record = sanitizeLagRecord({
      kind: "turn",
      pair: "es->en\n[taos-call-lag] turn room=FAKE",
      reason: "because",
      values: { heard_ms: 1e15, wait_ms: "900", turn: 4.6, bogus: 7 }
    });
    expect(record).not.toBeNull();
    const line = lagLogLine(record as LagRecord, "AB\n123");
    expect(line.split("\n")).toHaveLength(1);
    expect(line).not.toContain("FAKE");
    expect(line).not.toContain("bogus");
    expect(field(line, "heard_ms")).toBe("86400000");
    expect(field(line, "wait_ms")).toBe("?");
    expect(field(line, "turn")).toBe("5");
  });
});

// ── The route ──────────────────────────────────────────────────────────────

let caller: { id: string; email: string } | null = null;

vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async (req: Request) => {
    const header = req.headers.get("authorization") ?? "";
    return header.startsWith("Bearer ") && caller ? caller : null;
  }
}));

function lagRequest(body: Record<string, unknown>, token?: string): NextRequest {
  return new NextRequest("https://taoslite.com/api/call/lag", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
}

describe("POST /api/call/lag", () => {
  const ORIGINAL_FLAG = process.env.NEXT_PUBLIC_ENABLE_CALL;
  beforeEach(() => {
    caller = null;
    delete process.env.NEXT_PUBLIC_ENABLE_CALL;
  });
  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.NEXT_PUBLIC_ENABLE_CALL;
    else process.env.NEXT_PUBLIC_ENABLE_CALL = ORIGINAL_FLAG;
    vi.restoreAllMocks();
  });

  async function route() {
    return (await import("@/app/api/call/lag/route")).POST;
  }

  it("404s a non-founder and writes nothing", async () => {
    caller = { id: "u1", email: "customer@example.com" };
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const res = await (await route())(lagRequest({ room: "AB123", records: [] }, "tok"));
    expect(res.status).toBe(404);
    expect(info).not.toHaveBeenCalled();
  });

  it("writes one greppable line per record for a founder, and reports drops", async () => {
    caller = { id: "u2", email: "xdrabbit@gmail.com" };
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const records = [
      { kind: "session_reset", pair: "en->es", reason: "manual_resync", values: { session: 2 } },
      { kind: "turn", pair: "en->es", values: { turn: 1, heard_ms: 1016 } },
      { kind: "nonsense", values: {} }
    ];
    const res = await (await route())(
      lagRequest({ room: "AB123", records, dropped: 4 }, "tok")
    );
    expect(res.status).toBe(204);
    const lines = info.mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("[taos-call-lag] session_reset room=AB123 pair=en->es reason=manual_resync");
    expect(lines[1]).toContain("heard_ms=1016");
    expect(lines[2]).toBe("[taos-call-lag] dropped room=AB123 n=4");
  });
});

// ── The interpreter feeds it ───────────────────────────────────────────────

vi.mock("@/lib/tts/speech", () => ({
  requestSpeech: vi.fn(),
  isTextOnlyLanguage: () => false,
  TEXT_ONLY_TITLE: "Text only"
}));

vi.mock("@/lib/authClient", () => ({
  jsonAuthHeaders: async () => ({ "Content-Type": "application/json" }),
  authHeaders: async () => ({})
}));

describe("the interpreter's events become a turn line", () => {
  let clock = 0;
  let ctxSeconds = 0;
  let peer: { connectionState: string; onconnectionstatechange: (() => void) | null } | null;
  let dataChannel: {
    readyState: string;
    onmessage: ((ev: { data: string }) => void) | null;
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  const ORIGINAL_FETCH = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    clock = 0;
    ctxSeconds = 0;
    peer = null;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    dataChannel = { readyState: "open", onmessage: null, send: vi.fn(), close: vi.fn() };
    const g = globalThis as Record<string, unknown>;
    g.document = {
      createElement: () => ({
        style: {},
        pause: vi.fn(),
        play: vi.fn(async () => undefined),
        load: vi.fn(),
        remove: vi.fn(),
        removeAttribute: vi.fn()
      }),
      body: { appendChild: vi.fn() }
    };
    g.MediaStream = class {
      constructor(public tracks: unknown[] = []) {}
      getAudioTracks() {
        return this.tracks;
      }
      getTracks() {
        return this.tracks;
      }
    };
    const bridged = { kind: "audio", readyState: "live", stop: vi.fn() };
    g.AudioContext = class {
      state = "running";
      get currentTime() {
        return ctxSeconds;
      }
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      createMediaStreamDestination() {
        return {
          disconnect: vi.fn(),
          stream: { getAudioTracks: () => [bridged], getTracks: () => [bridged] }
        };
      }
      async resume() {}
      async close() {}
    };
    g.RTCPeerConnection = class {
      onconnectionstatechange: (() => void) | null = null;
      ontrack = null;
      connectionState = "new";
      constructor() {
        peer = this;
      }
      createDataChannel() {
        return dataChannel;
      }
      addTrack() {}
      async getStats() {
        return new Map();
      }
      async createOffer() {
        return { type: "offer", sdp: "v=0" };
      }
      async setLocalDescription() {}
      async setRemoteDescription() {}
      close() {}
    };
    g.window = globalThis;
    globalThis.fetch = vi.fn(async (input: unknown) =>
      String(input).includes("/api/call/realtime")
        ? new Response(
            JSON.stringify({
              clientSecret: "ek_test",
              callUrl: "https://api.openai.com/v1/realtime/calls",
              model: "gpt-realtime",
              voice: "marin",
              mode: "clone"
            }),
            { status: 200 }
          )
        : new Response("v=0\r\n", { status: 200 })
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it("measures the bridge's clock, OpenAI's audio clock, and the response", async () => {
    const lines: string[] = [];
    const log = createCallLagLog({
      room: "AB123",
      pair: () => "es->en",
      now: () => clock,
      echo: (line) => lines.push(line),
      send: async () => {},
      flushIntervalMs: 0
    });
    const { startCallInterpreter } = await import("@/lib/call/interpreter");
    const partner = { kind: "audio", readyState: "live", stop: vi.fn() };
    const interpreter = await startCallInterpreter(
      {
        direction: { source: "es", target: "en" },
        inputTrack: partner as unknown as MediaStreamTrack,
        voiceMode: "clone",
        lag: log.session()
      },
      {}
    );
    const send = (payload: Record<string, unknown>) =>
      dataChannel.onmessage?.({ data: JSON.stringify(payload) });

    clock = 1000;
    ctxSeconds = 1;
    if (!peer) throw new Error("no peer connection");
    peer.connectionState = "connected";
    peer.onconnectionstatechange?.();

    // A minute in, the graph has rendered 500ms less audio than wall time.
    clock = 61_000;
    ctxSeconds = 60.5;
    send({ type: "input_audio_buffer.speech_stopped", item_id: "i1", audio_end_ms: 59_000 });
    clock = 61_400;
    send({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "i1",
      transcript: "hola amigo"
    });
    expect(dataChannel.send.mock.calls.map((c) => String(c[0]))).toContain(
      JSON.stringify({ type: "response.create" })
    );
    clock = 61_420;
    log.heardRendered();
    clock = 62_000;
    send({ type: "response.output_text.delta", delta: "hello" });
    clock = 62_500;
    send({ type: "response.done", response: { usage: {} } });

    const turn = turnLines(lines)[0];
    expect(field(turn, "audio_arrival_ms")).toBe("500");
    expect(field(turn, "vad_lag_ms")).toBe("1000");
    expect(field(turn, "transcription_ms")).toBe("400");
    expect(field(turn, "heard_ms")).toBe("1420");
    expect(field(turn, "gate_ms")).toBe("0");
    expect(field(turn, "wait_ms")).toBe("600");
    expect(field(turn, "generation_ms")).toBe("500");

    // Stopping the interpreter closes its session in the log.
    await interpreter.stop();
    const next = log.session();
    clock = 70_000;
    next.opened();
    expect(field(lines.at(-1), "prev_turns")).toBe("1");
  });
});

// ── The screen ─────────────────────────────────────────────────────────────

/** Source minus commentary, as tests/call-rejoin.test.ts reads it. */
function shellCode(): string {
  return readFileSync(new URL("../components/CallShell.tsx", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\s*\}/g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

describe("Resync, any time during a call", () => {
  it("is drawn whenever the interpreter could be rebuilt, not only after an auto-end", () => {
    const src = shellCode();
    expect(src).toContain("↻ Resync · Resincronizar");
    expect(src).toContain('{!autoEnded && interpreterStatus !== "not_needed" ? (');
  });

  it("is a fingertip, and a secondary one", () => {
    const src = shellCode();
    const button = src.slice(src.indexOf("onClick={resyncInterpreter}"));
    const markup = button.slice(0, button.indexOf("</button>"));
    expect(markup).toContain("min-h-[44px]");
    // Not the filled amber of a primary control.
    expect(markup).not.toContain("bg-amber-400");
    expect(markup).toContain('disabled={interpreterStatus === "starting"}');
    // Below Hang up, never in the control grid a thumb works mid-sentence.
    expect(src.indexOf("onClick={resyncInterpreter}")).toBeGreaterThan(src.indexOf("onClick={endCall}"));
  });

  it("reuses rejoinInterpreter, logs the press, and ignores a press mid-rebuild", () => {
    const src = shellCode();
    const fn = src.slice(src.indexOf("const resyncInterpreter"));
    const body = fn.slice(0, fn.indexOf("}, [rejoinInterpreter]);"));
    expect(body).toContain("if (startingRef.current) return;");
    // The guard comes first, so an ignored press never reaches the log.
    expect(body.indexOf("startingRef.current")).toBeLessThan(body.indexOf("manualResync()"));
    expect(body).toContain("rejoinInterpreter()");
    expect(body).not.toContain("endCall");
    expect(body).not.toMatch(/\bjoin\(/);
  });

  it("wires the telemetry through a call without resetting it on a rejoin", () => {
    const src = shellCode();
    // One log per call, handed a fresh session per interpreter.
    expect(src).toContain("lag: lagLogRef.current?.session()");
    expect(src).toContain("lagLogRef.current = createCallLagLog(");
    expect(src).toContain("lagLogRef.current?.end();");
    // heard_ms is taken when the heard line is committed, not when it arrived.
    expect(src).toMatch(
      /useEffect\(\(\) => \{\s*if \(liveHeard !== null\) lagLogRef\.current\?\.heardRendered\(\);\s*\}, \[liveHeard\]\);/
    );
  });
});
