// Share branding (Tom, 2026-10-24): the file the home card's Share hands over
// says where it came from, and — free tier, flag on — ends with a spoken
// sign-off.
//
// Pinned here:
//   1. The filename: `TAOS · <target native name> · taoslite.com.mp3`.
//   2. The ID3v2.3 tag: title (first ~60 chars), artist TAOS·LITE, album
//      taoslite.com, COMM + WXXX https://taoslite.com/try, APIC app icon.
//   3. The sign-off ONLY when TAOS_SHARE_SIGNOFF=1 AND the sender is not a
//      subscriber AND the request is the Share (surface home-share, body
//      signoff:true). The Play path never gets one.
//   4. The join is a valid stream: line, 150 ms of silence, sign-off, with a
//      Xing frame counting all of it; a rate mismatch skips the sign-off.
//   5. Share taps are counted as a `[taos-share]` line with no text.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { existingTagLength, id3v2Tag, tagMp3 } from "@/lib/tts/id3";
import { audioFrames, paddingFrames, parseFrame } from "@/lib/tts/mp3";
import {
  SHARE_TAG_ALBUM,
  SHARE_TAG_ARTIST,
  SHARE_TAG_URL,
  brandSharedAudio,
  logShareTap,
  shareAudioFile,
  shareFileName,
  shareTagTitle,
  shareText,
  type ShareAudioEnvironment
} from "@/lib/tts/shareAudio";
import {
  SIGNOFF_AVAILABLE_HEADER,
  SIGNOFF_GAP_MS,
  SIGNOFF_HEADER,
  appendSignoff,
  clearSignoffCache,
  shareSignoffEnabled,
  signoffClip,
  signoffPhrase,
  withSignoff
} from "@/lib/tts/shareSignoff";
import { TTS_SURFACE_HEADER } from "@/lib/tts/deviceHints";

// ── Route dependencies ──────────────────────────────────────────────────────
let currentUser: { id: string; email: string } | null = { id: "free-1", email: "free@example.com" };
vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async () => currentUser
}));
vi.mock("@vercel/functions", () => ({ waitUntil: () => undefined }));

let profileRow: { subscription_status: string; tier: string } | null = {
  subscription_status: "free",
  tier: "free"
};
vi.mock("@/lib/supabaseAdmin", () => ({
  hasServiceRoleKey: true,
  supabaseAdmin: {
    from: (table: string) => ({
      insert: () => ({ abortSignal: async () => ({ error: null }) }),
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            table === "profiles" ? { data: profileRow, error: null } : { data: null, error: null }
        })
      })
    }),
    rpc: async () => ({ data: null, error: null })
  }
}));

// ── Synthetic MPEG-2 Layer III frames (24 kHz mono 32 kbps, like Google) ────
const HEADER_24K = [0xff, 0xf3, 0x44, 0xc4];
const HEADER_44K = [0xff, 0xfb, 0x90, 0xc4]; // MPEG-1, 128 kbps, 44.1 kHz, mono

function frame(header: number[], gain: number): Uint8Array {
  const f = parseFrame(new Uint8Array(header), 0)!;
  const out = new Uint8Array(f.length);
  out.set(header, 0);
  // global_gain sits after main_data_begin + private + part2_3_length + big_values.
  const bit = (f.version === 1 ? 9 + 5 + 4 : 8 + 1) + 12 + 9;
  for (let i = 0; i < 8; i += 1) {
    const pos = 32 + bit + i;
    if ((gain >> (7 - i)) & 1) out[pos >> 3] |= 1 << (7 - (pos & 7));
  }
  return out;
}

function stream(header: number[], gains: number[]): Uint8Array {
  const frames = gains.map((g) => frame(header, g));
  const out = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
  let at = 0;
  for (const f of frames) {
    out.set(f, at);
    at += f.length;
  }
  return out;
}

const LINE = () => stream(HEADER_24K, Array(40).fill(170));
// 20 frames of lead-in hiss, 30 of speech, 20 of tail — Google's shape.
const GOOGLE_CLIP = () => stream(HEADER_24K, [...Array(20).fill(137), ...Array(30).fill(170), ...Array(20).fill(137)]);

/** Parse ID3v2.3 frames back out of a tag. */
function readTag(bytes: Uint8Array): Map<string, Uint8Array> {
  expect(String.fromCharCode(bytes[0], bytes[1], bytes[2])).toBe("ID3");
  expect(bytes[3]).toBe(3);
  const end = existingTagLength(bytes);
  const frames = new Map<string, Uint8Array>();
  let at = 10;
  while (at + 10 <= end && bytes[at] !== 0) {
    const id = String.fromCharCode(...bytes.subarray(at, at + 4));
    const size = new DataView(bytes.buffer, bytes.byteOffset + at + 4, 4).getUint32(0);
    frames.set(id, bytes.subarray(at + 10, at + 10 + size));
    at += 10 + size;
  }
  return frames;
}

function text(body: Uint8Array): string {
  if (body[0] === 0) return new TextDecoder("latin1").decode(body.subarray(1));
  return new TextDecoder("utf-16le").decode(body.subarray(3)); // skip encoding + BOM
}

const savedEnv = { ...process.env };
const originalFetch = globalThis.fetch;

beforeEach(() => {
  clearSignoffCache();
  currentUser = { id: "free-1", email: "free@example.com" };
  profileRow = { subscription_status: "free", tier: "free" };
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...savedEnv };
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("shared file name", () => {
  it("is TAOS · <target native name> · taoslite.com.mp3", () => {
    expect(shareFileName("es")).toBe("TAOS · Español · taoslite.com.mp3");
    expect(shareFileName("en")).toBe("TAOS · English · taoslite.com.mp3");
    expect(shareFileName("ja")).toBe("TAOS · 日本語 · taoslite.com.mp3");
  });

  it("is the same name on the download fallback", async () => {
    const anchor = { href: "", download: "", hidden: false, click: vi.fn(), remove: vi.fn() };
    const env: ShareAudioEnvironment = {
      navigator: { canShare: () => false, share: vi.fn() },
      document: {
        body: { appendChild: vi.fn() } as unknown as HTMLElement,
        createElement: (() => anchor) as unknown as Document["createElement"]
      },
      url: { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined }
    };
    await shareAudioFile(new Blob([new Uint8Array([1])], { type: "audio/mpeg" }), {
      fileName: shareFileName("es"),
      title: "TAOS · Español"
    }, env);
    expect(anchor.download).toBe("TAOS · Español · taoslite.com.mp3");
  });
});

describe("share text", () => {
  it("is the translated line plus — taoslite.com, passed beside the file", async () => {
    expect(shareText("Hola")).toBe("Hola\n— taoslite.com");
    const share = vi.fn(async (_d: ShareData) => undefined);
    const env = {
      navigator: { canShare: () => true, share },
      document: {} as ShareAudioEnvironment["document"],
      url: {} as ShareAudioEnvironment["url"]
    } as ShareAudioEnvironment;
    await shareAudioFile(new Blob([new Uint8Array([1])]), { fileName: "a.mp3", title: "t", text: shareText("Hola") }, env);
    expect(share.mock.calls[0][0]).toMatchObject({ title: "t", text: "Hola\n— taoslite.com" });
    expect(share.mock.calls[0][0].files).toHaveLength(1);
  });
});

describe("ID3 tag on the shared file", () => {
  const cover = new Uint8Array(readFileSync(join(process.cwd(), "public/icons/icon-192.png")));

  it("carries title, TAOS·LITE, taoslite.com, the /try URL and the app icon", async () => {
    const audio = LINE();
    const blob = await brandSharedAudio(
      new Blob([audio as BlobPart], { type: "audio/mpeg" }),
      "¿Dónde está la estación de tren más cercana?",
      cover
    );
    expect(blob.type).toBe("audio/mpeg");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const frames = readTag(bytes);

    expect(text(frames.get("TIT2")!)).toBe("¿Dónde está la estación de tren más cercana?");
    expect(frames.get("TPE1")![0]).toBe(0); // Latin-1: the middle dot fits
    expect(text(frames.get("TPE1")!)).toBe("TAOS·LITE");
    expect(SHARE_TAG_ARTIST).toBe("TAOS·LITE");
    expect(text(frames.get("TALB")!)).toBe(SHARE_TAG_ALBUM);
    expect(SHARE_TAG_ALBUM).toBe("taoslite.com");
    expect(SHARE_TAG_URL).toBe("https://taoslite.com/try");

    const comm = frames.get("COMM")!;
    expect(String.fromCharCode(...comm.subarray(1, 4))).toBe("eng");
    expect(new TextDecoder("latin1").decode(comm.subarray(5))).toBe(SHARE_TAG_URL);
    expect(new TextDecoder("latin1").decode(frames.get("WXXX")!.subarray(2))).toBe(SHARE_TAG_URL);

    const apic = frames.get("APIC")!;
    const mime = "image/png";
    expect(new TextDecoder("latin1").decode(apic.subarray(1, 1 + mime.length))).toBe(mime);
    expect(apic[1 + mime.length + 1]).toBe(0x03); // front cover
    expect(apic.subarray(1 + mime.length + 3)).toEqual(cover);
    expect(cover.length).toBeLessThanOrEqual(20 * 1024);

    // The audio after the tag is byte-for-byte what came in.
    expect(bytes.subarray(existingTagLength(bytes))).toEqual(audio);
  });

  it("writes UTF-16 for a line outside Latin-1, and cuts the title near 60 characters", () => {
    const long = "这是一个非常长的句子，".repeat(10);
    const frames = readTag(id3v2Tag({ title: shareTagTitle(long), artist: "a", album: "b", url: "c" }));
    expect(frames.get("TIT2")![0]).toBe(1);
    const title = text(frames.get("TIT2")!);
    expect(Array.from(title)).toHaveLength(60);
    expect(title.endsWith("…")).toBe(true);
    expect(shareTagTitle("Hola")).toBe("Hola");
    expect(frames.has("APIC")).toBe(false); // no cover given, no APIC
  });

  it("replaces a tag the audio already carried instead of stacking two", () => {
    const once = tagMp3(LINE(), { title: "one", artist: "a", album: "b", url: "c" });
    const twice = tagMp3(once, { title: "two", artist: "a", album: "b", url: "c" });
    expect(text(readTag(twice).get("TIT2")!)).toBe("two");
    expect(twice.subarray(existingTagLength(twice))).toEqual(LINE());
  });
});

describe("sign-off decision", () => {
  const synth = vi.fn(async () => GOOGLE_CLIP());
  const free = async () => false;
  const paying = async () => true;
  const ask = { requested: true, userId: "u1", target: "es" };

  beforeEach(() => synth.mockClear());

  it("is off unless TAOS_SHARE_SIGNOFF is exactly 1", () => {
    expect(shareSignoffEnabled(undefined)).toBe(false);
    expect(shareSignoffEnabled("0")).toBe(false);
    expect(shareSignoffEnabled("true")).toBe(false);
    expect(shareSignoffEnabled("1")).toBe(true);
  });

  it("appends only for flag on AND non-subscriber AND a share request", async () => {
    const line = LINE();
    const on = await withSignoff(line, ask, { enabled: true, isSubscriber: free, synth });
    expect(on.signed).toBe(true);
    expect(on.audio.length).toBeGreaterThan(line.length);

    for (const [decision, deps] of [
      [ask, { enabled: false, isSubscriber: free, synth }],
      [ask, { enabled: true, isSubscriber: paying, synth }],
      [{ ...ask, requested: false }, { enabled: true, isSubscriber: free, synth }],
      [{ ...ask, userId: null }, { enabled: true, isSubscriber: free, synth }]
    ] as const) {
      const r = await withSignoff(line, decision, deps);
      expect(r.signed).toBe(false);
      expect(r.audio).toBe(line);
    }
  });

  it("returns the clean line when the sign-off cannot be made", async () => {
    const line = LINE();
    const failing = await withSignoff(line, ask, { enabled: true, isSubscriber: free, synth: async () => null });
    expect(failing).toMatchObject({ signed: false, skipped: "signoff_synth" });
    expect(failing.audio).toBe(line);
    const notMp3 = new Uint8Array([1, 2, 3]);
    expect(await withSignoff(notMp3, ask, { enabled: true, isSubscriber: free, synth })).toMatchObject({
      signed: false,
      audio: notMp3
    });
  });

  it("says Traducido con TAOS for Spanish and the English sign-off for everything else, in Kore", () => {
    expect(signoffPhrase("es")).toMatchObject({ text: "Traducido con TAOS", voice: { voiceName: "es-US-Chirp3-HD-Kore" } });
    expect(signoffPhrase("en")).toMatchObject({ text: "Translated with TAOS", voice: { voiceName: "en-US-Chirp3-HD-Kore" } });
    expect(signoffPhrase("fr").text).toBe("Translated with TAOS");
    expect(signoffPhrase("ja").text).toBe("Translated with TAOS");
  });

  it("synthesizes each sign-off once per language and rate, then serves it from cache", async () => {
    await signoffClip("es", 24000, synth);
    await signoffClip("es", 24000, synth);
    await signoffClip("fr", 24000, synth);
    await signoffClip("en", 24000, synth); // same English clip as fr
    expect(synth).toHaveBeenCalledTimes(2);
    await signoffClip("es", 44100, synth);
    expect(synth).toHaveBeenCalledTimes(3);
  });

  it("does not cache a failed synthesis", async () => {
    const flaky = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(GOOGLE_CLIP());
    expect(await signoffClip("es", 24000, flaky)).toBeNull();
    expect(await signoffClip("es", 24000, flaky)).not.toBeNull();
  });
});

describe("joining line and sign-off", () => {
  it("is [Xing][line][150 ms silence][sign-off] with the padding trimmed", async () => {
    const clipRaw = GOOGLE_CLIP();
    const clipFrames = audioFrames(clipRaw);
    const { lead, trail } = paddingFrames(clipRaw, clipFrames);
    expect(lead).toBeGreaterThan(0);
    expect(lead).toBeLessThan(20); // a margin of hiss is kept before speech
    expect(trail).toBeGreaterThan(0);
    expect(trail).toBeLessThan(20);

    const clip = await signoffClip("es", 24000, async () => clipRaw);
    const joined = appendSignoff(LINE(), clip!)!;
    const frames = audioFrames(joined); // the Xing frame is skipped as metadata
    const silence = Math.ceil((SIGNOFF_GAP_MS / 1000) * (24000 / 576));
    const clipCount = 70 - lead - trail;
    expect(frames).toHaveLength(40 + silence + clipCount);
    expect(String.fromCharCode(...joined.subarray(4 + 9, 4 + 9 + 4))).toBe("Xing");
    const view = new DataView(joined.buffer, joined.byteOffset);
    expect(view.getUint32(4 + 9 + 8)).toBe(frames.length);
    expect(view.getUint32(4 + 9 + 12)).toBe(joined.length);
    expect(frames.every((f) => f.sampleRate === 24000)).toBe(true);
  });

  it("refuses to join two sample rates", () => {
    expect(appendSignoff(stream(HEADER_44K, Array(10).fill(170)), GOOGLE_CLIP())).toBeNull();
  });
});

// ── The route ──────────────────────────────────────────────────────────────
const { POST } = await import("@/app/api/tts/route");
const { POST: SHARE } = await import("@/app/api/tts/share/route");

function ttsRequest(surface: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest("https://taoslite.com/api/tts", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-token",
      [TTS_SURFACE_HEADER]: surface
    },
    body: JSON.stringify({ text: "Hola", engine: "openai", targetLanguage: "es", sourceLanguage: "en", ...body })
  });
}

describe("/api/tts sign-off", () => {
  let googleCalls = 0;
  beforeEach(() => {
    googleCalls = 0;
    process.env.OPENAI_API_KEY = "test-openai";
    process.env.GOOGLE_TTS_API_KEY = "test-google";
    process.env.TAOS_SHARE_SIGNOFF = "1";
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("texttospeech.googleapis.com")) {
        googleCalls += 1;
        return Response.json({ audioContent: Buffer.from(GOOGLE_CLIP()).toString("base64") });
      }
      return new Response(LINE() as BodyInit, { status: 200 });
    }) as unknown as typeof fetch;
  });

  it("signs a free-tier Share and says so", async () => {
    const res = await POST(ttsRequest("home-share", { signoff: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get(SIGNOFF_HEADER)).toBe("1");
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(LINE().length);
    expect(googleCalls).toBe(1);
  });

  it("never signs the Play path, even when the flag is on and the caller is free tier", async () => {
    const play = await POST(ttsRequest("home", {}));
    expect(play.headers.get(SIGNOFF_HEADER)).toBeNull();
    expect(new Uint8Array(await play.arrayBuffer())).toEqual(LINE());
    // Asking from the Play surface does not count as asking.
    const sneaky = await POST(ttsRequest("home", { signoff: true }));
    expect(new Uint8Array(await sneaky.arrayBuffer())).toEqual(LINE());
    expect(googleCalls).toBe(0);
  });

  it("tells the home screen the sign-off is available only while the flag is on", async () => {
    expect((await POST(ttsRequest("home", {}))).headers.get(SIGNOFF_AVAILABLE_HEADER)).toBe("1");
    expect((await POST(ttsRequest("live", {}))).headers.get(SIGNOFF_AVAILABLE_HEADER)).toBeNull();
    process.env.TAOS_SHARE_SIGNOFF = "0";
    expect((await POST(ttsRequest("home", {}))).headers.get(SIGNOFF_AVAILABLE_HEADER)).toBeNull();
  });

  it("gives a subscriber the clean file", async () => {
    profileRow = { subscription_status: "active", tier: "basic" };
    const res = await POST(ttsRequest("home-share", { signoff: true }));
    expect(res.headers.get(SIGNOFF_HEADER)).toBe("0");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(LINE());
    expect(googleCalls).toBe(0);
  });

  it("gives the clean file when the flag is off", async () => {
    process.env.TAOS_SHARE_SIGNOFF = "0";
    const res = await POST(ttsRequest("home-share", { signoff: true }));
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(LINE());
    expect(googleCalls).toBe(0);
  });
});

describe("the Play path in the home screen", () => {
  const shell = readFileSync(join(process.cwd(), "components/TranslatorShell.tsx"), "utf8");
  it("asks for a sign-off in exactly one place: the Share's audioForShare", () => {
    const asks = shell.match(/signoff: true/g) ?? [];
    expect(asks).toHaveLength(1);
    const share = shell.slice(shell.indexOf("async function audioForShare"), shell.indexOf("async function shareTranslationAudio"));
    expect(share).toContain("signoff: true");
    const speak = shell.slice(shell.indexOf("async function speak("), shell.indexOf("async function audioForShare"));
    expect(speak).not.toContain("signoff");
  });

  it("never puts a signed file into Play's cache", () => {
    const share = shell.slice(shell.indexOf("async function audioForShare"), shell.indexOf("async function shareTranslationAudio"));
    expect(share).toMatch(/if \(!signed && !existing\) \{\s*resultAudioRef\.current = blob;/);
  });
});

// ── Counting share taps ─────────────────────────────────────────────────────
describe("share tap counting", () => {
  it("posts result, language, sign-off, tier and payload configuration", () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    logShareTap(
      {
        result: "shared",
        lang: "es",
        signoff: true,
        subscriber: false,
        files: 1,
        text: false,
        cover: true
      },
      { authorization: "Bearer t" },
      fetchImpl as unknown as typeof fetch
    );
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/tts/share");
    expect(JSON.parse(String(init.body))).toEqual({
      result: "shared",
      lang: "es",
      signoff: true,
      subscriber: false,
      files: 1,
      text: false,
      cover: true
    });
    expect(init.keepalive).toBe(true);
  });

  it("never throws when the count cannot be sent", () => {
    expect(() =>
      logShareTap(
        {
          result: "cancelled",
          lang: "es",
          signoff: false,
          subscriber: false,
          files: 1,
          text: false,
          cover: false
        },
        {},
        (() => {
          throw new Error("offline");
        }) as unknown as typeof fetch
      )
    ).not.toThrow();
  });

  const shareReq = (body: unknown) =>
    new NextRequest("https://taoslite.com/api/tts/share", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer t" },
      body: JSON.stringify(body)
    });

  it("logs one [taos-share] line per tap for shared, downloaded and cancelled", async () => {
    for (const result of ["shared", "downloaded", "cancelled"]) {
      const res = await SHARE(
        shareReq({
          result,
          lang: "es",
          signoff: result === "shared",
          subscriber: false,
          files: 1,
          text: result === "shared" ? true : "secret words",
          cover: result === "shared"
        })
      );
      expect(res.status).toBe(204);
    }
    const lines = (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(lines).toEqual([
      "[taos-share] result=shared lang=es signoff=1 subscriber=0 files=1 text=1 cover=1",
      "[taos-share] result=downloaded lang=es signoff=0 subscriber=0 files=1 text=0 cover=0",
      "[taos-share] result=cancelled lang=es signoff=0 subscriber=0 files=1 text=0 cover=0"
    ]);
    expect(lines.join(" ")).not.toContain("secret");
    expect(lines.join(" ")).not.toContain("free@example.com");
  });

  it("refuses an unknown result and a signed-out caller", async () => {
    expect((await SHARE(shareReq({ result: "exploded", lang: "es" }))).status).toBe(400);
    currentUser = null;
    expect((await SHARE(shareReq({ result: "shared", lang: "es" }))).status).toBe(401);
  });
});
