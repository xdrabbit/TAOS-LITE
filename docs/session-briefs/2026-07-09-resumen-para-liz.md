# Resumen para Liz — Modo en vivo (/live), 9 de julio de 2026

> Plain-language Spanish summary of the 2026-07-08/09 /live field-test fixes, written for Liz.
> Technical details live in [2026-07-08-live-ambient.md](2026-07-08-live-ambient.md).

## Los problemas que encontramos

**1. La pantalla del iPhone se apagaba sola.**
Cuando estábamos usando el modo en vivo y nadie tocaba el teléfono, el iPhone pensaba "nadie me
está usando" y apagaba la pantalla. Y lo peor: al apagarse la pantalla, el iPhone también
**pausaba la aplicación por completo** — así que el intérprete dejaba de escuchar sin avisar.

**2. La app "inventaba" cosas cuando nadie hablaba.**
Cuando había silencio, un ruidito cualquiera — un plato, una tos, una silla — engañaba a la app
y le hacía creer que alguien había hablado. Entonces la inteligencia artificial, en vez de
quedarse callada, se sentía obligada a decir *algo*... y se inventaba frases que nadie dijo.
Como un estudiante que no leyó el libro pero igual quiere contestar la pregunta. 😅

**3. Los resúmenes salían entrecortados y a veces perdían el hilo.**
La app cortaba las oraciones en pedacitos muy pequeños, y con pedacitos no se puede hacer un
buen resumen.

## Cómo lo arreglamos

**1. La pantalla ya no se apaga.**
Mientras el modo en vivo está encendido, la app le dice al iPhone: "no te duermas, te estamos
leyendo." Cuando tocas STOP, lo suelta y el teléfono vuelve a lo normal.

**2. Ahora exige pruebas antes de hablar.**
Pusimos una regla nueva: la app solo hace un resumen si primero **comprueba que se escucharon
palabras de verdad**. Si solo fue un ruido, no dice nada — ni una palabra inventada. Silencio
real = silencio en tu oído.

**3. Escucha oraciones completas y usa un "cerebro" mejor.**
Ahora espera un poquito más antes de cortar (para captar la idea completa, no pedacitos), y
cambiamos al modelo de inteligencia artificial más potente — el anterior era el "económico" y se
distraía. El nuevo sigue la conversación mucho mejor. Cuesta un poco más (como $1–2 de dólar por
hora de conversación), pero vale la pena.

## En resumen

**La pantalla se queda encendida, ya no inventa cosas, y resume mejor.**
¡Lista para la próxima cena! 🍷
