# /call relay — what has actually been measured

Companion to `docs/realtime-cost-model.md` (what the relay costs) and the
Shipped entry "The relay tells you it works before you dial" in
`ENHANCEMENTS.md` (why the preflight exists).

The point of this file is to keep straight **which claims about the relay are
measured and which are still inferred**, because the /call transport has a
history of every claim being true and the call still not working.

---

## The three questions, and which instrument answers each

A relayed call has to clear three separate hurdles. They fail independently,
they fail silently, and until 2026-08-31 a single "the call didn't connect"
was the only signal for all three at once.

| # | Question | Instrument | Where |
|---|---|---|---|
| 1 | Will Cloudflare **mint** a credential for these keys? | `POST /api/call/relay-status` | server, automatic on the lobby |
| 2 | Will the TURN server **allocate** a relay for that credential, from this network? | "Test connection · Probar conexión" | client, one tap |
| 3 | Can **two phones** meet on that relay across carrier NAT? | a real call | two humans, two phones |

Rows 1 and 2 used to be answered only by row 3, which is why the relay went a
day without anybody being able to say whether it worked.

**Row 1 and row 2 are not the same question.** Cloudflare validates the API
token when it mints, and validates the credential when a phone *allocates*.
A key with the wrong scope mints happily and is refused at allocate time — a
401 on the TURN server, invisible to every server-side check, and on a phone
it looks like "connecting…" forever. The negative control below is that exact
shape.

---

## Measurements

### The keys mint — 2026-08-31

```
POST https://rtc.live.cloudflare.com/v1/turn/keys/{keyId}/credentials/generate-ice-servers
→ HTTP 201, iceServers: 1 STUN entry + 1 TURN entry (udp/tcp/tls, ports 3478/53/80/443/5349)
```

Key id is 32 hex, token is 64 chars. So `relay: false` in production, if it is
ever seen again, is **not** the keys.

### Two peers through real Cloudflare — 2026-08-31

`node tests/live-fire/call-relay-check.mjs` with the real keys in the
environment. This is the run PR #52 could not do, because the key did not
exist yet; it had only ever been run against a local `node-turn`.

```
relay:          cloudflare (1 server entry)
connected:      yes, in 207 ms
selected pair:  relay/relay
candidates:     {"relay":6}      ← zero host, zero srflx
```

`iceTransportPolicy: "relay"` is what makes this mean anything: Chrome
discards its own host and server-reflexive candidates under it, so a
connection that came up came up through the relay and could not have come up
any other way. It is the both-cellular row of the network matrix, minus the
cellular.

### The shipped probe, in a browser — 2026-08-31

The above proves the relay. It does **not** prove `lib/call/relayProbe.ts`,
which is the code founders will actually tap — a rig that reimplements the
client can invent results the client never produces (see the memory
*a-measurement-rig-must-do-what-the-client-does*). So the shipped module was
mounted on a temporary local page and driven in headless Chrome over CDP,
with only the auth-gated `/api/call/ice` fetch stubbed, and credentials minted
from the real Cloudflare endpoint:

```
probe result:            { status: "ok", ms: 270, pair: "relay/relay", relayCandidates: 20 }
bad-credential control:  { status: "no_allocation", turnErrorCode: 400,
                           detail: "the relay refused to allocate (TURN error 400)" }
```

The second line is the one that matters. A probe that reports "works" is only
worth having if it also reports "doesn't" — with a deliberately corrupted
credential the button does not go green, does not time out, and names the
allocate-time refusal that no server-side check can see.

To re-run it: `npm run dev`, a temporary client page that exposes
`probeRelay` on `window` and stubs `/api/call/ice` with minted servers, then
drive it over CDP. Kept out of the repo on purpose — it needs a real key and
it is a two-minute rebuild.

### The DEPLOYMENT's own keys mint — 2026-08-31

The measurements above use the local copy of the Cloudflare variables. The
copy that matters is the one in Vercel, and it is marked Sensitive: it cannot
be read back (see the memory *vercel-sensitive-env-vars*). So it was asked
rather than read — a temporary secret-guarded route on a throwaway preview
deployment, reporting only what Cloudflare said about the vars the deployment
itself holds, then deleted along with the deployments:

```
{ "status": "ready", "httpStatus": 201, "ttlSeconds": 3600,
  "turnUrlCount": 6, "keyIdLen": 32, "keyIdIsHex32": true, "tokenLen": 64,
  "vercelEnv": "preview" }
```

**The keys Tom entered are good.** Cloudflare accepts them and returns six
TURN URLs. `relay: false` in production, if it is ever seen again, is not the
credentials.

One caveat stated precisely: this ran in the **Preview** environment.
`CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_API_TOKEN` are each a single
Vercel entry scoped to `Production, Preview` — one entry, one value, both
environments — so Production holds the same string. Once this PR is merged,
`POST /api/call/relay-status` answers the same question in Production
directly, from the lobby, with no throwaway anything.

---

## Still not measured

- **Carrier NAT, phone to phone.** Both ends of the loopback probe are one
  device. It proves the relay is reachable and authenticating *from where you
  are standing*; it cannot prove Tom's phone and Liz's phone meet on it. Still
  a two-phone question — the difference is that three of the five reasons a
  call can fail are now ruled out before anybody dials.
- **The ALLOCATE leg against the deployment's own credentials.** The
  deployment mints (above) and a locally-minted credential allocates (above),
  but nobody has yet tapped "Test connection" on a phone against a real
  deployment. That is thirty seconds of work for a founder and it closes the
  last server-side gap.
- **The cause of the asymmetric audio** in the 2026-08-31 field report. The
  per-direction counters make the symptom legible; they do not explain it.
  Next time it happens, open Connection details and read which direction is
  at `0/s` — that, plus whether the pair says `relay`, is the missing evidence.
