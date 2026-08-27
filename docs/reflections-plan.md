# Reflections — The Couples Superglue

*Concept: Tom + Liz, prototyped on themselves. Documented 2026-08-25.
Post-tutor roadmap — nothing here is built. Position on the arc:
Translate → Connect → Learn (tutor) → **Understand (Reflections)**.*

## The insight

Couples who don't share a language feed their ENTIRE relationship through
TAOS. Not the highlights — everything. The fights and the repairs after them,
dinner plans, "have you seen my watch," the apology at 11pm. A monolingual
couple's hard conversations happen in the air and are gone; theirs happen
through the app because they have no other channel.

That corpus is the ground truth of a relationship, and no other product has
it. Reflections turns it into understanding: an AI that reflects a couple's
OWN history back to them, reframed with warmth.

## Founder-prototype evidence (why we believe)

This is not a hypothesis someone sketched on a whiteboard. Tom and Liz have
run it manually, multiple times — their own transcripts, pasted into a
frontier LLM, asked to reflect the pattern back.

The result each time: the AI retold their conflicts in a way **both of them
recognized without flinching** — Tom's words, "palatable, almost enjoyable" —
and they report walking away MORE in love every time.

The product replicates *that ritual*. It does not build a counseling clinic
around it. Everything in the constitution below exists to protect the thing
that already worked.

## Design constitution (non-negotiable)

These are not preferences to be traded off against engagement metrics later.
Each one is load-bearing: break it and the feature becomes something the
founders would not use on themselves.

1. **A translator of meaning, not a judge.**
   Reflections NEVER adjudicates who was right. No verdicts, no receipts, no
   scorecards, no "you interrupted 14 times this month." It reframes patterns
   so both partners recognize themselves in the telling. He-said/she-said is
   the anti-pattern — the moment the output can be screenshotted and used to
   win an argument, we have built a weapon instead of a mirror.

2. **Both partners, or nothing.**
   Dual explicit opt-in required. Either partner can revoke at any time, and
   revocation deletes derived analyses. There is no solo access to couple
   analysis — not a read-only view, not a preview, not "just for you."
   The sit-down-together ritual is part of the UX **by design**, not a
   limitation to be relaxed once someone asks.

3. **Data principles.**
   Conversations exist to be translated — that is the standing promise, and
   Reflections does not get to quietly widen it. Reflections is a separate,
   opt-in purpose with its own consent, in its own words, at its own moment.
   - The couple graph does not exist before dual opt-in — no inferred partner
     links, no shadow profiles; collection for Reflections begins at opt-in,
     never retroactively by default (any retroactive inclusion is a separate,
     explicit, both-partners choice).
   - Per-couple encryption for the analysis layer.
   - Delete means delete — raw *and* derived.
   - No training on couples' content. Ever, and said plainly in-product.
   - Retention controls visible to the user, not buried in settings.

4. **Session shape.**
   Couples open it TOGETHER — same room, both phones confirm. They pick a
   window ("this month", "since the trip"), and receive: a warm narrative
   reflection, a few gentle pattern observations, and **one** small
   suggestion. One. A list of homework is a clinic; a single small thing is a
   conversation.
   Tone constitution for the prompt: Gottman-informed, strengths-first,
   repair-oriented, never diagnostic, no clinical labels.

5. **Safety rails.**
   On signals of abuse, coercion, or crisis: decline the analysis and surface
   resources. This is a wellness feature, not therapy — the product says so
   plainly, in-product, and says it never substitutes for professional help.
   A reflection engine pointed at a coercive relationship can hand the
   controlling partner a script; declining is the only correct output there.

6. **Legal posture.**
   The archive is sensitive by nature. Minimize what Reflections persists:
   derive, present, discard by default. Saving a reflection is an explicit
   act by the couple, never the default path.

## Why it's the moat

- **Data nobody else has**, gathered as a byproduct of genuine daily value —
  not harvested, not surveyed, not self-reported. People do not keep diaries
  of their arguments; this couple's translator already did.
- **The retention arc.** Free tier meets a stranger → tutor keeps you
  learning → Reflections keeps you MARRIED — to each other, and to TAOS.
  Cradle-to-grave, in Tom's words.
- **Trust as brand.** The loud promise plus conspicuous restraint IS the
  differentiator against big-tech translators. Google can build the model; it
  cannot credibly make this promise, and a couple deciding who reads their
  worst night knows the difference.

## Sequencing

After tutor ships and meters (phase 2), and after group chat lands for the
trip. Both of those are trip-critical or revenue-critical; this is neither,
and starting it early would be the wrong trade.

1. **Consent + ritual UX + data plumbing**, with encryption. The hardest and
   least glamorous phase, and the one that decides whether the rest is
   allowed to exist.
2. **Reflection generation** with the tone constitution, founder-only alpha.
   Tom and Liz dogfood it, naturally — they are already the alpha, just
   without software.
3. **Invite-only couples beta.**

Note the ordering: consent infrastructure before the model work. The
temptation will be to prove the magic first with a quick unguarded prototype
on real transcripts. That prototype is the exact thing the constitution
forbids, and it would be built on the two people whose trust the product is
staking itself on.

Related: `docs/tutor-curriculum-plan.md` (Learn) and `docs/group-chat-plan.md`
(Connect) are the two steps before this one on the arc.
