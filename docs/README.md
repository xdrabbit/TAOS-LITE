# TAOS-LITE docs

Index of `docs/`, checked against `main` @ `912ce0c` on 2026-10-03.
Start with the repo README and `ENHANCEMENTS.md` (living backlog). Architecture
is `TAOS-LITE-arch.md` at the repo root. Agent rules: `CLAUDE.md`.

## Product / plans

- `backstory.md` — unpublished original `/about` dedication. Not rendered. Do not reword; do not restore onto `/about`.
- `group-chat-plan.md` — future group chat (would change the two-member thread invariant).
- `reflections-plan.md` — future couple-reflections concept; nothing built.
- `tutor-curriculum-plan.md` — 14 intent modules, crawl / walk / run, engineering order.

## Verification notes (keep; they are field evidence)

- `tutor-phase1-verification.md` — tutor phase 1 against the real providers.
- `tutor-metering-verification.md` — tutor phase 2 minute metering.
- `tutor-crawl-gating-verification.md` — Crawl's Say-It gating.
- `tutor-walk-progression-verification.md` — the Walk/Run loop.
- `call-relay-verification.md` — what has actually been measured on the `/call` TURN relay.
- `stripe-live-fire.md` — one real live-mode purchase, then undo it.
- `session-briefs/` — dated field notes, 2026-07-06 to 2026-07-09 (including the Spanish summary for Liz).

## Maps and wiring

- `data-map.md` — live schema audit (2026-08-26; updated for PR #37 and tutor metering).
- `api-translation.md` — `/api/live-translate` and `/api/text-translate`.
- `supabase-auth-redirects.md` — the Supabase dashboard allow-list paired with `lib/authRedirect.ts`.
- `realtime-cost-model.md` — what a realtime minute costs on `/call`, `/live`, `/tabletop`.
- `fast-engine.md` — `/fast` engine bake-off (measured), Azure Translator setup steps, costs.
- `pr-challenger.md` — the read-only reviewer agent that forces one verdict per open PR.

Local port is 3017 per `.mc-launch.toml`. Do not invent other launch URLs here.
