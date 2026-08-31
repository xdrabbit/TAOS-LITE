// The preflight: can this deployment mint a TURN credential RIGHT NOW?
//
// ── The loop this route closes ─────────────────────────────────────────────
// PR #52 shipped the relay with one bit of state — `relay: true | false` —
// and production had no Cloudflare keys, so the bit was false and everybody
// knew why. Tom entered CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_API_TOKEN
// on 2026-08-31 and redeployed, and from that moment the bit could be false
// for three different reasons that want three different responses:
//
//   not_configured  nobody has entered the keys        → wait
//   rejected        the keys are entered and WRONG     → fix them in Vercel
//   error           Cloudflare had a bad minute        → try again
//
// One bit cannot say which. The only instrument anyone had was a real call
// between two founders on two phones in two rooms — an instrument that fails
// for five reasons and reports one word, and which has never once been
// observed succeeding. This file is the fence around the instrument that
// replaces it.
//
// Three things have to stay true, and each has a way of quietly stopping:
//
//   1. The four statuses stay DISTINCT. Collapsing `rejected` into `error`
//      is the natural refactor and it deletes the entire reason for the
//      route: `rejected` is the only status that means a human must act.
//   2. It stays FOUNDERS ONLY, refused before Cloudflare is called. This
//      route mints a real credential; a 404 issued afterwards is the same
//      bandwidth grant with better manners.
//   3. It NEVER returns a credential. A status check is safe to run whenever
//      a lobby renders. A credential handed out whenever a lobby renders is
//      a credential handed to whoever is watching.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

let caller: { id: string; email: string } | null = null;

vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async (req: Request) => {
    const header = req.headers.get("authorization") ?? "";
    return header.startsWith("Bearer ") && caller ? caller : null;
  }
}));

const FOUNDER = { id: "u2", email: "xdrabbit@gmail.com" };

/** A real Cloudflare 201, shape-for-shape (captured 2026-08-31). */
const MINTED = {
  iceServers: [
    { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
    {
      urls: [
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turns:turn.cloudflare.com:5349?transport=tcp"
      ],
      // Placeholders, deliberately not credential-shaped: a fixture that
      // looks like a real minted secret is a fixture that gets flagged by a
      // secret scanner every time this file is touched.
      username: "fixture-username",
      credential: "fixture-credential"
    }
  ]
};

const fetchSpy = vi.fn(
  async () =>
    new Response(JSON.stringify(MINTED), {
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
  process.env.CLOUDFLARE_TURN_KEY_ID = "fixture-key-id";
  process.env.CLOUDFLARE_TURN_API_TOKEN = "fixture-api-token";
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

function request(token?: string): NextRequest {
  return new NextRequest("https://taoslite.com/api/call/relay-status", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  });
}

interface StatusBody {
  status: string;
  ttlSeconds: number;
  httpStatus: number | null;
  detail: string | null;
}

async function ask(): Promise<{ res: Response; body: StatusBody }> {
  const { POST } = await import("@/app/api/call/relay-status/route");
  const res = await POST(request("tok"));
  return { res, body: (await res.json()) as StatusBody };
}

describe("who may run the preflight", () => {
  it("404s a signed-out stranger without minting", async () => {
    const { POST } = await import("@/app/api/call/relay-status/route");
    const res = await POST(request());
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("404s a signed-in customer without minting", async () => {
    // The refusal has to come BEFORE Cloudflare. A credential minted for a
    // stranger and then discarded is still a credential that exists for an
    // hour, and this route is reachable by anyone who guesses the path.
    caller = { id: "u1", email: "customer@example.com" };
    const { POST } = await import("@/app/api/call/relay-status/route");
    const res = await POST(request("tok"));
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers a founder", async () => {
    caller = FOUNDER;
    const { res, body } = await ask();
    expect(res.status).toBe(200);
    expect(body.status).toBe("ready");
  });
});

describe("the four answers stay four answers", () => {
  beforeEach(() => {
    caller = FOUNDER;
  });

  it("ready — Cloudflare minted, and says how long the credential lasts", async () => {
    const { body } = await ask();
    expect(body.status).toBe("ready");
    expect(body.ttlSeconds).toBe(3600);
    expect(body.httpStatus).toBe(201);
  });

  it("not_configured — no keys, and no call to Cloudflare at all", async () => {
    // Production between PR #52 and 2026-08-31. Not an error: /call still
    // connects everywhere STUN connects, and the lobby says so in those words
    // rather than implying somebody broke something.
    delete process.env.CLOUDFLARE_TURN_KEY_ID;
    delete process.env.CLOUDFLARE_TURN_API_TOKEN;
    vi.resetModules();
    const { body } = await ask();
    expect(body.status).toBe("not_configured");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(body.ttlSeconds).toBe(0);
  });

  it("not_configured — one key without the other counts as unconfigured", async () => {
    // The likeliest way to half-configure this: paste the key id, get
    // distracted, redeploy. Reaching Cloudflare with an empty bearer would
    // report `rejected` and send Tom hunting a key that is merely absent.
    delete process.env.CLOUDFLARE_TURN_API_TOKEN;
    vi.resetModules();
    const { body } = await ask();
    expect(body.status).toBe("not_configured");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(body.detail).toContain("api token");
  });

  it("rejected — a 401 is the keys being wrong, not Cloudflare being down", async () => {
    // THE state this whole route exists for. Swapped key id and token,
    // a revoked key, a key from another Cloudflare account: all of them land
    // here, all of them are a two-minute fix in Vercel, and none of them was
    // distinguishable from "Tom hasn't made the key yet" before today.
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: [{ message: "Invalid API token" }] }), { status: 401 })
    );
    const { body } = await ask();
    expect(body.status).toBe("rejected");
    expect(body.httpStatus).toBe(401);
    expect(body.detail).toContain("Invalid API token");
  });

  it("rejected — a 404 on the key id is the same class of answer", async () => {
    // Cloudflare 404s a key id that does not exist on the account, which is
    // what a typo'd or another-account key looks like.
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: [{ message: "key not found" }] }), { status: 404 })
    );
    expect((await ask()).body.status).toBe("rejected");
  });

  it("error — a 5xx is Cloudflare, and retrying is the fix", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("upstream", { status: 503 }));
    const { body } = await ask();
    expect(body.status).toBe("error");
    expect(body.httpStatus).toBe(503);
  });

  it("error — an unreachable Cloudflare", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("ENOTFOUND rtc.live.cloudflare.com"));
    const { body } = await ask();
    expect(body.status).toBe("error");
    expect(body.httpStatus).toBe(null);
  });

  it("error — a 2xx carrying no TURN server is not `ready`", async () => {
    // A 200 with only STUN in it would otherwise light the lobby green and
    // tell Tom the fallback exists when it does not — the one thing an
    // on-screen state must never do.
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }] }), {
        status: 200
      })
    );
    const { body } = await ask();
    expect(body.status).toBe("error");
    expect(body.detail).toContain("without a turn server");
  });
});

describe("what a status check must never hand out", () => {
  beforeEach(() => {
    caller = FOUNDER;
  });

  it("returns no credential, no username, and no ICE server list", async () => {
    // The distinction between this route and /api/call/ice. This one is safe
    // to run on every lobby render precisely because there is nothing in the
    // answer worth stealing.
    const { body } = await ask();
    const json = JSON.stringify(body);
    expect(json).not.toContain(MINTED.iceServers[1].credential);
    expect(json).not.toContain(MINTED.iceServers[1].username);
    expect(json).not.toContain("turn:");
    expect(body).not.toHaveProperty("iceServers");
  });

  it("never returns the API token or the key id", async () => {
    const { body } = await ask();
    const json = JSON.stringify(body);
    expect(json).not.toContain("fixture-api-token");
    expect(json).not.toContain("fixture-key-id");
  });

  it("never echoes a credential out of a refusal body", async () => {
    // Cloudflare puts errors and iceServers in the same object shape. A
    // `JSON.stringify(body)` in the detail — which is what the pre-refactor
    // route logged — would put a live credential on a founder's screen and
    // in a Vercel log the moment a partial failure came back.
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          errors: [{ message: "quota exceeded" }],
          iceServers: [
            { urls: ["turn:turn.cloudflare.com:3478"], username: "leaky", credential: "s3cr3t" }
          ]
        }),
        { status: 429 }
      )
    );
    const { body } = await ask();
    expect(body.status).toBe("rejected");
    expect(body.detail).toContain("quota exceeded");
    expect(JSON.stringify(body)).not.toContain("s3cr3t");
    expect(JSON.stringify(body)).not.toContain("leaky");
  });

  it("does not send the founder's email to Cloudflare", async () => {
    // Same rule as /api/call/ice: the opaque Supabase id answers "which
    // phone", and an email is the one identifier a third party has no reason
    // to hold. Easy to lose when a mint is copied into a second route, which
    // is exactly why the mint is now one function.
    await ask();
    const call = fetchSpy.mock.calls[0] as unknown[];
    const init = call?.[1] as RequestInit | undefined;
    const sent = String(init?.body ?? "");
    expect(sent).toContain(`taos-${FOUNDER.id}`);
    expect(sent).not.toContain("@");
  });
});

describe("the two routes ask Cloudflare the same question", () => {
  it("/api/call/ice reports the same status word for the same refusal", async () => {
    // If the lobby says `rejected` and the call that follows says something
    // else, the preflight is worse than useless — it is a second opinion
    // that has to be reconciled. One mint, one vocabulary.
    caller = FOUNDER;
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ message: "Invalid API token" }] }), { status: 401 })
    );
    const status = (await ask()).body;

    const { POST } = await import("@/app/api/call/ice/route");
    const iceRes = await POST(
      new NextRequest("https://taoslite.com/api/call/ice", {
        method: "POST",
        headers: { Authorization: "Bearer tok" }
      })
    );
    const ice = (await iceRes.json()) as { relay: boolean; status: string };

    expect(status.status).toBe("rejected");
    expect(ice.status).toBe("rejected");
    // …and /call is still exactly as good as it was: STUN, a 200, and a call
    // that connects on any wifi it already connected on.
    expect(iceRes.status).toBe(200);
    expect(ice.relay).toBe(false);
  });
});
