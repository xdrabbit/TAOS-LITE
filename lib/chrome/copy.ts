// The words TAOS's own CHROME is written in — buttons, statuses, hints, the
// banner that says why nothing is happening. NOT the words it translates:
// those are the whole catalog (lib/languages/catalog.ts), all hundred of them.
//
// ── Why this is one file ───────────────────────────────────────────────────
// It used to be three. The home screen kept a six-language table inside
// components/TranslatorShell.tsx, /tabletop kept a two-language cut-down twin
// of it, and /call kept none at all — so /call's screen was English with a
// Spanish half glued onto the important lines, and Liz, who owns most of this
// company and cannot read English well, did not use it. Three tables meant
// adding a language was three edits in three files, two of which you would
// forget.
//
// ── The rule that matters ──────────────────────────────────────────────────
// ENGLISH IS THE ONLY COMPLETE TABLE. Every other language is a Partial, and
// any key it does not have falls back to English, key by key — not whole
// screens, not blanks, not a crash. That is what makes adding a language ONE
// entry in TRANSLATIONS below, with as many or as few keys as somebody could
// actually check.
//
// This is load-bearing, not defensive decoration. The woman who asked for
// Samoan for her grandfather is not waiting for a Samoan chrome translation
// to exist: `sm` reaches the whole app today, translating faithfully into
// Samoan with English buttons, and the buttons get better the day somebody
// who speaks Samoan writes them. A language nobody here can check is a
// language we ship anyway, with English chrome, rather than hold back.
//
// So: do NOT invent translations in a language nobody at this table reads.
// An absent key is honest. A guessed one is a bug you cannot see.

import { ROLLOVER_NOTE } from "@/lib/tutor/meterCopy";

/**
 * The complete table. Every key in the app is declared here, in English, and
 * this object is what the TYPE is derived from — so adding a key is adding a
 * line here, and adding a LANGUAGE never touches a type at all.
 */
const EN = {
  // ── Home (/) — spoken push-to-talk ──────────────────────────────────────
  speak: "Speak",
  stop: "Stop & Translate",
  working: "Working…",
  speakingNow: "Speaking now",
  swap: "Swap",
  listening: "Listening…",
  translating: "Translating…",
  idle: "Tap the mic, speak a full thought, tap again.",
  heard: "Heard",
  translationLabel: "Translation",
  wrapUp: "Wrapping up — auto stop & translate in a few seconds…",
  micUnavailable: "Microphone not available. Open this page over HTTPS in Safari and allow mic access.",
  micDenied: "Microphone permission was denied. Enable it in Safari settings and retry.",
  ttsFailed: "Voice playback failed.",
  translateFailed: "Translation failed.",
  connectionLost: "Connection problem — check your signal and try again.",
  noAudio: "No audio was captured. Check the mic and try again.",
  tooShort: "Too short — tap, say a full thought, then tap again.",

  // The rest of home's own words. Every one of these was "English · Español"
  // or English alone until 2026-10-04, when Tom chose to put them all in the
  // owner's language: a doubled label reads as clutter to both people, and an
  // English-only upgrade prompt is one Liz cannot read at all. The record
  // button's "Speak · Hablar" in auto-detect is NOT here and stays doubled on
  // purpose — it greets both people at once (speakPrompt in TranslatorShell).
  translateInto: "Translate into",
  autoDetect: "Auto-detect",
  autoDetectLanguage: "Auto-detect language",
  autoPlayVoice: "Auto-play voice",
  premiumVoices: "Premium voices",
  // The voice-engine picker's row label (Fish Audio / ElevenLabs / OpenAI),
  // its own row since 2026-10-06.
  voiceEngine: "Voice",
  flip: "Flip",
  flipAria: "Flip direction",
  flipTitle: "Wrong direction? Re-translate the same recording the other way",
  play: "Play",
  playAria: "Play translation",
  // The free-trial banner. {count} is a slot, not a seam (see fill below);
  // the singular is its own key because a language may change more than the
  // noun when there is only one left — Spanish changes the verb too.
  trialLeft: "Free · {count} translations left this month",
  trialLeftOne: "Free · 1 translation left this month",
  trialUsedUp: "Free translations used up this month",
  upgrade: "Upgrade",
  // The language picker's own controls and the install banner — the last of
  // home's doubled or half-translated words, moved here on 2026-10-04 so home
  // reads in one language end to end. `yours` is the sheet's badge on the
  // phone owner's own language; it was English-only, so a Spanish reader
  // could not tell what it was marking. The picker's defaults stay doubled
  // for the screens that do not pass these yet (components/LanguagePicker.tsx).
  moreLanguages: "+ More",
  moreLanguagesAria: "More languages",
  close: "Close",
  yours: "Yours",
  // The rest of the sheet, which was doubled too and turned up when the four
  // above were walked in Chrome: its name, the search box, the empty result.
  chooseLanguage: "Choose a language",
  searchLanguages: "Search…",
  searchLanguagesAria: "Search languages",
  noLanguageMatches: "No language matches",
  installTitle: "Install TAOS on your phone 📲",
  installHowIos: "Share → Add to Home Screen",
  installHowOther: "Full screen, one tap from your home screen",
  install: "Install",
  installDismiss: "Dismiss install prompt",

  // ── The nav on the home header — pills, the nine-dot grid, the avatar ───
  // In the language of the phone's OWNER (`mine`), the same rule /call uses,
  // because the header belongs to whoever is holding the phone, not to
  // whoever happens to be talking. These were "Table · Mesa", "Sign out ·
  // Salir" and so on until they reached this table: doubling was the only way
  // one string could serve both people, and it is exactly what the /call
  // table removed. Each phone reads its own language now.
  navAllScreens: "All screens",
  navCloseMenu: "Close menu",
  navAccount: "Account",
  navScreens: "Screens",
  navSpeak: "Speak",
  navTranslate: "Translate",
  navLive: "Live",
  navTable: "Table",
  // No navChat: "Chat" is the same word in Spanish, so there is nothing to
  // translate and nothing that was ever doubled except "Chat · Chat" itself.
  // A key whose Spanish equals its English fails tests/chrome-copy.test.ts
  // (every Spanish key must really be Spanish), so the header prints it plain.
  navCall: "Call",
  navFast: "Quick translate",
  navPhoto: "Photo translator",
  navVideo: "Video captions",
  navTutor: "Language tutor",
  navStudy: "Study",
  navHistory: "History",
  navGuide: "How to use TAOS",
  navAbout: "About TAOS",
  navSignOut: "Sign out",

  // ── Table (/tabletop) — one phone flat between two people ───────────────
  // `tableListening` is prefixed and the rest are not, and that is the whole
  // of the difference between these screens' wording: /tabletop's listening
  // line names the OTHER SIDE ("Listening to the other side…") because the
  // pane you are reading is not the pane that is recording. Home's plain
  // "Listening…" would be wrong there, so it keeps its own key rather than
  // quietly changing what is on Liz's screen. Everything else below was
  // already unique to the table, and `translating` was word-for-word
  // identical in both tables, so it is shared.
  tapToTalk: "TAP TO TALK",
  tapDone: "TAP WHEN DONE",
  tableListening: "Listening to the other side…",
  connecting: "Connecting…",
  theySaid: "They said",
  youSaid: "You said",
  idleHint: "Lay the phone flat between you",

  // ── Call (/call) — two phones, one interpreter each ─────────────────────
  // These were English-only or English-with-a-Spanish-half until this table
  // reached the screen. The doubling ("connected · conectado") was the only
  // way a bilingual pair could both read one phone; each person is holding
  // their OWN phone on a call, so the doubling is gone and each phone speaks
  // its owner's language.
  home: "← Home",
  callTitle: "Translated call",
  callBlurb:
    "Call each other over wifi or cellular — video or voice-only. Each of you hears the other person plus an interpreter in your own language, with live captions.",
  // {language} is placed by the translator, not by the code. The code splits
  // the sentence AT the token (splitAround) so the language name can still be
  // highlighted without anybody gluing two half-sentences together.
  callYouHear: "You hear {language}. Their phone announces what they speak when the call connects.",
  callVideoCall: "📹 Video call",
  callVoiceOnlyMode: "🎧 Voice only",
  callVoiceClone: "🎙️ Their voice",
  callVoiceInstant: "⚡ Fastest",
  callVoiceCloneHint: "The translation is read in their own voice — about a second behind.",
  callVoiceInstantHint:
    "The model speaks it the moment it can. A stock voice, and the priciest way to run a call.",
  callRoom: "Room",
  callRoomPlaceholder: "Room code",
  callNewCode: "New code",
  callShareLink: "Share link",
  callLinkCopied: "Link copied ✓",
  callSameCode: "Same code on both phones = same call.",
  callJoin: "Join call",
  callHangUp: "Hang up",
  callNeedRoom: "Enter or create a room code first.",

  // The preflight panel's own chrome. The relay and probe VERDICTS inside it
  // (lib/call/relay.ts, lib/call/relayProbe.ts) are still bilingual English +
  // Spanish and are deliberately not in here: they name Vercel env vars and
  // HTTP statuses, and they are read by whoever is fixing the keys.
  callBeforeYouDial: "Before you dial",
  callTestConnection: "Test connection",
  callTesting: "Testing…",
  callTestHint: "Forces a relay-only connection to this phone. ~1s.",
  callTestDetails: "Test details",
  callConnectionDetails: "Connection details",

  // Connection state, on the pill over the video.
  callMedia: "camera/mic…",
  callWaiting: "waiting…",
  callConnecting: "connecting…",
  callConnected: "connected",
  callReconnecting: "reconnecting…",
  callNotConnected: "not connected",
  callVoiceCallFallback: "voice call",
  callDirect: "direct",
  callRelay: "relay",
  callLinked: "linked",
  callNoRelay: "no relay",
  callDirectTitle: "Peer-to-peer. No relay bandwidth is being spent.",
  callRelayTitle:
    "Relayed through Cloudflare — one of you is on a network with no direct path.",
  callNoRelayTitle:
    "No TURN relay is configured, so this call can only connect if a direct path exists.",
  callMeterTitle: "This phone's share of the call. Your partner's phone spends its own.",

  // The interpreter indicator. Label is the line on the video; hint is the
  // sentence under it and the one the caption panel borrows when captions
  // cannot come. See lib/call/interpreterStatus.ts for why `on` and `hearing`
  // are different states.
  interpreterHearingLabel: "Interpreter: ✓ on",
  interpreterHearingHint:
    "The interpreter is running and can hear your partner. Captions appear over the video as they speak.",
  interpreterOnLabel: "Interpreter: on",
  interpreterOnHint:
    "The interpreter is connected. It has not heard your partner speak yet — captions start with their first sentence.",
  interpreterStartingLabel: "Interpreter: starting…",
  interpreterStartingHint: "Connecting to the interpreter. This takes a second or two.",
  interpreterNotNeededLabel: "Interpreter: not needed",
  interpreterNotNeededHint:
    "You and your partner are set to the same language, so there is nothing to interpret. Change either side to start it.",
  interpreterFailedLabel: "Interpreter: ✗ failed",
  interpreterFailedHint: "The interpreter stopped. Tap Rejoin to try again.",
  interpreterOffLabel: "Interpreter: off",
  interpreterOffHint:
    "The interpreter is not running, so there are no captions and no translated voice.",

  // In-call banners and controls.
  callAssumed: "(assumed)",
  callTheirVoiceShort: "their voice",
  callFastestVoiceShort: "fastest voice",
  // {seconds} is a countdown. It is ONE template with a slot rather than
  // "Quiet for a while — the interpreter stops in about " + n + "s…", because
  // a language that puts the number somewhere else cannot be built out of
  // English's fragments.
  callIdleNotice:
    "Quiet for a while — the interpreter stops in about {seconds}s to save money. Say anything to keep it.",
  callPeerSpeaking: "Interpreter is still speaking to them — one sec…",
  callCaptionsWaiting: "Captions appear here as soon as they speak.",
  callCaptionsListening: "Listening… captions appear as they speak.",
  callCaptionsOffNotice: "Captions are OFF — tap to show them.",
  callRejoin: "↻ Rejoin",
  // Resync (PR #67) is the same rebuild as Rejoin, offered while the
  // interpreter is still running. Its own key so that, like Rejoin, it
  // reads in one language rather than "↻ Resync · Resincronizar".
  callResync: "↻ Resync",
  callResyncHint: "Translations falling behind? This restarts the interpreter only — the call stays up.",
  callMicOn: "🎙️ Mic on",
  callMicOff: "🔇 Mic off",
  callCamOn: "📹 Cam on",
  callCamOff: "📷 Cam off",
  callVoiceOn: "🗣️ Voice on",
  callVoiceOff: "🔇 Voice off",
  callVoiceTitle: "The interpreter's spoken translation, in your ear.",
  callCaptionsOn: "💬 Captions on",
  callCaptionsOff: "💬 Captions off",
  callCaptionsTitle: "The translated text on this screen.",
  callVolumeFull: "🔊 Their real voice: full",
  callVolumeQuiet: "🔉 Their real voice: quiet",
  callVolumeMuted: "🔈 Their real voice: off",
  callHearingInterpreter: "You hear the interpreter speaking their words in your language.",
  callVoiceOffCaptionsOn: "The interpreter's voice is off — the captions above are still running.",
  callNothingTranslated:
    "The interpreter's voice is off AND captions are off, so nothing is being translated to you.",
  callTheirVoiceMuted: "Their own voice is muted underneath.",
  callTheirVoiceQuiet: "Their own voice plays quietly underneath, so you can hear them talking.",
  callTheirVoiceFull: "Their own voice plays at full volume underneath.",
  callYouHearThis: "You hear this",
  callTheySpeak: "They speak",
  callWhatTheySpeak: "What they speak",
  callMidCallPair:
    "You hear {language} — the outlined pill, and it stays put while you are on a call. Tap another pill to change what your partner speaks.",

  // Notices the screen raises about the interpreter.
  callSameLanguage: "You and your partner are both on {language} — no interpreter needed.",
  callInterpreterError: "Interpreter: {reason}",
  callInterpreterDeaf:
    "Interpreter is connected but hearing nothing — try Resync, and check the trail below.",
  callIdleEnded:
    "The interpreter stopped after two minutes of quiet — tap Rejoin to bring it back. You are still on the call.",
  callLimitEnded:
    "The interpreter hit its one-hour limit — tap Rejoin to start a fresh hour. You are still on the call.",
  callWaitingAudio: "Waiting for your partner's audio — the interpreter starts when it arrives.",
  callPartnerLeft: "Your partner left the call. Waiting for them to rejoin…",
  callCameraFailed: "Could not switch the camera.",
  callInterpreterStartFailed: "The interpreter could not start.",

  // ── The paywall (components/Paywall.tsx) — plans, prices, the buy buttons ─
  // Tom's decision, 2026-10-04: after #83 Liz read "Mejorar el plan" on home,
  // tapped it, and landed on a paywall that was English from top to bottom.
  // It is the one screen where a word she cannot read costs money, so it
  // reads in the phone owner's language like the rest of home. Prices and
  // the numbers inside these sentences are NOT localised: "$5.99" is "$5.99"
  // on every phone, and the minute counts are the ones lib/tutor/meter.ts
  // enforces (tests/tutor-metering.test.ts holds them equal).
  // "Premium" has no key: it is the same word in Spanish, and a Spanish key
  // equal to its English fails tests/chrome-copy.test.ts, the navChat rule.
  paywallTitle: "Choose your plan",
  paywallFreeNow: "You're on the free plan (25 translations / month). Paid plans lift that limit today.",
  paywallFreeWithTutor: "You're on the free plan (25 translations + 15 tutor min / month).",
  paywallOnPlan: "You're on {plan}.",
  paywallBasic: "Basic",
  paywallPerMonth: "/ mo",
  paywallUnlimited: "Unlimited translation",
  paywallTutorBasic: "45 tutor minutes / month",
  paywallTutorPremium: "200 tutor minutes / month",
  paywallDrills: "Drills + progress",
  paywallCurrentPlan: "Current plan",
  paywallOpening: "Opening…",
  paywallSwitchTo: "Switch to {plan}",
  paywallGet: "Get {plan}",
  paywallPacksSoon: "Add-on tutor minute packs",
  paywallPacksSoonBody:
    "The +100 and +200 minute packs go on sale when the tutor arrives. They never expire — pack minutes roll over, while a plan's minutes reset monthly. Your plan's unlimited translation is unaffected.",
  paywallMoreMinutes: "Need more tutor minutes this month?",
  // The sentence a pack buyer is owed before the charge; its wording lives in
  // lib/tutor/meterCopy.ts, where the tutor's own out-of-minutes panel reads
  // it too, so the two cannot drift.
  paywallRollover: ROLLOVER_NOTE.en,
  paywallManageBilling: "Manage billing",
  paywallSignInAgain: "Please sign in again.",
  paywallCheckoutFailed: "Could not start checkout.",
  paywallBillingFailed: "Could not open billing.",
  // lib/release.ts's COMING_SOON, one language at a time. The doubled
  // constant stays for Landing, which has no phone owner to ask.
  comingSoon: "Coming soon"
} as const;

/** Every key the chrome can ask for. Derived — never hand-written. */
export type ChromeKey = keyof typeof EN;

/** A full, gap-free set of chrome words. What `copyFor` always returns. */
export type ChromeCopy = Record<ChromeKey, string>;

/**
 * Every language that is NOT English, each holding as much or as little as
 * somebody could actually check.
 *
 * Adding a language is adding ONE entry here. There is no type to widen, no
 * union to extend, and no obligation to fill it in: `{}` is a legal entry and
 * behaves exactly like being absent.
 */
const TRANSLATIONS: Record<string, Partial<ChromeCopy>> = {
  es: {
    speak: "Hablar",
    stop: "Detener y traducir",
    working: "Procesando…",
    speakingNow: "Hablando ahora",
    swap: "Cambiar",
    listening: "Escuchando…",
    translating: "Traduciendo…",
    idle: "Toca el micrófono, di una idea completa y toca otra vez.",
    heard: "Se escuchó",
    translationLabel: "Traducción",
    wrapUp: "Terminando — se detiene y traduce en unos segundos…",
    micUnavailable: "Micrófono no disponible. Abre esta página con HTTPS en Safari y permite el micrófono.",
    micDenied: "Se denegó el permiso del micrófono. Actívalo en los ajustes de Safari e inténtalo de nuevo.",
    ttsFailed: "No se pudo reproducir la voz.",
    translateFailed: "No se pudo traducir.",
    connectionLost: "Problema de conexión — revisa tu señal e inténtalo de nuevo.",
    noAudio: "No se captó audio. Revisa el micrófono e inténtalo de nuevo.",
    tooShort: "Muy corto — toca, di una idea completa y toca otra vez.",

    // The Spanish half of each label home used to double, unchanged, where
    // there was one. The banner, the Upgrade button and the Flip tooltip were
    // English-only and had none: trialUsedUp is /fast's quota refusal
    // (lib/fast/meter.ts), upgrade is /guide's "Mejorar el plan", and
    // trialLeft, trialLeftOne and flipTitle are new on 2026-10-04.
    translateInto: "Traducir a",
    autoDetect: "Detección automática",
    autoDetectLanguage: "Detectar idioma",
    autoPlayVoice: "Reproducir voz",
    premiumVoices: "Voces premium",
    voiceEngine: "Voz",
    flip: "Voltear",
    flipAria: "Voltear",
    flipTitle: "¿Dirección equivocada? Vuelve a traducir la misma grabación al revés",
    play: "Oír",
    playAria: "Reproducir traducción",
    trialLeft: "Gratis · quedan {count} traducciones este mes",
    trialLeftOne: "Gratis · queda 1 traducción este mes",
    trialUsedUp: "Se acabaron las traducciones de este mes",
    upgrade: "Mejorar el plan",
    // The Spanish halves the picker and the install banner already carried,
    // unchanged, where there were any: Más, Más idiomas, Cerrar, Descartar,
    // Elegir idioma, Buscar, Buscar idiomas, Ningún idioma coincide,
    // "Compartir → Añadir a inicio", and /guide's "Instalar". New on
    // 2026-10-04: yours (the badge was English-only), installTitle (the
    // banner's first line was English-only), and installHowOther, which had
    // only the tail "Pantalla completa" and now says the whole sentence.
    moreLanguages: "+ Más",
    moreLanguagesAria: "Más idiomas",
    close: "Cerrar",
    yours: "Tu idioma",
    chooseLanguage: "Elegir idioma",
    searchLanguages: "Buscar…",
    searchLanguagesAria: "Buscar idiomas",
    noLanguageMatches: "Ningún idioma coincide",
    installTitle: "Instala TAOS en tu teléfono 📲",
    installHowIos: "Compartir → Añadir a inicio",
    installHowOther: "Pantalla completa, a un toque desde tu inicio",
    install: "Instalar",
    installDismiss: "Descartar",

    // The Spanish half of each label the header used to double, unchanged.
    // navAllScreens, navAccount, navScreens, navLive and navTutor are the
    // nav restructure's own words (PR #55) and had no older Spanish to keep.
    navAllScreens: "Pantallas",
    navCloseMenu: "Cerrar menú",
    navAccount: "Cuenta",
    navScreens: "Pantallas",
    navSpeak: "Hablar",
    navTranslate: "Traducir",
    navLive: "En vivo",
    navTable: "Mesa",
    navCall: "Llamada",
    navFast: "Rápida",
    navPhoto: "Fotos",
    navVideo: "Subtítulos",
    navTutor: "Tutor de idiomas",
    navStudy: "Estudio",
    navHistory: "Historial",
    navGuide: "Cómo usar",
    navAbout: "Acerca de TAOS",
    navSignOut: "Salir",

    tapToTalk: "TOCA PARA HABLAR",
    tapDone: "TOCA AL TERMINAR",
    tableListening: "Escuchando al otro lado…",
    connecting: "Conectando…",
    theySaid: "Dijo",
    youSaid: "Dijiste",
    idleHint: "Pon el teléfono entre ustedes",

    home: "← Inicio",
    callTitle: "Llamada traducida",
    callBlurb:
      "Llámense por wifi o datos — con video o solo voz. Cada uno escucha a la otra persona y además un intérprete en su propio idioma, con subtítulos en vivo.",
    callYouHear: "Escuchas {language}. Su teléfono avisa qué habla cuando se conecta la llamada.",
    callVideoCall: "📹 Videollamada",
    callVoiceOnlyMode: "🎧 Solo voz",
    callVoiceClone: "🎙️ Su voz",
    callVoiceInstant: "⚡ Lo más rápido",
    callVoiceCloneHint: "La traducción se lee con su propia voz — como un segundo después.",
    callVoiceInstantHint:
      "El modelo la dice apenas puede. Voz estándar, y la forma más cara de hacer una llamada.",
    callRoom: "Sala",
    callRoomPlaceholder: "Código de sala",
    callNewCode: "Código nuevo",
    callShareLink: "Compartir enlace",
    callLinkCopied: "Enlace copiado ✓",
    callSameCode: "El mismo código en los dos teléfonos = la misma llamada.",
    callJoin: "Entrar a la llamada",
    callHangUp: "Colgar",
    callNeedRoom: "Primero escribe o crea un código de sala.",

    callBeforeYouDial: "Antes de llamar",
    callTestConnection: "Probar conexión",
    callTesting: "Probando…",
    callTestHint: "Fuerza una conexión por relé a este teléfono. ~1s.",
    callTestDetails: "Detalles de la prueba",
    callConnectionDetails: "Detalles de conexión",

    callMedia: "cámara/micro…",
    callWaiting: "esperando…",
    callConnecting: "conectando…",
    callConnected: "conectado",
    callReconnecting: "reconectando…",
    callNotConnected: "sin conexión",
    callVoiceCallFallback: "llamada de voz",
    callDirect: "directo",
    callRelay: "retransmitido",
    callLinked: "enlazado",
    callNoRelay: "sin relé",
    callDirectTitle: "Conexión directa entre los dos teléfonos. No se gasta relé.",
    callRelayTitle:
      "Va por Cloudflare — uno de ustedes está en una red sin camino directo.",
    callNoRelayTitle:
      "No hay relé TURN configurado, así que esta llamada solo conecta si existe un camino directo.",
    callMeterTitle: "Lo que gasta este teléfono. El de tu pareja gasta el suyo.",

    interpreterHearingLabel: "Intérprete: ✓ activo",
    interpreterHearingHint:
      "El intérprete está funcionando y escucha a la otra persona. Los subtítulos aparecen sobre el video mientras habla.",
    interpreterOnLabel: "Intérprete: activo",
    interpreterOnHint:
      "El intérprete está conectado. Todavía no ha escuchado hablar a la otra persona — los subtítulos empiezan con su primera frase.",
    interpreterStartingLabel: "Intérprete: iniciando…",
    interpreterStartingHint: "Conectando con el intérprete. Tarda uno o dos segundos.",
    interpreterNotNeededLabel: "Intérprete: no hace falta",
    interpreterNotNeededHint:
      "Tú y la otra persona están en el mismo idioma, así que no hay nada que interpretar. Cambia cualquiera de los dos lados para que empiece.",
    interpreterFailedLabel: "Intérprete: ✗ falló",
    interpreterFailedHint: "El intérprete se detuvo. Toca Reanudar para intentarlo de nuevo.",
    interpreterOffLabel: "Intérprete: apagado",
    interpreterOffHint:
      "El intérprete no está funcionando, así que no hay subtítulos ni voz traducida.",

    callAssumed: "(supuesto)",
    callTheirVoiceShort: "su voz",
    callFastestVoiceShort: "la voz más rápida",
    callIdleNotice:
      "Llevan un rato en silencio — el intérprete se detiene en unos {seconds}s para ahorrar. Di algo para mantenerlo.",
    callPeerSpeaking: "El intérprete todavía les está hablando — un segundito…",
    callCaptionsWaiting: "Los subtítulos aparecen aquí en cuanto hable.",
    callCaptionsListening: "Escuchando… los subtítulos aparecen mientras habla.",
    callCaptionsOffNotice: "Subtítulos APAGADOS — toca para mostrarlos.",
    callRejoin: "↻ Reanudar",
    callResync: "↻ Resincronizar",
    callResyncHint:
      "¿Las traducciones se están atrasando? Esto reinicia solo el intérprete — la llamada sigue.",
    callMicOn: "🎙️ Micro encendido",
    callMicOff: "🔇 Micro apagado",
    callCamOn: "📹 Cámara encendida",
    callCamOff: "📷 Cámara apagada",
    callVoiceOn: "🗣️ Voz encendida",
    callVoiceOff: "🔇 Voz apagada",
    callVoiceTitle: "La traducción hablada del intérprete, en tu oído.",
    callCaptionsOn: "💬 Subtítulos sí",
    callCaptionsOff: "💬 Subtítulos no",
    callCaptionsTitle: "El texto traducido en esta pantalla.",
    callVolumeFull: "🔊 Su voz real: alta",
    callVolumeQuiet: "🔉 Su voz real: bajita",
    callVolumeMuted: "🔈 Su voz real: apagada",
    callHearingInterpreter: "Escuchas al intérprete diciendo sus palabras en tu idioma.",
    callVoiceOffCaptionsOn:
      "La voz del intérprete está apagada — los subtítulos de arriba siguen funcionando.",
    callNothingTranslated:
      "La voz del intérprete está apagada Y los subtítulos también, así que no se te traduce nada.",
    callTheirVoiceMuted: "Su voz real está apagada por debajo.",
    callTheirVoiceQuiet: "Su voz real suena bajita por debajo, para que oigas que está hablando.",
    callTheirVoiceFull: "Su voz real suena a todo volumen por debajo.",
    callYouHearThis: "Tú escuchas esto",
    callTheySpeak: "Ellos hablan",
    callWhatTheySpeak: "Lo que ellos hablan",
    callMidCallPair:
      "Escuchas {language} — la pastilla con borde, y no se mueve mientras estás en la llamada. Toca otra pastilla para cambiar lo que habla la otra persona.",

    callSameLanguage: "Tú y la otra persona están en {language} — no hace falta intérprete.",
    callInterpreterError: "Intérprete: {reason}",
    callInterpreterDeaf:
      "El intérprete está conectado pero no oye nada — prueba Resincronizar y mira los detalles de abajo.",
    callIdleEnded:
      "El intérprete se detuvo después de dos minutos de silencio — toca Reanudar para traerlo de vuelta. Sigues en la llamada.",
    callLimitEnded:
      "El intérprete llegó a su límite de una hora — toca Reanudar para empezar otra. Sigues en la llamada.",
    callWaitingAudio: "Esperando el audio de la otra persona — el intérprete arranca cuando llegue.",
    callPartnerLeft: "La otra persona salió de la llamada. Esperando a que vuelva…",
    callCameraFailed: "No se pudo cambiar la cámara.",
    callInterpreterStartFailed: "El intérprete no pudo arrancar.",

    // The paywall. Reused where the app already had the Spanish: Abriendo…
    // (the sign-in button), Próximamente (COMING_SOON), "minutos de tutor al
    // mes" and the rollover sentence (lib/tutor/meterCopy.ts), "25
    // traducciones al mes" and "los planes de pago" (/guide), "facturación"
    // (/about), "Elige" (/video). Everything else is new on 2026-10-04 and
    // unread by Liz — the PR that added it lists every one.
    paywallTitle: "Elige tu plan",
    paywallFreeNow:
      "Estás en el plan gratis (25 traducciones al mes). Los planes de pago quitan ese límite hoy mismo.",
    paywallFreeWithTutor: "Estás en el plan gratis (25 traducciones + 15 min de tutor al mes).",
    paywallOnPlan: "Estás en el plan {plan}.",
    paywallBasic: "Básico",
    paywallPerMonth: "/ mes",
    paywallUnlimited: "Traducción ilimitada",
    paywallTutorBasic: "45 minutos de tutor al mes",
    paywallTutorPremium: "200 minutos de tutor al mes",
    paywallDrills: "Ejercicios y progreso",
    paywallCurrentPlan: "Tu plan actual",
    paywallOpening: "Abriendo…",
    paywallSwitchTo: "Cambiar a {plan}",
    paywallGet: "Elegir {plan}",
    paywallPacksSoon: "Paquetes adicionales de minutos de tutor",
    paywallPacksSoonBody:
      "Los paquetes de +100 y +200 minutos salen a la venta cuando llegue el tutor. Nunca caducan: los minutos de paquete se acumulan, mientras que los minutos del plan se renuevan cada mes. La traducción ilimitada de tu plan no cambia.",
    paywallMoreMinutes: "¿Necesitas más minutos de tutor este mes?",
    paywallRollover: ROLLOVER_NOTE.es,
    paywallManageBilling: "Administrar facturación",
    paywallSignInAgain: "Vuelve a iniciar sesión.",
    paywallCheckoutFailed: "No se pudo abrir el pago.",
    paywallBillingFailed: "No se pudo abrir la facturación.",
    comingSoon: "Próximamente"
  },

  // ── Written by nobody here since ────────────────────────────────────────
  // bs, it, zh and yue below are exactly the home-screen words they have
  // always had. The /call and /tabletop keys are ABSENT on purpose: nobody at
  // this table reads these four well enough to check a translation, so those
  // screens come up in English for them rather than in a guess. Fill any of
  // them in the day a person who speaks it is in the room.
  bs: {
    speak: "Govori",
    stop: "Zaustavi i prevedi",
    working: "Obrada…",
    speakingNow: "Sada govori",
    swap: "Zamijeni",
    listening: "Slušam…",
    translating: "Prevodim…",
    idle: "Dodirni mikrofon, izgovori cijelu misao, pa dodirni ponovo.",
    heard: "Čulo se",
    translationLabel: "Prijevod",
    wrapUp: "Završavam — automatsko zaustavljanje i prijevod za nekoliko sekundi…",
    micUnavailable:
      "Mikrofon nije dostupan. Otvori ovu stranicu preko HTTPS-a u Safariju i dozvoli pristup mikrofonu.",
    micDenied:
      "Pristup mikrofonu je odbijen. Uključi ga u postavkama Safarija i pokušaj ponovo.",
    ttsFailed: "Reprodukcija glasa nije uspjela.",
    translateFailed: "Prijevod nije uspio.",
    connectionLost: "Problem s vezom — provjeri signal i pokušaj ponovo.",
    noAudio: "Zvuk nije snimljen. Provjeri mikrofon i pokušaj ponovo.",
    tooShort: "Prekratko — dodirni, izgovori cijelu misao, pa dodirni ponovo."
  },
  it: {
    speak: "Parla",
    stop: "Ferma e traduci",
    working: "Elaborazione…",
    speakingNow: "Sta parlando",
    swap: "Cambia",
    listening: "In ascolto…",
    translating: "Traduzione…",
    idle: "Tocca il microfono, di' un pensiero completo, tocca di nuovo.",
    heard: "Sentito",
    translationLabel: "Traduzione",
    wrapUp: "Sto per finire — si ferma e traduce tra pochi secondi…",
    micUnavailable:
      "Microfono non disponibile. Apri questa pagina in HTTPS su Safari e consenti l'accesso al microfono.",
    micDenied:
      "Permesso del microfono negato. Attivalo nelle impostazioni di Safari e riprova.",
    ttsFailed: "Riproduzione vocale non riuscita.",
    translateFailed: "Traduzione non riuscita.",
    connectionLost: "Problema di connessione — controlla il segnale e riprova.",
    noAudio: "Nessun audio registrato. Controlla il microfono e riprova.",
    tooShort: "Troppo breve — tocca, di' un pensiero completo, poi tocca di nuovo."
  },
  zh: {
    speak: "说话",
    stop: "停止并翻译",
    working: "处理中…",
    speakingNow: "正在说话",
    swap: "切换",
    listening: "正在听…",
    translating: "翻译中…",
    idle: "点击麦克风，说完整的一句话，再点一次。",
    heard: "听到",
    translationLabel: "翻译",
    wrapUp: "即将结束 — 几秒后自动停止并翻译…",
    micUnavailable: "麦克风不可用。请在 Safari 中通过 HTTPS 打开此页面并允许使用麦克风。",
    micDenied: "麦克风权限被拒绝。请在 Safari 设置中开启后重试。",
    ttsFailed: "语音播放失败。",
    translateFailed: "翻译失败。",
    connectionLost: "网络连接问题 — 请检查信号后重试。",
    noAudio: "没有录到声音。请检查麦克风后重试。",
    tooShort: "太短了 — 点击，说完整的一句话，再点一次。"
  },
  yue: {
    speak: "講嘢",
    stop: "停低並翻譯",
    working: "處理緊…",
    speakingNow: "而家講緊",
    swap: "轉換",
    listening: "聽緊…",
    translating: "翻譯緊…",
    idle: "撳一下咪高峰，講完一句嘢，再撳一下。",
    heard: "聽到",
    translationLabel: "翻譯",
    wrapUp: "就快完 — 幾秒後自動停低並翻譯…",
    micUnavailable: "用唔到咪高峰。請喺 Safari 用 HTTPS 開呢頁，並允許使用咪高峰。",
    micDenied: "咪高峰權限被拒。請喺 Safari 設定入面開返，再試多次。",
    ttsFailed: "播唔到語音。",
    translateFailed: "翻譯唔到。",
    connectionLost: "網絡有問題 — 檢查吓訊號再試多次。",
    noAudio: "錄唔到聲。檢查吓咪高峰再試多次。",
    tooShort: "太短喇 — 撳一下，講完一句嘢，再撳一下。"
  }
};

/** Which languages have a chrome entry at all. For tests and for /about. */
export const CHROME_LANGUAGES: readonly string[] = ["en", ...Object.keys(TRANSLATIONS)];

/** The English table, for tests that need to assert a fallback landed. */
export const ENGLISH: ChromeCopy = Object.freeze({ ...EN });

// Merging is cheap but it happens on every render of every screen, and the
// answer only changes when the catalog does. One merge per language, ever.
const merged = new Map<string, ChromeCopy>();

/**
 * The chrome words for one language, complete, with English filling any gap.
 *
 * Never returns undefined, never returns a blank, and never throws for a
 * language it has never heard of — `copyFor("sm")` is the whole English
 * table, which is exactly what a Samoan speaker should get on the day before
 * somebody writes Samoan chrome.
 */
export function copyFor(code: string): ChromeCopy {
  const hit = merged.get(code);
  if (hit) return hit;

  const theirs = TRANSLATIONS[code];
  const out: ChromeCopy = { ...EN };
  if (theirs) {
    for (const key of Object.keys(theirs) as ChromeKey[]) {
      const value = theirs[key];
      // An empty string is a key somebody started and did not finish. English
      // carries it — a blank button is worse than a button in the wrong
      // language, because you cannot even guess at it.
      if (typeof value === "string" && value.trim() !== "") out[key] = value;
    }
  }

  // Frozen because this exact object is handed to every screen that asks for
  // this language, forever. One screen doing `copy.speak = …` to patch a
  // label would rewrite it for all of them, on every other screen, for the
  // rest of the session.
  Object.freeze(out);
  merged.set(code, out);
  return out;
}

/**
 * Put values into a template's slots.
 *
 * `fill(c.callIdleNotice, { seconds: 12 })`. The slot lives INSIDE the
 * translated sentence, so a language that wants the number first can put it
 * first. An unknown slot is left alone rather than printed as "undefined" —
 * a translator who mistypes {segundos} gets a visible token, not a lie.
 */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole
  );
}

/**
 * Split a template at one slot, so JSX can put a NODE there.
 *
 * Used where the value is styled — the language name in "You hear Español" is
 * amber. The two halves come out of ONE translated sentence and the token's
 * position is the translator's to choose, which is the whole difference
 * between this and gluing "You hear " to a language name.
 */
export function splitAround(template: string, name: string): [string, string] {
  const token = `{${name}}`;
  const at = template.indexOf(token);
  if (at === -1) return [template, ""];
  return [template.slice(0, at), template.slice(at + token.length)];
}
