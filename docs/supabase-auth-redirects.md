# Google sign-in: where it puts you back down

**Tom — there is one manual step in here that no code change can do for you.**
It is the [Redirect URLs](#the-manual-step) list in the Supabase dashboard, and
until it is edited, Google sign-in on a preview deployment will keep landing on
production.

## The bug (8/18, RC1 walkthrough prep)

Sign in with Google on
`https://taos-lite-git-feat-trip-mode-xdrabbits-projects.vercel.app`, end up on
`https://taoslite.com`. Nothing on screen says you moved. A tester who thought
they were reviewing the branch was reviewing production.

## Why

`components/SignIn.tsx` asks Supabase to return to the origin the browser is
already on. Supabase does **not** simply honor that. It checks the value against
the project's Redirect URLs allow-list, and when nothing matches it silently
substitutes the **Site URL** — no error, no warning, no hint in the browser.

The allow-list on this project held production and nothing else. So every
non-production origin collapsed to `https://taoslite.com/`. Proven by asking the
auth server directly (see [the check](#the-check) — the same command confirms
the fix):

```
REQUESTED redirect_to                                              -> WHERE SUPABASE SENDS YOU
https://taoslite.com                                               -> https://taoslite.com/
https://www.taoslite.com                                           -> https://taoslite.com/   ← wrong
https://taos-lite-git-feat-trip-mode-xdrabbits-projects.vercel.app -> https://taoslite.com/   ← the bug
https://taos-lite-64xtpacuh-xdrabbits-projects.vercel.app          -> https://taoslite.com/   ← wrong
https://taos-lite.vercel.app                                       -> https://taoslite.com/   ← wrong
http://localhost:3017                                              -> https://taoslite.com/   ← wrong
https://evil.example.com                                           -> https://taoslite.com/   ← correct!
```

Two things worth noticing in that table. Localhost was broken too, which is why
nobody caught this while developing — Google sign-in has never worked on the dev
machine, and the passcode path is what everyone reaches for locally. And the
last row is the behavior we must not lose: an unknown host has to fall back to
production, not be honored.

## <a id="the-manual-step"></a>The manual step — Supabase dashboard

**Supabase dashboard → project `duqkmuaceklnfgvoufrz` → Authentication → URL
Configuration → Redirect URLs → "Add URL"**, once per line:

```
https://taoslite.com/**
https://www.taoslite.com/**
https://taos-lite.vercel.app/**
https://taos-lite-*-xdrabbits-projects.vercel.app/**
http://localhost:3017/**
```

Leave **Site URL** as `https://taoslite.com` — it is the fallback for anything
that does not match, and production is the right place to land.

Notes on that fourth line, which is the one doing the real work:

- Supabase's `*` matches any run of characters except `.` and `/`, so one
  pattern covers all three hostname shapes Vercel produces: the unique
  deployment URL (`taos-lite-64xtpacuh-…`), the branch alias
  (`taos-lite-git-feat-trip-mode-…`), and the truncated-plus-hash alias a long
  branch name gets (`taos-lite-git-claude-taoslite-load-fa-c65fb2-…`).
- The `-xdrabbits-projects` on the end is not decoration, it is the security
  boundary. Anyone can name a Vercel project `taos-lite`; only you can deploy
  into your team's scope. **Do not shorten this to `https://*.vercel.app/**` or
  `**`** — that hands every session Google issues to whoever asks for it.

### Google Cloud Console — nothing to do

Worth stating because it is the natural place to go looking. Google's authorized
redirect URI is `https://duqkmuaceklnfgvoufrz.supabase.co/auth/v1/callback` and
it is the same for every deployment — previews never talk to Google directly,
they talk to Supabase, which talks to Google. No console change is needed for
previews, now or for any future branch.

## <a id="the-check"></a>The check

After saving the dashboard change, run this. It asks the auth server where it
would actually send each origin, without a Google round-trip:

```bash
SB=https://duqkmuaceklnfgvoufrz.supabase.co
for u in https://taoslite.com \
         https://www.taoslite.com \
         https://taos-lite-git-feat-trip-mode-xdrabbits-projects.vercel.app \
         https://taos-lite-64xtpacuh-xdrabbits-projects.vercel.app \
         http://localhost:3017 \
         https://evil.example.com; do
  enc=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$u")
  loc=$(curl -s -o /dev/null -w '%{redirect_url}' \
    "$SB/auth/v1/verify?token=bogus&type=magiclink&redirect_to=$enc")
  printf '%-70s -> %s\n' "$u" "${loc%%#*}"
done
```

Right afterwards, every line should echo itself back — **except the last, which
must still say `https://taoslite.com/`.** If `evil.example.com` starts echoing
itself, the allow-list is too wide and sign-in is an open redirect; fix it before
anything else.

Then the real thing, which is the only test that covers the whole round trip:
open the preview URL on a phone, tap **Continue with Google**, and confirm the
address bar still says `taos-lite-git-…vercel.app` when the app comes back. Then
do the same on `https://taoslite.com` and confirm it stays on production.

## The code half

`lib/authRedirect.ts` holds the same allow-list, applied before any host is
handed to Supabase, and `tests/auth-redirect.test.ts` fences it.

It cannot fix the bug on its own — Supabase's list is what decides, and code
cannot widen it. What it does is stop the dashboard change from becoming an open
redirect on its own: whatever the dashboard would tolerate, the app only ever
*asks* to return to a host on this list, and anything else falls back to
production. A stolen session is a worse bug than the one this fixes.

**The two lists are a pair.** A new deployment host (a second custom domain, a
renamed Vercel project, a different team) has to be added in both places, or
sign-in silently starts landing on production again.
