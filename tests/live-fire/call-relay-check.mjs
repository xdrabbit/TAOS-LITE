// Does a /call actually connect when the ONLY path is a relay?
//
//   node tests/live-fire/call-relay-check.mjs
//
// This is the question the 2026-08-31 field report asked and nobody could
// answer: Tom and Liz, two real phones, a call that starts and never
// connects. The suspected cause was two carrier NATs with no direct path
// between them — the case where every candidate either side offers is
// unreachable from the other, and only a TURN relay can carry the media.
//
// `iceTransportPolicy: "relay"` is how that case is reproduced on a desk.
// Chrome discards its own host and server-reflexive candidates and will
// ONLY use a relay candidate allocated on the TURN server, so a connection
// that comes up under this flag came up through the relay and could not have
// come up any other way. It is the two-cellular-phones row of Tom's matrix,
// minus the phones.
//
// Two peers, two tabs, signaling passed between them by this script the way
// the Supabase broadcast channel passes it in lib/call/session.ts — including
// trickled candidates, which is what bug 3 was about.
//
// ── Running it ─────────────────────────────────────────────────────────────
// Needs google-chrome on PATH, and a TURN server. Either:
//
//   A. THE REAL ONE. Set CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_API_TOKEN
//      and this mints credentials from Cloudflare exactly as
//      app/api/call/ice/route.ts does. This is the run that proves the path
//      production will use. It relays a few hundred KB — well inside the
//      1,000 GB free tier.
//
//   B. A LOCAL ONE, when there is no Cloudflare key (production's state as of
//      2026-08-31). `npm i --no-save node-turn` and re-run. This proves the
//      CLIENT half — that minted credentials are consumed and a relay-only
//      connection is negotiated — without proving anything about Cloudflare.
//      Deliberately not a devDependency: nothing in `npm test` uses it, and
//      it drags in an old log4js.
//
// `npm test` does not run this, the same as call-audio-browser-check.mjs —
// it drives Chrome over CDP. tests/call-connection.test.ts is the part that
// runs on every PR.
//
// ── Measured ───────────────────────────────────────────────────────────────
// 2026-08-31, local node-turn, three consecutive runs: connected in 205 /
// 206 / 207 ms on a relay/relay candidate pair, with 2 relay candidates
// gathered and no host or srflx candidates at all.
//
// Be precise about what that does and does not prove. This rig builds its own
// peer connections; it does NOT import lib/call/session.ts, so it cannot say
// anything about that file's candidate queueing or its retry policy —
// tests/call-connection.test.ts is what pins those, and it fails against the
// pre-8/31 version of each. What this proves is the other half, and the half
// no unit test can reach: that a browser handed nothing but TURN credentials
// will allocate a relay and carry real media over it.
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const TURN_USER = "taos-relay-check";
const TURN_PASS = "relay-check-secret";
const CHROME_PORT = 9345;
const CONNECT_CAP_MS = 20_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The relay ──────────────────────────────────────────────────────────────

/** Cloudflare, the real thing — the same call app/api/call/ice makes. */
async function cloudflareIce() {
  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID?.trim();
  const token = process.env.CLOUDFLARE_TURN_API_TOKEN?.trim();
  if (!keyId || !token) return null;
  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: 600 })
    }
  );
  if (!res.ok) {
    console.error(`Cloudflare refused the mint: HTTP ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const body = await res.json();
  // Relay-only ICE cannot use STUN entries, and leaving them in lets a
  // "connected" be claimed by a path this check is supposed to exclude.
  const servers = (body.iceServers ?? []).filter((s) =>
    [s.urls].flat().some((u) => String(u).startsWith("turn"))
  );
  return { servers, label: "cloudflare", stop: () => {} };
}

/** A TURN server on this machine, for when there is no Cloudflare key yet. */
async function localIce() {
  let Turn;
  try {
    ({ default: Turn } = await import("node-turn"));
  } catch {
    console.error(
      "No TURN server available.\n" +
        "  Real path:  CLOUDFLARE_TURN_KEY_ID=… CLOUDFLARE_TURN_API_TOKEN=… node tests/live-fire/call-relay-check.mjs\n" +
        "  Local path: npm i --no-save node-turn && node tests/live-fire/call-relay-check.mjs"
    );
    process.exit(1);
  }
  const server = new Turn({
    listeningPort: 3478,
    listeningIps: ["127.0.0.1"],
    relayIps: ["127.0.0.1"],
    authMech: "long-term",
    credentials: { [TURN_USER]: TURN_PASS },
    debugLevel: "ERROR"
  });
  server.start();
  return {
    servers: [
      { urls: "turn:127.0.0.1:3478?transport=udp", username: TURN_USER, credential: TURN_PASS }
    ],
    label: "local node-turn",
    stop: () => server.stop?.()
  };
}

// ── A browser, and two pages in it ─────────────────────────────────────────

async function cdp(url) {
  const sock = new WebSocket(url);
  await new Promise((r, j) => {
    sock.addEventListener("open", r);
    sock.addEventListener("error", j);
  });
  let id = 0;
  const pending = new Map();
  sock.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  return {
    send: (method, params) =>
      new Promise((resolve) => {
        const i = ++id;
        pending.set(i, resolve);
        sock.send(JSON.stringify({ id: i, method, params }));
      }),
    close: () => sock.close()
  };
}

/** Evaluate in the page and hand back the resolved value. */
async function evaluate(page, expression) {
  const res = await page.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (res.result?.exceptionDetails) {
    throw new Error(JSON.stringify(res.result.exceptionDetails));
  }
  return res.result?.result?.value;
}

const ice = (await cloudflareIce()) ?? (await localIce());
if (ice.servers.length === 0) {
  console.error("No TURN servers came back from the mint.");
  process.exit(1);
}
console.log(`relay: ${ice.label} (${ice.servers.length} server entry/entries)`);

// getUserMedia needs a SECURE CONTEXT, and http://localhost is one.
const site = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<!doctype html><title>taos relay check</title><body></body>");
}).listen(0);
await new Promise((r) => site.on("listening", r));
const SITE_URL = `http://localhost:${site.address().port}/`;

const chrome = spawn(
  "google-chrome",
  [
    "--headless=new",
    `--remote-debugging-port=${CHROME_PORT}`,
    "--no-sandbox",
    "--disable-gpu",
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "about:blank"
  ],
  { stdio: "ignore" }
);

function fail(message) {
  console.error(`FAIL — ${message}`);
  chrome.kill();
  ice.stop();
  site.close();
  process.exit(1);
}

/** Open a fresh tab and return a CDP handle on it. */
async function openTab(browser) {
  const { result } = await browser.send("Target.createTarget", { url: SITE_URL });
  const list = await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json`)).json();
  const target = list.find((t) => t.id === result.targetId);
  if (!target?.webSocketDebuggerUrl) throw new Error("no debugger url for new tab");
  return cdp(target.webSocketDebuggerUrl);
}

try {
  let browserWs = null;
  for (let i = 0; i < 60 && !browserWs; i++) {
    try {
      const version = await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json/version`)).json();
      browserWs = version.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    if (!browserWs) await sleep(200);
  }
  if (!browserWs) fail("Chrome never came up on the debugging port.");
  const browser = await cdp(browserWs);

  const caller = await openTab(browser);
  const callee = await openTab(browser);
  await sleep(500);

  // Each tab builds ONE peer connection, relay-only, and parks its signaling
  // in a queue this script drains — standing in for the Supabase broadcast
  // channel. Candidates trickle, exactly as they do in a real call.
  const setup = `(async () => {
    globalThis.__out = [];
    globalThis.__pc = new RTCPeerConnection({
      iceServers: ${JSON.stringify(ice.servers)},
      iceTransportPolicy: "relay"
    });
    globalThis.__types = [];
    __pc.onicecandidate = (e) => {
      if (e.candidate) {
        __types.push(e.candidate.type);
        __out.push({ kind: "candidate", data: e.candidate.toJSON() });
      }
    };
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => __pc.addTrack(t, stream));
    globalThis.__state = () => __pc.connectionState;
    return "ready";
  })()`;

  await evaluate(caller, setup);
  await evaluate(callee, setup);

  // Offer / answer.
  const offer = await evaluate(
    caller,
    `(async () => { await __pc.setLocalDescription(await __pc.createOffer()); return JSON.stringify(__pc.localDescription); })()`
  );
  const answer = await evaluate(
    callee,
    `(async () => {
       await __pc.setRemoteDescription(${JSON.stringify(JSON.parse(offer))});
       await __pc.setLocalDescription(await __pc.createAnswer());
       return JSON.stringify(__pc.localDescription);
     })()`
  );
  await evaluate(
    caller,
    `__pc.setRemoteDescription(${JSON.stringify(JSON.parse(answer))}).then(() => "ok")`
  );

  // Drain trickled candidates both ways until one side connects or time runs
  // out. Relay candidates take a round trip to allocate, so they arrive after
  // the answer — which is precisely the race bug 3 was losing.
  const started = Date.now();
  let connected = false;
  while (Date.now() - started < CONNECT_CAP_MS && !connected) {
    for (const [from, to] of [
      [caller, callee],
      [callee, caller]
    ]) {
      const drained = await evaluate(from, `(() => { const o = __out; globalThis.__out = []; return JSON.stringify(o); })()`);
      for (const msg of JSON.parse(drained)) {
        await evaluate(to, `__pc.addIceCandidate(${JSON.stringify(msg.data)}).then(() => "ok").catch((e) => String(e))`);
      }
    }
    const states = await Promise.all([
      evaluate(caller, `__pc.connectionState`),
      evaluate(callee, `__pc.connectionState`)
    ]);
    if (states.every((s) => s === "connected")) connected = true;
    if (states.includes("failed")) fail(`ICE failed: caller=${states[0]} callee=${states[1]}`);
    if (!connected) await sleep(100);
  }
  const elapsed = Date.now() - started;

  if (!connected) {
    const states = await Promise.all([
      evaluate(caller, `__pc.connectionState`),
      evaluate(callee, `__pc.connectionState`)
    ]);
    fail(`never connected in ${CONNECT_CAP_MS} ms (caller=${states[0]} callee=${states[1]})`);
  }

  // Connected — now prove it went through the relay rather than around it.
  const pairScript = `(async () => {
    const stats = await __pc.getStats();
    const byId = new Map();
    stats.forEach((r) => byId.set(r.id, r));
    let pair = null;
    for (const r of byId.values()) {
      if (r.type === "transport" && r.selectedCandidatePairId) pair = byId.get(r.selectedCandidatePairId);
    }
    if (!pair) for (const r of byId.values()) if (r.type === "candidate-pair" && r.state === "succeeded" && r.nominated) pair = r;
    if (!pair) return JSON.stringify({ pair: "none", types: __types });
    return JSON.stringify({
      local: byId.get(pair.localCandidateId)?.candidateType ?? "?",
      remote: byId.get(pair.remoteCandidateId)?.candidateType ?? "?",
      types: __types
    });
  })()`;
  const stats = JSON.parse(await evaluate(caller, pairScript));

  const counts = (stats.types ?? []).reduce((acc, t) => ({ ...acc, [t]: (acc[t] ?? 0) + 1 }), {});
  console.log(`connected:      yes, in ${elapsed} ms`);
  console.log(`selected pair:  ${stats.local}/${stats.remote}`);
  console.log(`candidates:     ${JSON.stringify(counts)}`);

  if (stats.local !== "relay" || stats.remote !== "relay") {
    fail(`connected on a ${stats.local}/${stats.remote} pair — that is not the relay path`);
  }
  // Under iceTransportPolicy:"relay" a host or srflx candidate should never
  // be gathered at all. One appearing means the policy did not take, and the
  // "relay proven" claim above it would be false.
  for (const type of ["host", "srflx"]) {
    if (counts[type]) fail(`gathered ${counts[type]} ${type} candidate(s) under a relay-only policy`);
  }

  console.log("\nPASS — two peers connected with a relay as their only path.");
  caller.close();
  callee.close();
  browser.close();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

chrome.kill();
ice.stop();
site.close();
process.exit(0);
