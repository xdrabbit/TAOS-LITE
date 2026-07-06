# SESSION BRIEF — TAOS-LITE `/live` real-time follow-along

**STATUS AT HANDOFF:** ✅ `/live` UI is BUILT, gate was GREEN, MERGED to `dev`, and PUSHED to `origin/dev` (commit `e27f2fe`). It is **live on Vercel dev**. The *build* is done; the **acceptance test is NOT** — see NEXT STEP at bottom.

_Written 2026-07-06. Fresh Claude: read this top-to-bottom, you'll be oriented in 60 seconds._

---

## 1. Where we are (the map)

- **Project:** TAOS-LITE — Next.js 14.2 App Router, npm, dev port **3017**. Spanish↔English translation app used by **Tom (English)** + **Liz (Spanish)**.
- **Two API endpoints** built earlier, LIVE ON DEV (commit `5003556`, on `origin/dev`):
  - `POST /api/live-translate` → returns a **3–12 word CONCEPT micro-summary** (NOT a translation). `~` prefix + `isGuess: true` = inferred from context, not clearly heard.
  - `POST /api/text-translate` → proper natural translation, auto-detect.
  - Contracts: `docs/api-translation.md`.
- **The `/live` UI** was dispatched this session on branch `feat/live-followalong-ui`:
  - New `/live` route — mobile-first, **Web Speech API** mic capture.
  - Live concept feed: **newest-on-top**, guesses rendered **dimmed/italic with `~`** + a "guess" tag.
  - **Direction toggle:** Liz ES→EN (default) / Me EN→ES. Switching restarts recognition with the new lang.
  - **Clear** button resets feed + rolling context.
  - **Rolling context:** last 10 concepts auto-fed back into the endpoint (matches endpoint's `MAX_CONTEXT_ENTRIES = 10`), sent oldest-first.
  - Fire-and-render (no queue): each finalized chunk fires an independent `fetch`; results prepend as they return.

**Files that shipped (in `e27f2fe`):**
- `app/live/page.tsx` — server page + metadata, renders the client shell.
- `components/LiveShell.tsx` (433 lines) — the whole feature.
- `lib/speech-recognition.d.ts` — ambient Web Speech API types (not in TS DOM lib).

---

## 2. VERIFIED build state (checked this session — NOT aspirational)

The previous rider dispatched the build blind and couldn't confirm the outcome. It has now been verified from disk, git, and the Mission Control task log (`code-task-...-e13f39ff`, `exit_code: 0`). Findings:

| Check | Result |
|---|---|
| Branch `feat/live-followalong-ui` exists? | ✅ Yes — still exists locally, merged but **not deleted** (kept for reference). |
| `app/live/page.tsx` on disk? | ✅ Yes (+ `components/LiveShell.tsx`, `lib/speech-recognition.d.ts`). |
| Merged to `dev`? | ✅ Yes — clean fast-forward. `dev` HEAD = `e27f2fe feat(live): /live real-time phone-call follow-along UI`. |
| Pushed to `origin/dev`? | ✅ Yes — `5003556..e27f2fe  dev -> dev`. Local `dev`, `origin/dev`, and `HEAD` all = `e27f2fe`. |
| Typecheck / lint / build gate green? | ✅ All green. `npm run typecheck` clean, `npm run lint` clean, `npm run build` compiled OK. `/live` in route table: `○ /live  3.01 kB  90.3 kB` (static prerender + client component). |

**Bottom line: `/live` IS on `dev` and `origin/dev`, and the Vercel dev build was triggered by the push.** Nothing about the build is in doubt.

_(Housekeeping: the merged local branch `feat/live-followalong-ui` can be deleted whenever — it's just sitting there.)_

---

## 3. The ACCEPTANCE CRITERIA (the real spec — do not lose this)

`/live` is **NOT "done" just because the route returns JSON.** It's done when:

> Watching **ONLY the concept feed**, with real ambient Spanish happening, a **non-Spanish-speaker can follow what's going on in real time** — AND when the mic only catches fragments (cross-talk, trailing off), **`isGuess`/`~` HONESTLY flags "I'm inferring this"** rather than emitting a confident-looking fabrication. **Confident-wrong is the enemy.**

**Venue is GENERALIZED** — the same `/live` page must serve all three:
- **Dinner tables** — multi-speaker cross-talk, fragments.
- **Conference talks** — one clean speaker, long runs.
- **Phone calls** — speaker audio.

**⚠️ Open copy nit:** framing/labels still say "phone call" and should be generalized to **"live follow-along / any room."** Confirmed instances to fix:
- `app/live/page.tsx:7` — metadata description: "Follow a live Spanish **phone call**…"
- `components/LiveShell.tsx` — header comments (lines 5–6) and UI copy at line ~295 ("Put **the call** on speakerphone…").

---

## 4. Env / gotchas

- **Vercel dev env** needs BOTH `OPENAI_API_KEY` **and** `OPENAI_PARAPHRASE_MODEL` set, or the endpoints 500.
- **Web Speech API requires HTTPS** → test on Vercel dev URL, **not localhost**.
- **Browser support:** Chrome (desktop or **Android**) is the target. **iOS Safari has weak/unreliable Web Speech support** — known **v2 gap**; the UI already shows a clear notice if the API is missing.
- Chrome routes recognition audio through Google's servers (that's how Web Speech works) — but **no mic audio hits our server**; only recognized **text** goes to `/api/live-translate`.
- Web Speech ends sessions on silence even with `continuous = true`; the UI **auto-restarts** in `onend` while listening (invisible, but good to know).
- **Untracked cruft — keep IGNORING, do NOT commit:** `TAOS-LITE-arch.md`, `launch.json`, `outputs/`. (Worth a `.gitignore` entry someday.)

---

## 5. How to smoke-test on Vercel (Chrome)

Open `https://<dev-url>/live` in Chrome → allow mic → tap **START LISTENING** (button pulses amber = mic hot) → play/speak Spanish on speakerphone. Short English concepts stream in newest-on-top; the interim-transcript row shows it's hearing. Guesses appear dimmed/italic with `~` + "guess" tag. Use the **direction toggle** to flip speakers; **Clear** empties feed + rolling context.

---

## NEXT STEP

**Run the REAL acceptance test.** `/live` is confirmed live on Vercel dev — now fire **actual Liz transcript chunks** (Spanish, emotionally loaded, some fragmentary/cross-talk) through the `/live` feed and judge: *watching only the feed, could you follow the conversation mid-flight, and are uncertain bits honestly flagged as guesses (not confident-wrong)?* **If the gist is mushy or guesses aren't flagged, the fix is tuning the compression PROMPT in `/api/live-translate`** (one dispatch → re-test). Test in Chrome (desktop or Android); iOS Safari is a known v2 gap. While you're in there, knock out the §3 copy nit (generalize "phone call" → "live follow-along / any room").
