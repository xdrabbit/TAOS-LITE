# TAOS — Plan de Pruebas (para Liz)

**App (producción):** https://taos-lite.vercel.app
**Tutor:** https://taos-lite.vercel.app/tutor · **Versión gratis:** https://taos-lite.vercel.app/try

---

## Antes de empezar — léelo

- **Todavía NO se cobra dinero real.** En producción seguimos en el **modo de prueba** de Stripe, así que cada "Subscribe" / "Buy pack" usa una **tarjeta de prueba** y no cobra nada. El cambio a dinero real se hace al final (Parte H, domingo/lunes).
- **Tarjeta de prueba:** número `4242 4242 4242 4242`, cualquier fecha futura (ej. `12/34`), cualquier CVC (ej. `123`), cualquier código postal.
- **Vas a necesitar 2–3 cuentas de correo nuevas** (o alias de Gmail como `tunombre+prueba1@gmail.com`) para hacer de "cliente nuevo". Las cuentas de Tom y Liz son **ilimitadas (comp)**, así que **NO** verán los límites gratis ni los avisos de pago — eso solo se ve con una cuenta nueva.
- Marca cada casilla al terminar. Si algo falla, anota el número de la prueba y qué viste.

> Nota: algunos botones de pago y del tutor aparecen en inglés. Entre comillas pongo el texto exacto del botón.

---

## Parte A — Cuentas e inicio de sesión

| # | Paso | Resultado esperado | ✓ |
|---|------|--------------------|---|
| A1 | Abre la app en una ventana privada/incógnito | Aparece la pantalla de inicio de sesión | ☐ |
| A2 | Inicia sesión con Google (cuenta nueva) | Entra al traductor | ☐ |
| A3 | Cierra sesión y vuelve a entrar | Regresa a tus mismos datos | ☐ |
| A4 | (Tom/Liz) Entra con tu cuenta normal | No aparece ningún aviso de pago (eres ilimitada) | ☐ |

---

## Parte B — Traductor, plan gratis (con la cuenta nueva)

| # | Paso | Resultado esperado | ✓ |
|---|------|--------------------|---|
| B1 | Mira el aviso de arriba | "Free · 25 translations left this month" | ☐ |
| B2 | Toca el micrófono, di una frase completa en inglés, toca otra vez | Aparece la traducción al español y se escucha en voz alta | ☐ |
| B3 | Di algo en español | La detección automática lo cambia a inglés correctamente | ☐ |
| B4 | Toca **"Flip · Voltear"** en un resultado | Vuelve a traducir el mismo audio en la otra dirección | ☐ |
| B5 | Toca el icono de la bocina en un resultado | Reproduce la voz de la traducción | ☐ |
| B6 | Abre **"History"** y borra un elemento | Desaparece; el historial es solo tuyo | ☐ |
| B7 | Sigue traduciendo hasta llegar a 0 | El aviso se pone rojo: "Free translations used up this month"; el micrófono se desactiva; aparece **"Upgrade"** | ☐ |

> Consejo: para llegar a 0 rápido, di frases cortas — son 25 al mes.

---

## Parte C — Tutor, plan gratis (cuenta nueva)

| # | Paso | Resultado esperado | ✓ |
|---|------|--------------------|---|
| C1 | Entra a **/tutor**, pestaña **"Drills"**, toca "Hear it" y graba una frase | Aparece la puntuación de pronunciación con colores por palabra | ☐ |
| C2 | Cambia a la pestaña **"Conversation"** | La tarjeta dice "Free trial · 15 tutor min left this month" (o similar) | ☐ |
| C3 | Elige idioma y nivel, toca **"Start talking"** | El tutor te saluda en voz alta en ~2 segundos | ☐ |
| C4 | Conversa un poco de ida y vuelta | Responde con voz y te corrige la pronunciación | ☐ |
| C5 | Toca un botón de tema ("More English", "Kitchen words", etc.) | El tutor se adapta | ☐ |
| C6 | Deja de hablar ~20 segundos | La sesión se pausa sola (por silencio) | ☐ |
| C7 | Toca **"Mic off"** y luego **"End conversation"** | Se silencia el micrófono; la sesión termina bien | ☐ |
| C8 | Usa los 15 minutos completos (varias sesiones) | La tarjeta dice "used up" + botón **"See plans"** | ☐ |

---

## Parte D — Suscripciones y niveles (tarjeta de prueba)

| # | Paso | Resultado esperado | ✓ |
|---|------|--------------------|---|
| D1 | Como usuaria gratis sin minutos, toca **"Upgrade / See plans"** | Aparecen **Basic $5.99** y **Premium $19.99** | ☐ |
| D2 | Elige **Basic** y paga con la tarjeta de prueba | Vuelve a la app; las traducciones quedan ilimitadas (sin aviso) | ☐ |
| D3 | Ve al tutor, **"Conversation"** | Ahora dice "45 tutor min left this month" | ☐ |
| D4 | (Otra cuenta nueva) Suscríbete a **Premium** | El tutor muestra "200 tutor min left this month"; traducciones ilimitadas | ☐ |
| D5 | Revisa el cobro en el panel de Stripe (modo prueba) | Aparece un pago de prueba de $5.99 / $19.99 | ☐ |

---

## Parte E — Paquetes de minutos extra (tarjeta de prueba, cuenta de pago)

| # | Paso | Resultado esperado | ✓ |
|---|------|--------------------|---|
| E1 | En una cuenta **Basic**, usa los 45 minutos del mes | La conversación dice "used up" → **"Upgrade for more"** | ☐ |
| E2 | Abre los planes; confirma que aparecen los paquetes | "Need more tutor minutes this month?" con **"+100 · $9.99"** y **"+200 · $17.99"** | ☐ |
| E3 | Compra **"+100 min"** con la tarjeta de prueba | Vuelve a /tutor; en unos segundos los minutos suben 100 | ☐ |
| E4 | Inicia una conversación | Funciona otra vez con los minutos del paquete | ☐ |
| E5 | (Opcional) Como usuaria **gratis**, confirma que NO aparecen los paquetes | A las cuentas gratis se les pide suscribirse primero | ☐ |

---

## Parte F — Manejo de la suscripción

| # | Paso | Resultado esperado | ✓ |
|---|------|--------------------|---|
| F1 | En una cuenta de pago, abre planes → **"Manage billing"** | Se abre el portal de clientes de Stripe | ☐ |
| F2 | Cancela la suscripción en el portal | De vuelta en la app, la cuenta baja a **gratis** (25/15 otra vez, no se bloquea) | ☐ |

---

## Parte G — Revisión de privacidad

| # | Paso | Resultado esperado | ✓ |
|---|------|--------------------|---|
| G1 | Entra con la cuenta #1 y haz una traducción | Queda en el historial de la cuenta #1 | ☐ |
| G2 | Entra con la cuenta #2 | La cuenta #2 NO ve el historial ni las conversaciones de la #1 | ☐ |

---

## Parte H — ACTIVAR el dinero real (hacerlo al final)

> Hasta hacer esto, todos los pagos de arriba son de prueba. Este es el cambio del lunes.
> Tom maneja el panel de Stripe y Vercel; Claude puede crear los precios reales cuando Stripe esté en modo **Live**.

- ☐ **H1.** En Stripe, cambia de **Test mode** a **Live mode** (interruptor arriba a la derecha).
- ☐ **H2.** Crear los cuatro precios **en vivo** (Claude lo puede hacer): Basic $5.99/mes, Premium $19.99/mes, paquete $9.99 (100 min), paquete $17.99 (200 min).
- ☐ **H3.** Crear el **webhook en vivo** → `https://taos-lite.vercel.app/api/stripe/webhook` y copiar su clave secreta.
- ☐ **H4.** En **Vercel → Settings → Environment Variables (Production)**, poner las claves en vivo (Tom las pega).
- ☐ **H5.** **Volver a desplegar** producción.
- ☐ **H6.** **Prueba real:** con una tarjeta real, suscríbete a Basic ($5.99 de verdad), confirma que se desbloquea, y cancela/reembolsa si quieres.
- ☐ **H7.** ¡Ya están en vivo! 🎉

---

## Notas (v1)

- **Tom y Liz son ilimitados** — no verán límites ni paquetes; es a propósito.
- **Los minutos se reinician el día 1 (UTC).** Los minutos de los paquetes valen **hasta fin del mes en curso** (no se acumulan).
- **Cambiar de plan** (ya siendo suscriptor) se hace en el portal de Stripe, no con un botón dentro de la app (para no cobrar doble).
- Si un pago no se refleja al instante, espera ~5 segundos (el sistema se está poniendo al día) o recarga la página.
