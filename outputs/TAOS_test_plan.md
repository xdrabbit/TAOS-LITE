# TAOS — Production Test Plan & Go-Live Checklist

**App (production):** https://taos-lite.vercel.app
**Tutor:** https://taos-lite.vercel.app/tutor · **Free funnel:** https://taos-lite.vercel.app/try

---

## Before you start — read this

- **Money is NOT real yet.** Production is still wired to Stripe **test mode**, so every "Subscribe" / "Buy pack" uses a **test card** and charges nothing. You'll switch to real money in **Part H** (do that last, Sunday night / Monday morning).
- **Test card:** number `4242 4242 4242 4242`, any future expiry (e.g. `12/34`), any CVC (e.g. `123`), any ZIP.
- **You'll need 2–3 throwaway email accounts** (or Gmail `+` aliases like `yourname+test1@gmail.com`) to play the role of new customers. Tom & Liz's own accounts are **comp (unlimited)**, so they will **not** see free-tier limits, upgrade prompts, or packs — you must test those with a fresh account.
- Check each box as you go. If something fails, note the test ID + what you saw.

---

## Part A — Accounts & sign-in

| # | Step | Expected | ✓ |
|---|------|----------|---|
| A1 | Open the app in a private/incognito window | Sign-in screen appears | ☐ |
| A2 | Sign in with Google (a fresh account) | Lands in the translator | ☐ |
| A3 | Sign out, sign back in | Returns to your same data | ☐ |
| A4 | (Tom/Liz) Sign in with your normal account | No upgrade banners anywhere (you're comp/unlimited) | ☐ |

---

## Part B — Translator, free tier (use the fresh account)

| # | Step | Expected | ✓ |
|---|------|----------|---|
| B1 | Note the banner at the top | "Free · 25 translations left this month" | ☐ |
| B2 | Tap the mic, say a full sentence in English, tap again | Spanish translation appears + is spoken aloud | ☐ |
| B3 | Say something in Spanish | Auto-detect flips it to English correctly | ☐ |
| B4 | Tap **Flip · Voltear** on a result | Re-translates the same clip the other direction | ☐ |
| B5 | Tap the speaker icon on a result | Plays the translation voice | ☐ |
| B6 | Open **History**, then delete one item | Item disappears; history is yours only | ☐ |
| B7 | Keep translating until the counter hits 0 | Banner turns red: "Free translations used up this month"; mic disabled; **Upgrade** shown | ☐ |

> Tip: to reach 0 fast you can do quick short phrases — it's 25 for the month.

---

## Part C — Tutor, free tier (fresh account)

| # | Step | Expected | ✓ |
|---|------|----------|---|
| C1 | Go to **/tutor**, **Drills** tab, tap "Hear it" then record a phrase | Pronunciation score + word colors appear | ☐ |
| C2 | Switch to **Conversation** tab | Setup card shows "Free trial · 15 tutor min left this month" (or similar) | ☐ |
| C3 | Pick a language + level, tap **Start talking** | Tutor greets you out loud within ~2s | ☐ |
| C4 | Have a short back-and-forth | It replies by voice and corrects pronunciation | ☐ |
| C5 | Tap a steer chip ("More English", "Kitchen words", etc.) | Tutor adjusts accordingly | ☐ |
| C6 | Stop talking for ~20 seconds | Session auto-pauses (idle) | ☐ |
| C7 | Tap **Mic off**, then **End conversation** | Mic mutes; session ends cleanly | ☐ |
| C8 | Use up all 15 minutes (several sessions) | Setup card shows "used up" + **See plans** button | ☐ |

---

## Part D — Subscriptions & tiers (test card)

| # | Step | Expected | ✓ |
|---|------|----------|---|
| D1 | As an exhausted free user, tap **Upgrade / See plans** | Plan screen shows **Basic $5.99** and **Premium $19.99** | ☐ |
| D2 | Choose **Basic**, pay with the test card | Returns to the app; translations now unlimited (no banner) | ☐ |
| D3 | Go to tutor Conversation | Now shows "45 tutor min left this month" | ☐ |
| D4 | (New fresh account) Subscribe to **Premium** | Tutor shows "200 tutor min left this month"; translations unlimited | ☐ |
| D5 | Confirm the charge in Stripe Dashboard (test mode) | A $5.99 / $19.99 test payment is recorded | ☐ |

---

## Part E — Add-on minute packs (test card, paid account)

| # | Step | Expected | ✓ |
|---|------|----------|---|
| E1 | On a **Basic** account, use up the 45 monthly minutes | Conversation shows "used up" → **Upgrade for more** | ☐ |
| E2 | Open plans; confirm the packs section appears | "Need more tutor minutes this month?" with **+100 · $9.99** and **+200 · $17.99** | ☐ |
| E3 | Buy **+100 min** with the test card | Returns to /tutor; within a few seconds the minutes increase by 100 | ☐ |
| E4 | Start a conversation | It runs again using the pack minutes | ☐ |
| E5 | (Optional) As a **free** user, confirm packs are NOT offered | Free users are asked to subscribe first | ☐ |

---

## Part F — Billing management

| # | Step | Expected | ✓ |
|---|------|----------|---|
| F1 | On a paid account, open plans → **Manage billing** | Stripe customer portal opens | ☐ |
| F2 | Cancel the subscription in the portal | Back in the app, account drops to **Free** (25/15 again, not locked out) | ☐ |

---

## Part G — Privacy spot-check

| # | Step | Expected | ✓ |
|---|------|----------|---|
| G1 | Sign in as account #1, make a translation | It's in account #1's history | ☐ |
| G2 | Sign in as account #2 | Account #2 does NOT see account #1's history or conversations | ☐ |

---

## Part H — GO LIVE: switch on real money (do this last)

> Until this is done, all payments above are fake. This is the Monday-morning switch.
> Tom drives the Stripe Dashboard + Vercel; Claude can create the live prices once you flip Stripe to **Live mode**.

- ☐ **H1.** In Stripe, toggle from **Test mode** to **Live mode** (top-right switch).
- ☐ **H2.** Create the four **live** prices on your product (Claude can do this for you in live mode):
  - Basic — $5.99 / month (recurring)
  - Premium — $19.99 / month (recurring)
  - Pack — $9.99 one-time (metadata `pack_minutes = 100`)
  - Pack — $17.99 one-time (metadata `pack_minutes = 200`)
- ☐ **H3.** Create a **live webhook** endpoint → URL: `https://taos-lite.vercel.app/api/stripe/webhook` — subscribe to events: `checkout.session.completed`, `customer.subscription.created/updated/deleted`. Copy its **signing secret**.
- ☐ **H4.** In **Vercel → Project → Settings → Environment Variables (Production)**, set:
  - `STRIPE_SECRET_KEY` = your **live** secret key (`sk_live_…`)
  - `STRIPE_WEBHOOK_SECRET` = the live webhook signing secret
  - `STRIPE_PRICE_BASIC` = live Basic price id
  - `STRIPE_PRICE_PREMIUM` = live Premium price id
  - `STRIPE_PACK_100` = live 100-min pack price id
  - `STRIPE_PACK_200` = live 200-min pack price id
- ☐ **H5.** **Redeploy production** (env changes only apply to a new deploy).
- ☐ **H6.** **Live smoke test:** with a *real* card, subscribe to Basic ($5.99 real charge), confirm access unlocks, then cancel/refund if desired. Confirm the charge shows in Stripe **live** mode.
- ☐ **H7.** You're live. 🎉

---

## Known limitations / notes (v1)

- **Comp accounts (Tom, Liz) are unlimited** — you won't see limits or packs; that's intended.
- **Monthly quotas reset on the 1st (UTC).** Add-on pack minutes are **good through the end of the current month** (they don't roll over).
- **Plan switching** for existing subscribers goes through the Stripe **billing portal** (not an in-app one-click) to avoid double-charging.
- If a freshly-paid upgrade or pack doesn't reflect immediately, give it ~5 seconds (the webhook is catching up) or refresh once.
