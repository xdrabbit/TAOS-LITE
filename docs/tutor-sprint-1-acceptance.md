# TAOS Tutor Sprint 1 Acceptance

This is the final human acceptance pass for the mirrored ten-day Tutor release candidate.
Automated validation must be green first. Human acceptance then verifies the parts tests cannot judge well: teaching clarity, flow, usefulness, and whether a learner can use the product without being coached by the developer.

## Tom · Spanish 1 · Days 1–10

Use the Tutor as a learner, not as a developer. Complete the ten days in order when practical. It is fine to stop and resume.

For each day, verify:

- [ ] I immediately understand what the lesson wants me to do.
- [ ] The Spanish sounds useful and natural enough that I would actually say it.
- [ ] Hear and Slow playback are easy to use.
- [ ] Speaking and scoring work without losing my place.
- [ ] Recall prompts make me attempt the answer before revealing it.
- [ ] Substitutions help me generate a new sentence rather than merely repeat one.
- [ ] Study-word links open gracefully and return me to the lesson cleanly.
- [ ] The deeper word explanation answers the question I was likely to have.
- [ ] Review items feel relevant rather than random.
- [ ] I can tell what I learned by the end of the day.

Milestones:

- [ ] Day 7 feels meaningfully different from an ordinary lesson and exposes weak material.
- [ ] Day 10 feels like a short performance conversation, not another stack of flashcards.
- [ ] After closing/reopening the app, my position and review history remain intact.
- [ ] When signed in on another device/browser, mastery history appears after sync.

Record problems with the smallest useful note: `Day / step / what felt wrong / expected behavior`.

Examples:

- `D3 recall 2 — prompt is too abstract — use a concrete family example.`
- `D6 study card — slow voice still feels fast.`

## Liz · English 1 · Prueba sin instrucciones

Objetivo: Liz debe poder abrir Tutor y usarlo sin que Tom le explique cómo funciona.
No le expliques los botones antes de empezar. Observa dónde duda o pregunta.

Para cada día, comprobar:

- [ ] Entiendo inmediatamente qué debo hacer.
- [ ] Las instrucciones y explicaciones están en español natural y claro.
- [ ] Las frases en inglés son útiles para la vida real.
- [ ] Puedo escuchar la frase normal y despacio sin ayuda.
- [ ] Puedo usar el micrófono, detener la grabación y entender el resultado.
- [ ] Sé cuándo intentar recordar antes de mostrar la respuesta.
- [ ] Los ejercicios de sustitución me ayudan a crear frases nuevas.
- [ ] Puedo tocar una palabra para estudiarla y cerrar la explicación sin perder mi lugar.
- [ ] El repaso parece relacionado con cosas que ya estudié.
- [ ] Al terminar el día entiendo qué aprendí.

Hitos:

- [ ] El Día 7 se siente como un repaso/consolidación real.
- [ ] El Día 10 se siente como una conversación de desempeño real.
- [ ] Cerrar y volver a abrir conserva mi progreso.
- [ ] Si inicio sesión en otro dispositivo/navegador, mi historial de dominio aparece después de sincronizar.

Registrar problemas con una nota breve: `Día / paso / qué confundió / qué esperaba`.

Ejemplo:

- `D4 paso 3 — no entendí que debía hablar — botón o instrucción más clara.`

## Release decision

Sprint 1 may close when:

1. `npm run validate:tutor` passes without skipped required gates.
2. Vercel preview is Ready on the release-candidate commit.
3. No critical issue remains from Tom's Days 1–10 pass.
4. No critical no-instructions issue remains from Liz's Spanish-UI pass.
5. Any accepted non-blocking findings are recorded in `ENHANCEMENTS.md` or the next sprint backlog.
