# Tutor Phase 1 — Curriculum Plan

*Agreed Tom + Claude, 2026-08-19. Tutor is currently gated
(`NEXT_PUBLIC_ENABLE_TUTOR`, off for RC1). Target: re-enable end of week /
early next week.*

## Design principle

Curriculum is written ONCE as language-agnostic **intent modules** (what a
traveler needs to accomplish), and the model instantiates each module per
target language at lesson time.

Rationale: communicative intents (I need, I want, where is, help) are
near-universal; sentence STRUCTURE is not. Spanish maps word-for-word from
English; Hindi expresses wanting with a dative subject — "to-me water
is-wanted"; Farsi is verb-final with taarof politeness norms. A curriculum
hardcoding English/Spanish sentence skeletons silently breaks on structurally
different languages.

The model flags where the target language differs from the LEARNER's language
as the core teaching moment (the "contrast hook"), not a footnote.

## The 14 survival modules

1. **First contact** — hello, yes/no, please/thanks, "I don't understand", "do
   you speak English?" (escape hatches first)
2. **Who I am** — name, origin, the 60-second self
3. **Numbers & money** — prices, counting, paying
4. **I need / I want** — core request machinery
5. **Where is…** — directions, transit, bathroom
6. **Food & drink** — ordering, allergies, the bill
7. **Market & shopping** — this one, how much, too expensive, deal
8. **Getting around** — tickets, taxi, "does this go to…?"
9. **Sleeping** — check-in, room problems
10. **Trouble** — help, lost, stolen, police
11. **Health** — pharmacy, symptoms, "it hurts here"
12. **Connection** — wifi, phone, and the social module: "can I have a
    conversation with you?" (named for Tom's Taiwan mission, 1980s — kids
    asking exactly that is the product's origin insight)
13. **Time & plans** — tomorrow, at 6, let's meet
14. **Reactions** — delicious, beautiful, I love it

## Module schema

Data, not prose — the same single-source-of-truth pattern as
`lib/languages/catalog.ts`.

```yaml
id: needs-wants
competency: "State a need, understand the response, handle 'we don't have it'"
situations: [pharmacy, restaurant, market]
core_moves: [request, quantity, accept, decline, thank]
contrast_hook: true   # model flags where target language structures this differently than learner's language
roleplay_seed: "You're a pharmacist. Customer needs something for a headache. Be natural, misunderstand once."
pronunciation_targets: [request_phrase, thank_phrase]  # → Azure pronunciation assessment
```

## Lesson loop per module: Crawl / Walk / Run

- **Crawl** — hear it, contrast note, repeat, Azure scores pronunciation
- **Walk** — scripted roleplay; tutor plays the counterpart; learner has lines
  to hit
- **Run** — free realtime conversation, tutor in character, gently kept
  in-module (uses existing tutor realtime sessions — this is the
  differentiator)

## Standalone mode: Conversation Partner

No curriculum. Level-matched free conversation on request — the Taiwan use
case, pure.

## Phase-1 engineering scope (future dispatch, in order)

1. Module schema + the 14 modules as data
2. Generation prompt: (module, target language, learner language) → lesson,
   with contrast hooks
3. Crawl/walk/run loop wired to existing realtime + Azure pronunciation
   plumbing
4. Catalog wiring — tutor is still EN⇄ES-era (`LearnLang = "es" | "en"` in
   `app/api/tutor/realtime/route.ts`); it needs the same treatment /live and
   /tabletop got in `eeeaa41`
5. Cost guards / session metering tied to plan minutes (the reason tutor APIs
   404 today; also what makes "15/45/200 tutor minutes" pricing real) —
   REQUIRED before customer-facing
6. Re-enable flag; pricing page copy resolves itself if tutor ships before
   billing goes live

---

*On the arc:* tutor is **Learn**, the third step of Translate → Connect →
Learn → Understand. The step after it is `docs/reflections-plan.md`
(Reflections), which is sequenced explicitly after tutor phase 2 metering.
