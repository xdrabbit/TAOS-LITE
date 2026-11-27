// POST /api/dictate, as the iOS app (`taos-dictate`) will call it.
//
// Tom, 2026-11-27: the native app signs in to the SAME Supabase project and
// sends `Authorization: Bearer <Supabase access token>`. This file runs the
// real route, the real guardSpend and the real lib/authServer.ts — only the
// Supabase client and the provider `fetch` are faked — so what is pinned is
// the whole path from the header to the answer:
//
//   · a founder's valid token              → 200
//   · a valid token, not a founder         → 404
//   · a bad, expired or forged token       → 401
//   · no token at all (or only a cookie)   → 401
//
// and that every refusal happens before a provider is called. The website
// sends the very same header (lib/authClient.ts): there is one way in.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { serializePrior } from "@/lib/translate/longTurn";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const FOUNDER_TOKEN = "founder.access.token";
const LIZ_TOKEN = "liz.access.token";
const STRANGER_TOKEN = "stranger.access.token";
const EXPIRED_TOKEN = "expired.access.token";

const USERS: Record<string, { id: string; email: string }> = {
  [FOUNDER_TOKEN]: { id: "u-tom", email: "xdrabbit@gmail.com" },
  [LIZ_TOKEN]: { id: "u-liz", email: "lizmariett@gmail.com" },
  [STRANGER_TOKEN]: { id: "u-x", email: "stranger@example.com" }
};

const verified: string[] = [];
const clientOptions: unknown[] = [];

vi.mock("@supabase/supabase-js", () => ({
  createClient: (_url: string, _key: string, options: unknown) => {
    clientOptions.push(options);
    return {
      auth: {
        // What Supabase's own /auth/v1/user answers: the user for a token it
        // issued and that is still alive, an error for anything else.
        getUser: async (token: string) => {
          verified.push(token);
          const user = USERS[token];
          return user
            ? { data: { user }, error: null }
            : { data: { user: null }, error: { message: "invalid JWT: token is expired", status: 403 } };
        }
      }
    };
  }
}));

const STT = "https://api.openai.com/v1/audio/transcriptions";
const CHAT = "https://api.openai.com/v1/chat/completions";
let providerCalls: string[] = [];
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_FLAG = process.env.NEXT_PUBLIC_ENABLE_DICTATE;

beforeEach(() => {
  verified.length = 0;
  clientOptions.length = 0;
  providerCalls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    providerCalls.push(url);
    if (url === STT) return Response.json({ text: "the meeting is Wednesday" });
    if (url === CHAT) {
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                source_language: "Spanish",
                cleaned: "Hola, ¿cómo estás?",
                translation: "Hi, how are you?",
                notes: []
              })
            }
          }
        ]
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
  process.env.OPENAI_API_KEY = "sk-test";
  delete process.env.NEXT_PUBLIC_ENABLE_DICTATE;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_FLAG === undefined) delete process.env.NEXT_PUBLIC_ENABLE_DICTATE;
  else process.env.NEXT_PUBLIC_ENABLE_DICTATE = ORIGINAL_FLAG;
  vi.restoreAllMocks();
});

async function post(req: NextRequest): Promise<Response> {
  const { POST } = await import("@/app/api/dictate/route");
  return POST(req);
}

type Headers = Record<string, string>;
const bearer = (token: string): Headers => ({ Authorization: `Bearer ${token}` });

function multipart(headers: Headers, fields: Record<string, string>): NextRequest {
  const form = new FormData();
  form.append("audio", new File([new Uint8Array(2048)], "audio.m4a", { type: "audio/mp4" }));
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return new NextRequest("http://localhost/api/dictate", { method: "POST", headers, body: form });
}

function json(headers: Headers, body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/dictate", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

/** Every request the app's first version makes, with the given headers. */
const everyRequest = (headers: Headers): Record<string, NextRequest> => ({
  speak: multipart(headers, { style: "professional", source: "en", target: "same" }),
  "chunk part": multipart(headers, { source: "en", chunk_part: "1", chunk_index: "0", chunk_ms: "270000" }),
  "chunk final": multipart(headers, {
    style: "professional",
    source: "en",
    prior: serializePrior([{ text: "the first chunk", ms: 270000 }]),
    chunk_index: "1",
    chunk_ms: "30000"
  }),
  restyle: json(headers, { raw: "um the meeting is Wednesday", style: "casual", source: "en" }),
  decoder: json(headers, { mode: "decode", raw: "hola como estas", reader: "en", other: "es" })
});

describe("Authorization: Bearer <Supabase access token> — the app's way in", () => {
  it("lets a founder's valid token through on every request the app makes", async () => {
    for (const [name, req] of Object.entries(everyRequest(bearer(FOUNDER_TOKEN)))) {
      const res = await post(req);
      expect(res.status, name).toBe(200);
    }
    // Verified with Supabase, server-side, on every request — never trusted.
    expect(verified).toEqual(Array(5).fill(FOUNDER_TOKEN));
  });

  it("answers with the shapes the contract promises", async () => {
    const requests = everyRequest(bearer(LIZ_TOKEN));
    const speak = await (await post(requests.speak)).json();
    expect(Object.keys(speak).sort()).toEqual(["lang", "raw", "style", "styled"]);
    const part = await (await post(requests["chunk part"])).json();
    expect(part).toEqual({ chunk: { index: 0, text: "the meeting is Wednesday", ms: 270000 } });
    const final = await (await post(requests["chunk final"])).json();
    expect(Object.keys(final).sort()).toEqual(["chunks", "lang", "lost", "raw", "style", "styled"]);
    const decoded = await (await post(requests.decoder)).json();
    expect(Object.keys(decoded).sort()).toEqual(["cleaned", "mode", "notes", "raw", "sourceLanguage", "translation"]);
  });

  it("answers a valid token that is NOT a founder's with 404, having spent nothing", async () => {
    for (const [name, req] of Object.entries(everyRequest(bearer(STRANGER_TOKEN)))) {
      const res = await post(req);
      expect(res.status, name).toBe(404);
      expect(await res.json(), name).toEqual({ error: "not_found" });
    }
    expect(verified).toHaveLength(5);
    expect(providerCalls).toHaveLength(0);
  });

  it("answers a bad or expired token with 401, having spent nothing", async () => {
    // Shaped like a JWT, signed by nobody. Assembled here so a secret scanner
    // does not read a fixture as a leaked token.
    const forged = ["header", "payload", "signature"].join(".");
    for (const token of [EXPIRED_TOKEN, "garbage", forged]) {
      for (const [name, req] of Object.entries(everyRequest(bearer(token)))) {
        const res = await post(req);
        expect(res.status, `${name} / ${token}`).toBe(401);
        expect(typeof (await res.json()).error).toBe("string");
      }
    }
    expect(providerCalls).toHaveLength(0);
  });

  it("answers a missing token with 401 — and a cookie, Basic auth or an empty Bearer is a missing token", async () => {
    const without: Headers[] = [
      {},
      { Cookie: "sb-access-token=founder.access.token; sb-refresh-token=r" },
      { Authorization: `Basic ${btoa("someone:not-a-real-password")}` },
      { Authorization: "Bearer " },
      { Authorization: FOUNDER_TOKEN }
    ];
    for (const headers of without) {
      for (const [name, req] of Object.entries(everyRequest(headers))) {
        const res = await post(req);
        expect(res.status, `${name} / ${JSON.stringify(headers)}`).toBe(401);
      }
    }
    // Nothing to verify, so Supabase is not even asked — and nothing is spent.
    expect(verified).toHaveLength(0);
    expect(providerCalls).toHaveLength(0);
  });

  it("is 401 before 404 whether or not the flag is public: a client can always tell them apart", async () => {
    for (const flag of [undefined, "1"]) {
      if (flag) process.env.NEXT_PUBLIC_ENABLE_DICTATE = flag;
      expect((await post(everyRequest({}).speak)).status).toBe(401);
      expect((await post(everyRequest(bearer(EXPIRED_TOKEN)).restyle)).status).toBe(401);
    }
    // With the flag public, any signed-in person is let in.
    expect((await post(everyRequest(bearer(STRANGER_TOKEN)).restyle)).status).toBe(200);
  });

  it("verifies on the server without keeping a session there", () => {
    return post(everyRequest(bearer(FOUNDER_TOKEN)).restyle).then(() => {
      expect(clientOptions[0]).toEqual({ auth: { persistSession: false, autoRefreshToken: false } });
    });
  });

  it("never caches an answer and opens no CORS — a native app needs none", async () => {
    for (const headers of [bearer(FOUNDER_TOKEN), bearer(STRANGER_TOKEN), {}]) {
      const res = await post(
        json({ ...headers, Origin: "https://evil.example" }, { raw: "hi there", style: "casual", source: "en" })
      );
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    }
    const route = read("app/api/dictate/route.ts").replace(/^\s*\/\/.*$/gm, "");
    expect(route).not.toMatch(/Access-Control-/i);
    expect(route).not.toContain("export async function OPTIONS");
    expect(route).not.toContain("cookies()");
  });

  it("the web screen sends the same header — there is one way in", () => {
    expect(read("lib/authClient.ts")).toContain("{ Authorization: `Bearer ${token}` }");
    const shell = read("components/DictateShell.tsx");
    expect(shell).toContain("headers: await authHeaders()");
    expect(shell).toContain("headers: await jsonAuthHeaders()");
    expect(shell).not.toContain('credentials: "include"');
  });
});
