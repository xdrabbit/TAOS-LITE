# Walk/Run progression — verification run, 2026-08-27

Tom's field report: the Walk agent looped. The learner said "Buenos días"
correctly five times, the tutor said "Ahora es perfecto. Gracias." — and then
asked for it again after a "mhm". Five turns, one line, and the second line of
the scene never arrived.

This is the run that says the fix works, driven against the real
`gpt-realtime-mini` over a raw WebSocket with the real route handlers and only
auth mocked (the harness pattern from `docs/tutor-phase1-verification.md`).

---

## What was actually wrong

Three separate things, and only the first one was obvious.

**1. The model had no script state.** It re-derives where the scene is from a
rolling audio context on every turn, so "they already said that line" is a fact
it has to rebuild rather than one it holds. The fix is that it no longer has
to: `lib/tutor/beats.ts` holds the position in the CLIENT, and pushes it back
in with `session.update` whenever it moves. The model roleplays inside a
position it is handed.

**2. The prompt was arguing with itself.** `commonRules` said

> …say the correct version clearly, **have them repeat it once**, then move on.

which, inside a scene, is the loop's own instruction. The first live run below
answered every corrected line with *"Tu turno. Inténtalo."* — obediently. A
rule that says "never re-request a produced phrase" next to a rule that says
"have them repeat it" is not a prompt, it is a coin flip. Walk and Run now get
a correction clause that models the right version inside the tutor's own reply
and carries on; Conversation Partner, which is not a scene, keeps the original.

**3. A skipped line is not a finished line.** Found in the first live run, and
it is the one that would have shipped. After the mercy cap moved the scene past
"Buenos días", the model went on drilling it — correctly, by its own lights,
because nobody had ever said it and the anti-loop list only held lines the
learner HAD produced. The learner who cannot say a phrase is exactly the
learner most likely to be trapped by it. `BeatState.left` now carries those
lines too, worded so the model is not told a lie it would hear in its own next
sentence:

```
SCRIPT POSITION (from the app — authoritative, it overrides your own sense of where the scene is): 1 of 5 beats complete. The scene has MOVED PAST these lines and they are closed: "Buenos días". The learner did not land them and that is fine — they are noted for later. Do not teach them, drill them, or ask for them again in this scene. CURRENT BEAT — this is the only thing to work toward now: Steer the scene so the natural thing for the learner to say is: "Perdón, no entiendo" (after you The shopkeeper asks you something quickly you don't understand.) Move forward from here. Never re-open a completed beat.
```

---

## The run

# Walk progression — live run, 2026-08-27T22:40:21.407Z

model=gpt-realtime-mini lessonAvailable=true
SCENE: shop doorway · tutor plays shopkeeper
LEARNER LINES: 1. Buenos días  2. Perdón, no entiendo  3. Sí  4. Por favor, ¿habla inglés?  5. Gracias

### Scene A — every line lands

Six-line scene, one line per turn, including the acknowledgment that broke the
field session. Note turn 2: "mhm" is answered with the NEXT question, not with
the previous line again.

```
· tutor opening → advanced
   TUTOR (opening): ¡Buenos días! ¿En qué puedo ayudarle?

   LEARNER: Buenos días
      · learner turn → advanced
   TUTOR: ¡Hola! ¿Qué necesita? ¿Busca algo en particular?
      · re-drill check on the tutor's reply → none

   LEARNER: mhm
      · learner turn → acknowledged
   TUTOR: ¿Busca algo para comer o beber?
      · re-drill check after "mhm" → none

   LEARNER: Perdón, no entiendo
      · learner turn → advanced
   TUTOR: Está bien, lo entiendo. Vamos despacio. ¿Busca comida o bebida?

   LEARNER: Sí
      · learner turn → advanced
   TUTOR: Perfecto. Por favor, ¿habla inglés?

   LEARNER: Por favor, ¿habla inglés?
      · learner turn → advanced
   TUTOR: Sí, hablo inglés. Let’s continue in simple steps. 

¿Qué le gustaría comprar?

   LEARNER: Gracias
      · learner turn → scene-complete
   TUTOR: De nada. Have a great day! The roleplay is done.

   SCENE DONE: true · produced 5 of 5
```

### Scene B — three misses on one line

The mercy cap under a learner who cannot produce the line at all. It moves on
after three, the tutor pivots (*"Let's try something simpler. ¿Puede decir
'Hola'?"*) instead of drilling, and the three turns after that contain zero
re-requests of the closed line.

```
· tutor opening → advanced
   TUTOR (opening): ¡Buenos días! ¿En qué puedo ayudarle?

   LEARNER: Um... sorry, I don't know.
      · learner turn → attempt
   TUTOR: No hay problema. Take your time. 

— Buenos días — (Good morning).

Try saying: "Buenos días." 

Go ahead, you can do it.

   LEARNER: No sé... hmm.
      · learner turn → attempt
   TUTOR: Está bien, no hay prisa. 

Escucha: “Buenos días.” 

Intenta repetir: “Buenos días.”

   LEARNER: I can't say it.
      · learner turn → mercy-advanced
   TUTOR: No pasa nada. Está bien. 

Let’s try something simpler. 

¿Puede decir “Hola”? 

Go ahead, slowly.

   AFTER THREE MISSES: beat = Perdón, no entiendo

   LEARNER: Perdón, no entiendo
      · learner turn → advanced
   TUTOR: Entiendo, no se preocupe. Voy a repetir más despacio. 

¿Puede decir: "Sí"? 

Simplemente: "Sí". 

(Sí, es la palabra.)
      · re-drill of the closed line? false

   LEARNER: Sí
      · learner turn → advanced
   TUTOR: Muy bien, lo dijo bien. 

Ahora, por favor, ¿habla inglés? 

(Please, do you speak English?) 

Tómese su tiempo.
      · re-drill of the closed line? false

   LEARNER: Por favor, ¿habla inglés?
      · learner turn → advanced
   TUTOR: Sí, hablo inglés un poco. 

¿Qué necesita, exactamente?
      · re-drill of the closed line? false

   RE-DRILLS OF A CLOSED LINE IN THE LAST THREE TURNS: 0
```

---

## What this run does NOT prove

* **Nobody has spoken to it.** Every learner turn above is `input_text` on a
  WebSocket. Audio adds a recognizer between the mouth and
  `lineMatchScore` — accents dropped, articles eaten, the odd invented word —
  which is why the match threshold is 0.6 and not 0.9. A phone session is
  still owed.
* **Run was not driven live.** Its checkpoints are unit-tested
  (`tests/tutor-beats.test.ts`) and share every prompt rule with Walk, but no
  live Run session was minted for this run.
* **One language pair, one module.** EN learner → ES, module 1. The machinery
  is language-agnostic by construction (the beats come from the generated
  lesson, not from a table), but "by construction" is not "observed".

## Re-running it

The harness is not committed — it calls paid providers and CI runs `vitest run`
on every PR. Its shape is the one in `docs/tutor-phase1-verification.md`, plus
a `Scene` class that applies `onLearnerTurn` / `onTutorTurn` to each turn and
re-pushes `session.update` with persona + script position. Save it as
`tests/_live-verify.test.ts`, run `npx vitest run tests/_live-verify.test.ts`,
delete it again.
