// The route that hands a phone a relay it can spend bandwidth on.
//
// Field report 2026-08-31: Tom and Liz, both founders, could not connect
// /call phone to phone. The first cause was that there was no relay to fall
// back to at all — lib/call/session.ts asked for one public STUN server, and
// STUN cannot carry a packet across two carrier NATs.
//
// This file is the fence around the fix. Three things have to stay true, and
// each of them has a way of quietly stopping being true:
//
//   1. It is FOUNDERS ONLY, and the refusal happens before Cloudflare is
//      called. Relay bandwidth is money (CLAUDE.md: guardSpend first), so a
//      404 issued after minting a credential is the same bill with better
//      manners — the credential is good for an hour whatever the response
//      said.
//   2. The credential is SHORT-LIVED and minted server-side. The path this
//      replaces read NEXT_PUBLIC_TURN_* — inlined into the browser bundle at
//      build time, i.e. a free relay for anyone who reads view-source. The
//      API token must never appear in a response body.
//   3. An unconfigured or broken relay DEGRADES to STUN with a 200. Today's
//      production has no Cloudflare key, and /call must be exactly as good as
//      it is now until Tom creates one — never worse.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

let caller: { id: string; email: string } | null = null;

vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async (req: Request) => {
    const header = req.headers.get("authorization") ?? "";
    return header.startsWith("Bearer ") && caller ? caller : null;
  }
}));

const CLOUDFLARE_REPLY = {
  iceServers: [
    { urls: ["stun:stun.cloudflare.com:3478"] },
    {
      urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:5349?transport=tcp"],
      username: "minted-user",
      credential: "minted-secret"
    }
  ]
};

// Stands in for Cloudflare. If this is touched for a non-founder, the gate
// leaks a credential that stays good long after the 404 was returned.
const fetchSpy = vi.fn(
  async () =>
    new Response(JSON.stringify(CLOUDFLARE_REPLY), {
      status: 201,
      headers: { "Content-Type": "application/json" }
    })
);

const ORIGINAL_FETCH = globalThis.fetch;
const SAVED = {
  keyId: process.env.CLOUDFLARE_TURN_KEY_ID,
  token: process.env.CLOUDFLARE_TURN_API_TOKEN,
  flag: process.env.NEXT_PUBLIC_ENABLE_CALL
};

beforeEach(() => {
  caller = null;
  fetchSpy.mockClear();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  process.env.CLOUDFLARE_TURN_KEY_ID = "key-abc";
  process.env.CLOUDFLARE_TURN_API_TOKEN = "cf-secret-token";
  delete process.env.NEXT_PUBLIC_ENABLE_CALL;
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const [key, value] of [
    ["CLOUDFLARE_TURN_KEY_ID", SAVED.keyId],
    ["CLOUDFLARE_TURN_API_TOKEN", SAVED.token],
    ["NEXT_PUBLIC_ENABLE_CALL", SAVED.flag]
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

function iceRequest(token?: string): NextRequest {
  return new NextRequest("https://taoslite.com/api/call/ice", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  });
}

async function iceRoute() {
  return (await import("@/app/api/call/ice/route")).POST;
}

const FOUNDER = { id: "u2", email: "xdrabbit@gmail.com" };

interface IceBody {
  iceServers: Array<{ urls: string[]; username?: string; credential?: string }>;
  relay: boolean;
  ttlSeconds: number;
}

describe("who may mint a relay", () => {
  it("404s a signed-out stranger without calling Cloudflare", async () => {
    const POST = await iceRoute();
    const res = await POST(iceRequest());
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("404s a signed-in customer without calling Cloudflare", async () => {
    caller = { id: "u1", email: "customer@example.com" };
    const POST = await iceRoute();
    const res = await POST(iceRequest("tok"));
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("mints for a founder", async () => {
    caller = FOUNDER;
    const POST = await iceRoute();
    const res = await POST(iceRequest("tok"));
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as IceBody;
    expect(body.relay).toBe(true);
    expect(body.iceServers.some((s) => s.urls.some((u) => u.startsWith("turn")))).toBe(true);
  });

  it("opens to everyone once the public flag ships /call", async () => {
    process.env.NEXT_PUBLIC_ENABLE_CALL = "1";
    caller = { id: "u3", email: "customer@example.com" };
    vi.resetModules();
    const POST = await iceRoute();
    expect((await POST(iceRequest("tok"))).status).toBe(200);
  });
});

describe("the credential that goes to the browser", () => {
  async function mint(): Promise<{ body: IceBody; sent: Record<string, unknown>; url: string }> {
    caller = FOUNDER;
    const POST = await iceRoute();
    const res = await POST(iceRequest("tok"));
    const call = fetchSpy.mock.calls[0] as unknown[];
    const init = call?.[1] as RequestInit | undefined;
    return {
      body: (await res.json()) as IceBody,
      sent: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      url: String(call?.[0])
    };
  }

  it("asks Cloudflare for a credential that expires", async () => {
    // The whole reason this is a route and not a build-time constant. An
    // hour outlives any call and any mid-call ICE restart; it does not
    // outlive a founder's phone being lost.
    const { sent } = await mint();
    expect(sent.ttl).toBe(3600);
  });

  it("never sends the founder's email to Cloudflare", async () => {
    // Cloudflare tags credentials for usage analytics. The opaque Supabase
    // user id answers "which phone spent this GB"; an email address is the
    // one identifier a third party has no reason to hold.
    const { sent } = await mint();
    expect(sent.customIdentifier).toBe(`taos-${FOUNDER.id}`);
    expect(JSON.stringify(sent)).not.toContain("@");
  });

  it("never returns the API token to the browser", async () => {
    // The failure mode of the NEXT_PUBLIC_TURN_* path this replaces: a
    // long-lived secret readable by anyone who opens devtools.
    const { body } = await mint();
    expect(JSON.stringify(body)).not.toContain("cf-secret-token");
    expect(JSON.stringify(body)).not.toContain("key-abc");
  });

  it("passes the minted username and credential through intact", async () => {
    // These are what the phone actually authenticates to the relay with —
    // a sanitiser that dropped them would leave TURN URLs that 401.
    const { body } = await mint();
    const relay = body.iceServers.find((s) => s.urls.some((u) => u.startsWith("turn")));
    expect(relay?.username).toBe("minted-user");
    expect(relay?.credential).toBe("minted-secret");
  });

  it("keeps STUN alongside TURN, because the free path is the preferred one", async () => {
    // A relay costs $0.05/GB and a direct connection costs nothing. STUN is
    // what finds the direct one; dropping it would relay every call.
    const { body } = await mint();
    expect(body.iceServers.some((s) => s.urls.some((u) => u.startsWith("stun")))).toBe(true);
  });
});

describe("degrading instead of breaking", () => {
  it("answers STUN-only when Cloudflare is not configured, and does not call out", async () => {
    // This is production as of 2026-08-31. /call must still place the calls
    // it can already place — an unconfigured relay is not an outage.
    delete process.env.CLOUDFLARE_TURN_KEY_ID;
    delete process.env.CLOUDFLARE_TURN_API_TOKEN;
    caller = FOUNDER;
    vi.resetModules();
    const POST = await iceRoute();
    const res = await POST(iceRequest("tok"));
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    const body = (await res.json()) as IceBody;
    expect(body.relay).toBe(false);
    expect(body.iceServers.some((s) => s.urls.some((u) => u.startsWith("stun")))).toBe(true);
  });

  it("answers STUN-only when Cloudflare rejects the token", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: [{ message: "bad token" }] }), { status: 401 })
    );
    caller = FOUNDER;
    const POST = await iceRoute();
    const res = await POST(iceRequest("tok"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as IceBody;
    expect(body.relay).toBe(false);
  });

  it("answers STUN-only when Cloudflare is unreachable", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("ENOTFOUND"));
    caller = FOUNDER;
    const POST = await iceRoute();
    const res = await POST(iceRequest("tok"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as IceBody).relay).toBe(false);
  });

  it("never reports relay:true for a reply that carries no TURN server", async () => {
    // A 200 with only STUN in it would otherwise light the "relay" indicator
    // and tell Tom the fallback exists when it does not — the one thing the
    // on-screen state must never do.
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }] }), {
        status: 201
      })
    );
    caller = FOUNDER;
    const POST = await iceRoute();
    const body = (await (await POST(iceRequest("tok"))).json()) as IceBody;
    expect(body.relay).toBe(false);
  });

  it("drops anything that is not a stun/turn URL", async () => {
    // WebRTC throws on a malformed ICE server and takes the whole connection
    // with it, so a surprise in a provider response must not reach the
    // browser.
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          iceServers: [
            { urls: ["https://example.com/not-ice", "turn:turn.cloudflare.com:3478"] },
            { urls: 42 },
            { nonsense: true }
          ]
        }),
        { status: 201 }
      )
    );
    caller = FOUNDER;
    const POST = await iceRoute();
    const body = (await (await POST(iceRequest("tok"))).json()) as IceBody;
    expect(body.iceServers).toHaveLength(1);
    expect(body.iceServers[0].urls).toEqual(["turn:turn.cloudflare.com:3478"]);
  });
});
