# Tutor phase 2 — metering verification

*Run 2026-08-28 on branch `feat/tutor-metering`. Database:
`duqkmuaceklnfgvoufrz` (TAOS-LITE production Supabase). Test account
`bestboy32445@gmail.com` — `subscription_status = canceled`, so it resolves to
the FREE tier with a 900-second plan allowance, which is the tier every
boundary below is walked against.*

## Why this document exists

The tutor has already lost a month to a green round trip. Crawl rendered "—"
on every attempt from late July to 8/26 because `/api/tutor/assess` reached
Azure, got a 200, and read the score off the wrong shape — the request
succeeded, the number never arrived, and nothing in the codebase noticed.
`docs/tutor-crawl-gating-verification.md` and the memory note that came out of
it say the same thing: **assert on the number, not on the call.**

Metering is the same shape of risk with money attached. A unit test can prove
`splitDebit(500, 300, 6000)` returns `{plan: 300, pack: 200}`; it cannot prove
that `public.tutor_accrue`, the plpgsql function that actually moves the
balance, agrees. So everything below was run against the real database and
every assertion is a NUMBER read back out of it.

## What was verified, and what came back

### 1. A session accrues, and a replayed beacon does not

Minted a 600-second reservation for a free-tier user and settled it at 120
real seconds, then delivered the identical settle a second time — which is what
`keepalive: true` does when a network retries or a tab teardown races.

| | expected | actual |
|---|---|---|
| first `tutor_accrue` | 120 | **120** |
| replayed `tutor_accrue` | null (already settled) | **null** |
| `tutor_usage.seconds_used` | 120 | **120** |
| `tutor_usage.partner_seconds` | 120 | **120** |

The row is locked `for update` and short-circuits on `settled_at`, so the
second delivery is a no-op rather than a second debit.

### 2. Plan minutes go first, then the pack — walked across the boundary

Starting state: 120 of 900 plan seconds used, a 600-second pack credited. Then
three sessions in a row.

| session | billed | plan part | pack part |
|---|---|---|---|
| Run, 900s (straddles the boundary) | 900 | 780 | 120 |
| Crawl, 3s (plan already gone) | 3 | 0 | 3 |
| Walk, 600s, `metered = false` (founder) | 600 | — | — |

Read back:

| | expected | actual |
|---|---|---|
| `seconds_used` | 1023 (the founder's 600 excluded) | **1023** |
| `pack_seconds_used` | 123 | **123** |
| `run_seconds` | 900 | **900** |
| `crawl_seconds` | 3 | **3** |
| `walk_seconds` | 0 — the founder session is not ledgered | **0** |
| `profiles.pack_seconds` | 477 (600 − 123) | **477** |

The founder session IS in `tutor_sessions` with its 600 seconds, which is the
point: Tom and Liz testing every day is a real OpenAI bill and a cost query has
to see it. It is simply not charged against anything.

### 3. The end that never arrived

Two open sessions: one abandoned twenty minutes ago with a 300-second grant
(past grant + the 120-second grace), one started ten seconds ago with a
600-second grant. Then `tutor_reap_open_sessions`.

| | expected | actual |
|---|---|---|
| sessions still open | 1 — the live one | **1** |
| seconds still held | 600 | **600** |
| `seconds_used` | 1323 (1023 + the reaped 300) | **1323** |
| reaped session's `end_reason` | `lost` | **lost** |
| `profiles.pack_seconds` | 177 (477 − 300) | **177** |

The abandoned session was settled at its FULL grant, not at zero. That is the
pessimistic answer on purpose: OpenAI billed for as long as the session ran
whether or not the browser lived long enough to say so, and the alternative is
that closing a tab is how you get free minutes. The live session was left
alone — a reaper that collected in-flight sessions would end real
conversations.

### 4. The routes deploy and answer (branch preview, 2026-08-28)

`NEXT_PUBLIC_ENABLE_TUTOR=1` is set on the Preview environment unscoped, so the
branch deployment has the tutor on. Probed unauthenticated:

| route | expected | actual |
|---|---|---|
| `GET /api/tutor/balance` | 401 (new route, must exist and be reachable) | **401** `Please sign in to use the tutor.` |
| `POST /api/tutor/realtime` | 401 | **401** |
| `POST /api/tutor/session` | 401 | **401** |

The previous branch preview 404s `/api/tutor/balance`, which is the control:
the route is genuinely new and genuinely deployed rather than being answered by
a stale build.

Modest but not nothing. A 401 rather than a 500 means `lib/tutor/meter.ts` —
which now imports `supabaseAdmin` and `lib/release` at module scope — loads
without throwing under the real bundler and the real runtime. It does NOT prove
the meter works: the auth check runs before the meter is touched.

### 5. Cleanup

Every row created above was deleted and the pack balance reset. Final state of
the database: `tutor_usage` 0 rows, `tutor_sessions` 0 open, every
`profiles.pack_seconds` at 0, `stripe_pack_credits` 0 rows. Nothing synthetic
survives into the ledger the flip will start enforcing against.

## What is covered by tests rather than by a live run

* **Pack purchases** — `tests/tutor-pack-credit.test.ts` drives the real
  webhook handler with a faked Stripe and a faked `profiles` row: three
  deliveries of one `checkout.session.completed` credit 100 minutes once; two
  different checkout sessions credit twice; a session Stripe currently reports
  as `unpaid` credits nothing even when the event snapshot said `paid`.
* **The warn-then-end sequence** — `tests/tutor-metering.test.ts` drives
  `lib/tutor/sessionClock.ts` directly. The WebRTC path needs a browser, a
  microphone and a paid OpenAI session to run at all; "does the warning fire
  before the end, and does the end wait for the turn to land" is arithmetic.
* **The plan/pack ordering, in TypeScript** — `splitDebit` is a mirror of the
  plpgsql above, and one test reads the migration file to pin the three SQL
  lines the ordering lives in. If they ever drift, the SQL is what ran.

## The one gap, stated plainly

**Nothing here drove the HTTP routes end to end.** `SUPABASE_SERVICE_ROLE_KEY`
is marked sensitive in Vercel, so `vercel env pull` returns an empty string for
it and a laptop cannot have one — the same wall
`docs/tutor-phase1-verification.md` hit with `AZURE_SPEECH_KEY`. What that
means concretely:

* The SQL that moves money is verified (above), and the arithmetic that decides
  what to ask it for is verified (tests).
* The wiring between them — `beginTutorSession` → insert → `tutor_accrue` — is
  verified only by types and by reading.

`lib/tutor/meter.ts` fails CLOSED on this: in production, a missing service-role
key raises `TutorMeterUnavailableError` and the mint answers 503 rather than
minting an unmetered realtime session. Off production it stays open with a
loud `meter_unavailable` log line. `tests/tutor-metering.test.ts` pins both.

**Closing the gap takes one session on a preview with the flag on**, which is
step 3 of the flip checklist in the PR body: start a Partner session, talk for
about a minute, hang up, and check that the header chip dropped by roughly a
minute and that `tutor_usage.partner_seconds` shows it.

## The manual live check nobody should automate

Pack purchases run through **live** Stripe in production — there is no test
mode there any more (`stripe-live-mode`, PR #27). So the pack credit is
verified by unit test and by replay, and the one real-money check stays a human
decision, per the `stripe-live-fire` runbook:

1. Sign in as `bestboy32445@`, buy the +100 pack ($9.99) with a real card.
2. Confirm `profiles.pack_seconds` for that user goes from 0 to 6000, and that
   the tutor header chip picks it up within a few seconds of returning to
   `/tutor?pack=success`.
3. Confirm exactly one row in `stripe_pack_credits` for that checkout session.
4. Refund in the Stripe dashboard, and zero `pack_seconds` back out by hand —
   a refund does NOT claw the minutes back automatically, and that is a
   deliberate gap, not an oversight (see the PR body).
