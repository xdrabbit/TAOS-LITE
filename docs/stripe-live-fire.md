# Stripe live-fire: one real purchase, then undo it

Live mode went on 2026-08-22 (PR #27). Everything below is **live money** —
a real card, a real charge, a real refund. Do it once, then put it away.

What is already proven without spending anything: the live key mints a
`cs_live_` Checkout session for the Basic price at $5.99 (minted and expired
2026-08-22), the production webhook route answers `400 Invalid signature` to an
unsigned POST (so both secrets are present in prod), and the live endpoint
`we_1U7PR0HRRKSWY3H5sAnyAxgF` is enabled for exactly the four events the
handler reads.

What is **not** proven, and is what this run is for: a real card completing
checkout, Stripe delivering the event to production, and the webhook writing
the subscription onto the profile row.

## The price map

| env var | live price id | amount |
| --- | --- | --- |
| `STRIPE_PRICE_BASIC` | `price_1U70KPHRRKSWY3H546OMw43o` | $5.99/mo |
| `STRIPE_PRICE_PREMIUM` | `price_1U70KOHRRKSWY3H56ZC3BX5j` | $19.99/mo |
| `STRIPE_PACK_100` | `price_1U70KOHRRKSWY3H5JZugAldN` | $9.99 one-time |
| `STRIPE_PACK_200` | `price_1U70KNHRRKSWY3H5xLoLqr0g` | $17.99 one-time |

All four live on product `prod_UjbTZmdQt2VS7Z` ("TAOS-LITE"), account
`acct_1Tk7XQHRRKSWY3H5`.

## Before you start

```bash
export SK=$(grep -E '^STRIPE_SECRET_KEY=' .env.local | sed -E 's/^STRIPE_SECRET_KEY=//' | tr -d '"'"'"'')
[[ "$SK" == sk_live_* ]] && echo "live key loaded" || echo "WRONG KEY"
```

## The purchase

1. Open <https://taoslite.com> in a browser, signed in as yourself.
2. Subscribe → **Basic $5.99/mo**. Use your real card. No promo code (the field
   is on, but a 100%-off code would skip the charge this run exists to test).
3. You should land back on `https://taoslite.com/?checkout=success`.

## Verify (four checks, in order)

**1. The session completed, in live mode.**

```bash
curl -s "https://api.stripe.com/v1/checkout/sessions?limit=1" -u "$SK:" | python3 -c "
import sys,json
s=json.load(sys.stdin)['data'][0]
print('session   ', s['id'])
print('livemode  ', s['livemode'])          # must be True
print('status    ', s['status'])            # complete
print('payment   ', s['payment_status'])    # paid
print('amount    ', s['amount_total'], s['currency'])   # 599 usd
print('user_id   ', s['client_reference_id'])           # your Supabase user id
print('customer  ', s['customer'])
print('sub       ', s['subscription'])
open('/tmp/.livefire','w').write(json.dumps({'sub':s['subscription'],'cus':s['customer'],'uid':s['client_reference_id']}))
"
```

Keep that subscription id — the refund and cancel steps below read it back from
`/tmp/.livefire`.

**2. Stripe delivered the webhook and got a 200.**

An event with `pending_webhooks: 0` has been accepted by every subscribed
endpoint. Anything above 0 after a minute means production rejected it or never
answered.

```bash
curl -s "https://api.stripe.com/v1/events?limit=10" -u "$SK:" | python3 -c "
import sys,json
for e in json.load(sys.stdin)['data']:
    flag = 'OK ' if e['pending_webhooks']==0 else 'PENDING'
    print(f\"{flag} {e['type']:38} pending={e['pending_webhooks']} {e['id']}\")
"
```

Expect `checkout.session.completed` and `customer.subscription.created`, both
at `pending=0`. If one is stuck, the delivery attempts and their response
bodies are at
<https://dashboard.stripe.com/webhooks/we_1U7PR0HRRKSWY3H5sAnyAxgF>.

Signature verification is not a separate check: the handler rejects an
unverifiable body with a 400 before it does anything, so a 200 *is* a verified
signature.

**3. The subscription row landed on the profile.**

The webhook writes `subscription_status`, `plan`, `tier`,
`stripe_subscription_id`, `stripe_customer_id` and `current_period_end`. In the
Supabase SQL editor, with the user id from step 1:

```sql
select id, subscription_status, plan, tier,
       stripe_customer_id, stripe_subscription_id, current_period_end
from profiles
where id = '<client_reference_id from step 1>';
```

Expect `subscription_status = 'active'`, `plan = 'pro'`, `tier = 'basic'`, and
a `current_period_end` about a month out. **`tier = 'basic'` is the one that
proves the live price map is right** — it is derived by matching the
subscription's price id against `STRIPE_PRICE_BASIC`, so a null tier on an
active sub means production is holding the wrong price id.

**4. The app agrees.** Reload taoslite.com — the paywall should be gone and the
account menu should show the paid plan.

## Undo it

Refund the charge and cancel the subscription immediately, so no second month
bills.

```bash
python3 - <<'PY'
import json, os, subprocess
d = json.load(open('/tmp/.livefire'))
sk = os.popen("grep -E '^STRIPE_SECRET_KEY=' .env.local | sed -E 's/^STRIPE_SECRET_KEY=//' | tr -d '\"'").read().strip()
def api(path, args=(), method=None):
    cmd = ['curl','-s',f'https://api.stripe.com/v1/{path}','-u',f'{sk}:']
    for a in args: cmd += ['-d', a]
    if method: cmd += ['-X', method]
    return json.loads(subprocess.run(cmd, capture_output=True, text=True).stdout)

# The subscription's first invoice holds the charge to refund.
sub = api(f"subscriptions/{d['sub']}")
inv = api(f"invoices/{sub['latest_invoice']}")
charge = inv.get('charge') or inv.get('payment_intent')
print('refunding', charge)
print(json.dumps(api('refunds', [f'charge={charge}'] if str(charge).startswith('ch_')
                                 else [f'payment_intent={charge}']), indent=1)[:400])

# Cancel now, not at period end — this was a test, not a month of service.
print('cancelling', d['sub'])
print(json.dumps(api(f"subscriptions/{d['sub']}", method='DELETE'), indent=1)[:200])
PY
```

Or by hand:

```bash
# refund (charge id from the invoice)
curl -s https://api.stripe.com/v1/refunds -u "$SK:" -d charge=ch_XXXX
# cancel immediately
curl -s -X DELETE https://api.stripe.com/v1/subscriptions/sub_XXXX -u "$SK:"
```

The cancel fires `customer.subscription.deleted`, which the webhook also
handles — so re-run check 3 afterwards and confirm the profile falls back to
`plan = 'free'`, `tier = null`. That is the second half of the live-fire test:
the downgrade path works too.

## The run that happened (2026-08-23)

Done once, with PREMIUM rather than Basic. Everything on the Stripe side was
clean and the app side was not.

| check | result |
| --- | --- |
| session `cs_live_b1MIat…` | ✓ livemode, complete, paid, 1999 usd |
| price id | ✓ `price_1U70KOHRRKSWY3H56ZC3BX5j` = `STRIPE_PRICE_PREMIUM` |
| webhooks | ✓ all six events `pending_webhooks: 0` |
| profile row | ✗ `plan=free, tier=null` — **the customer paid and stayed free** |
| refund `re_3U7PnuHRRKSWY3H50ZD4phcH` | ✓ $19.99 in full |
| cancel + downgrade | ✓ `subscription.deleted` wrote `canceled` |

The failure was not the price map and not the signature — it was event
ordering. Stripe delivers concurrently with no ordering guarantee, and
`customer.subscription.created` carries a `status: "incomplete"` snapshot from
before the card is charged. It was processed *last*, after
`checkout.session.completed` had already written the paid state, and the
handler wrote that stale snapshot straight over it. Fixed in PR #29 by
re-reading the subscription from Stripe in every handler; pinned by
`tests/stripe-webhook-sync.test.ts`.

Note for anyone re-running this: **a green webhook proves nothing about the
database.** The handler catches its own errors and returns 200 so Stripe won't
retry forever, so check 3 is the only check that can fail loudly. Do not skip
it.

Cost of the test: **$0.88** — Stripe keeps the processing fee on a refund
(gross 19.99, fee 0.88, net 19.11; the refund returns 19.99 and refunds no fee).

## Known loose ends

- **Preview has no Stripe config.** `STRIPE_SECRET_KEY` and
  `STRIPE_WEBHOOK_SECRET` used to be single vars covering Production *and*
  Preview, so the live key had leaked into every preview branch. All six Stripe
  vars are Production-only now, and preview billing routes answer "Billing is
  not configured yet." To get preview billing back, add an `sk_test_` key (and
  a test-mode `whsec_`) scoped to **Preview only**.
- **A stray live price**, `price_1U70KPHRRKSWY3H5HO6QcDP1` at $7.99/mo, sits on
  the TAOS-LITE product with no nickname and matches nothing the app sells. It
  is unused and untouched; delete or archive it in the dashboard if it was a
  mistake.
- **`support@taoslite.com` is still promised on /about but is not a real
  mailbox.** Stripe emails receipts from the account's support address; worth
  settling before real customers reply to one.
