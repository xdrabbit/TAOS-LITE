# Enhancements · TAOS-LITE

The living backlog. **Tom or Liz**: think of something you want? Open this file
on GitHub (phone works great: repo → ENHANCEMENTS.md → ✏️ → commit to main)
and add a line under **Ideas**. That's it — no ceremony, no perfect wording.

**Agents**: read this file at the start of any build session (CLAUDE.md makes
this automatic). When the user asks "what's next" or finishes a task with time
to spare, propose from **Up next**. When you ship an item, move it to
**Shipped** with the date and PR number. When the user voices a future want
mid-session, add it here. Never delete or reword Tom/Liz's entries — append.

Entry format (loose): `- What it is — why / any detail. (added YYYY-MM-DD)`

---

## Up next (roughly prioritized)

- Chat push notifications (tier 2) — phones buzz when a message lands while
  the app is closed. Planned since chat tier 1 shipped. (added 2026-08-03)
- Call cost guards — /call bills two realtime sessions the whole time it's
  connected, silence included: auto-hangup after ~10 min with no speech,
  shrink the 4h hard cap to ~90 min, show an elapsed/cost timer on screen.
  (added 2026-08-03, from the July 14/22 OpenAI bill spikes)
- Cantonese field verdict — have the Cantonese-speaking guest judge the v3
  voice and the zh⇄yue auto-detection; swap ELEVENLABS_YUE_MODEL or tune the
  detect prompt based on her review. (added 2026-08-03)

## Ideas

- Tutor hyperlink study words for more instruction. 
- Group chat — e.g. 1 Spanish + 3 English speakers, everyone reads the whole
  conversation in their own language. Schema (threads/members/messages) is
  already generic; needs accounts for guests, a thread picker, sender names
  on bubbles. Two-language groups fit the current design; 3+ languages needs
  per-language translations. (added 2026-08-03, designed 7/22)
- Multi-language phase 2 — bring the language-pair picker to /tabletop
  (most likely place to meet strangers). Phase 3: /live and /call. (added
  2026-08-03)
- Guest voice clones — quick-clone a recurring guest so their translations
  play in their real voice instead of the stock one. (added 2026-08-03)
- Use lib/net's fetchWithRetry in /chat and /live fetches — /translate,
  /tabletop already have it; extend if "Load failed" is ever seen there.
  (added 2026-08-03)
- Decide the fate of the stale `dev` branch — merged-history only or does it
  hold anything worth keeping? (added 2026-08-03)

## Shipped

- Cantonese: ZH⇄YUE + EN⇄YUE pairs, colloquial written form, v3 voice —
  2026-07-25, PR #9
- Multi-language phase 1: language-pair picker with Mandarin — 2026-07-25, PR #8
- Regression fence: first test suite + CI on every PR — 2026-07-25, PR #7
- Call hold-on indicator (interpreter still speaking on their phone) —
  2026-07-24, PR #2
- "Load failed" hardening, tabletop voices, nightly predict fix — 2026-07-22, PR #1
