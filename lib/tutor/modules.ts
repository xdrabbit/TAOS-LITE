// THE curriculum — fourteen survival modules, written once, for every
// language.
//
// docs/tutor-curriculum-plan.md is the spec and the argument; this file is the
// data. The design principle in one line: a module says what a traveler needs
// to ACCOMPLISH, never how a sentence is built. "I need something for a
// headache" is the same human errand in Oaxaca, Delhi and Tehran; the sentence
// that does it is not. Spanish maps almost word-for-word from English, Hindi
// puts the wanting in the dative ("to-me water is-wanted"), Farsi puts the
// verb last and wraps the whole request in taarof. A curriculum that hardcoded
// English/Spanish skeletons would ship 14 lessons that quietly lie in 66 of
// the catalog's languages.
//
// So the model instantiates each module per (target, learner) pair at lesson
// time (lib/tutor/lesson.ts), and the place where the target language builds
// this intent DIFFERENTLY from the learner's own language is the lesson's
// headline teaching moment — the "contrast hook" — not a footnote.
//
// Same single-source-of-truth pattern as lib/languages/catalog.ts: one array,
// one place to add a module, and a union type so a typo in a module id is a
// compile error rather than an empty screen.

/**
 * A pronunciation slot. The generated lesson fills each one with a real phrase
 * in the target language, and Crawl sends exactly those phrases to Azure
 * (app/api/tutor/assess). Symbolic on purpose: "the phrase that makes the
 * request" exists in every language; "por favor" does not.
 */
export type PronunciationTarget =
  | "greet_phrase"
  | "request_phrase"
  | "thank_phrase"
  | "question_phrase"
  | "number_phrase"
  | "name_phrase"
  | "help_phrase"
  | "polite_close_phrase";

export interface TutorModule {
  /** Stable id. Used as a cache key and stored in localStorage progress. */
  id: string;
  /** ENGLISH display name — Tom's side of the picker. */
  title: string;
  /** SPANISH display name — Liz's side, same rule as the language catalog. */
  titleEs: string;
  /** What the learner can DO when the module is finished. Fed to the model. */
  competency: string;
  /** Where this happens. Grounds the roleplay and the vocabulary. */
  situations: readonly string[];
  /** The communicative moves the module drills, in the order they're taught. */
  coreMoves: readonly string[];
  /**
   * Ask the model to surface how the TARGET language structures this intent
   * differently from the LEARNER's language. True everywhere — the flag is in
   * the schema because a module could one day be pure vocabulary with nothing
   * structural to contrast, and that module should say so rather than have the
   * generator invent a difference to fill the slot.
   */
  contrastHook: boolean;
  /**
   * What usually differs here, as a steer — NOT an answer. The model is told
   * to check whether this applies to the actual pair and to ignore it when it
   * doesn't; hardcoding "Hindi uses a dative" into an EN→ES lesson is exactly
   * the failure this whole file is shaped to avoid.
   */
  contrastFocus: string;
  /** The Walk scene: who the tutor plays, and how it should go wrong once. */
  roleplaySeed: string;
  /** Which phrases Crawl scores. See PronunciationTarget above. */
  pronunciationTargets: readonly PronunciationTarget[];
}

const MODULES = [
  {
    id: "first-contact",
    title: "First contact",
    titleEs: "Primer contacto",
    competency:
      "Open and survive a first exchange with a stranger: greet, answer yes/no, be polite, and say you did not understand — without needing to understand the reply.",
    situations: ["street", "shop doorway", "hotel desk", "any first sentence"],
    coreMoves: ["greet", "yes", "no", "please", "thank", "signal_not_understood", "ask_for_english"],
    contrastHook: true,
    contrastFocus:
      "Greetings that change with the time of day or the listener's status; languages where a bare 'yes'/'no' is rude or does not exist as a word and the verb is echoed instead; whether 'please' is a word at all or a verb form.",
    roleplaySeed:
      "You are a shopkeeper greeting someone who has just walked in. Be warm and speak at a normal pace. Once, say something ordinary but fast so the learner has to use their 'I didn't understand' line — then repeat it slowly.",
    pronunciationTargets: ["greet_phrase", "thank_phrase"]
  },
  {
    id: "who-i-am",
    title: "Who I am",
    titleEs: "Quién soy",
    competency:
      "Give your name, where you are from, and a 60-second sketch of yourself; ask the same back and understand the answer.",
    situations: ["introductions", "hostel common room", "seat neighbour", "border desk"],
    coreMoves: ["say_name", "ask_name", "say_origin", "ask_origin", "say_occupation", "say_reason_for_visit"],
    contrastHook: true,
    contrastFocus:
      "Whether names are given family-name-first; whether 'my name is' is possession, a verb of calling, or a topic marker; formal vs familiar 'you' in the very first question you ask a stranger.",
    roleplaySeed:
      "You are a friendly stranger sharing a long bus ride. Introduce yourself first, then ask about the learner. Misunderstand their country once — hear a similar-sounding place instead — and let them correct you.",
    pronunciationTargets: ["name_phrase", "question_phrase"]
  },
  {
    id: "numbers-money",
    title: "Numbers & money",
    titleEs: "Números y dinero",
    competency:
      "Hear a price, say a number back, ask what something costs, and pay without handing over a wallet to be picked through.",
    situations: ["counter", "taxi", "ticket window", "market stall"],
    coreMoves: ["ask_price", "say_number", "confirm_amount", "ask_for_change", "pay"],
    contrastHook: true,
    contrastFocus:
      "Counting systems that break at different places (Hindi's memorized 1-100, French 'quatre-vingt-dix', Chinese 万 as the unit instead of 'thousand'); measure/counter words; whether the currency comes before or after the digits when spoken.",
    roleplaySeed:
      "You are a market seller. Quote a price quickly and naturally, then repeat it slower when asked. Once, quote a number the learner is likely to mishear (a teen vs a ten) and let them confirm it back.",
    pronunciationTargets: ["number_phrase", "question_phrase"]
  },
  {
    id: "needs-wants",
    title: "I need / I want",
    titleEs: "Necesito / Quiero",
    competency:
      "State a need, understand the response, and handle 'we don't have it' without the conversation collapsing.",
    situations: ["pharmacy", "restaurant", "market", "hotel desk"],
    coreMoves: ["request", "quantity", "accept", "decline", "thank"],
    contrastHook: true,
    contrastFocus:
      "How wanting and needing are built at all: Hindi's dative subject ('to-me water is-wanted'), Farsi's verb-final 'mikhām' with taarof softening, Japanese's ～がほしい / ～たい adjective forms, Spanish's near-identical 'quiero/necesito'. Also whether a bare 'I want' is blunt to the point of rude and what softens it.",
    roleplaySeed:
      "You are a pharmacist. A customer needs something for a headache. Be natural, and misunderstand once — offer something for a stomachache first — so the learner has to decline and restate.",
    pronunciationTargets: ["request_phrase", "thank_phrase"]
  },
  {
    id: "where-is",
    title: "Where is…",
    titleEs: "Dónde está…",
    competency:
      "Ask where something is, understand a pointed answer, and get to the bathroom, the station, or the way back to your hotel.",
    situations: ["street", "station", "restaurant", "mall"],
    coreMoves: ["ask_location", "understand_direction", "ask_distance", "ask_repeat_slower", "thank"],
    contrastHook: true,
    contrastFocus:
      "Where the location word sits (postpositions in Hindi/Turkish vs prepositions in Spanish); whether directions come as left/right or as landmarks and compass points; existence verbs that differ from 'to be' (Spanish estar vs ser, Japanese ある/いる).",
    roleplaySeed:
      "You are a passer-by on a busy street. Give directions naturally and a little too fast the first time, using one landmark the learner will not know. When they ask you to slow down, do — and check they got it.",
    pronunciationTargets: ["question_phrase", "thank_phrase"]
  },
  {
    id: "food-drink",
    title: "Food & drink",
    titleEs: "Comida y bebida",
    competency:
      "Order a meal and a drink, declare an allergy so it is actually understood, and ask for the bill.",
    situations: ["restaurant", "café", "street food stall", "bar"],
    coreMoves: ["order", "ask_recommendation", "state_allergy", "ask_ingredients", "ask_bill", "thank"],
    contrastHook: true,
    contrastFocus:
      "Ordering as a plain request vs a set polite formula; whether 'I am allergic to X' translates at all or must become 'X makes me sick' / 'I cannot eat X'; how the bill is asked for (a verb, a gesture-phrase, a fixed idiom).",
    roleplaySeed:
      "You are a waiter at a busy local place. Take the order, recommend one dish, and once bring up an ingredient that collides with the learner's stated allergy so they have to hold the line politely.",
    pronunciationTargets: ["request_phrase", "polite_close_phrase"]
  },
  {
    id: "market-shopping",
    title: "Market & shopping",
    titleEs: "Mercado y compras",
    competency:
      "Point at the thing you want, ask how much, push back on the price, and close or walk away — both without offence.",
    situations: ["market", "shop", "stall", "souvenir stand"],
    coreMoves: ["indicate_item", "ask_price", "counter_offer", "say_too_expensive", "close_deal", "walk_away"],
    contrastHook: true,
    contrastFocus:
      "Demonstratives with more than two distances (this/that/that-over-there); whether haggling is expected or insulting, and the fixed phrases that soften a counter-offer; classifier words needed before 'this one'.",
    roleplaySeed:
      "You are a stall holder who expects to haggle. Open high, act mildly offended at the first counter, then meet in the middle. If the learner starts to walk away, call them back with a better price.",
    pronunciationTargets: ["question_phrase", "number_phrase"]
  },
  {
    id: "getting-around",
    title: "Getting around",
    titleEs: "Transporte",
    competency:
      "Buy a ticket, get into the right vehicle, confirm it goes where you think it goes, and get out at the right place.",
    situations: ["bus station", "taxi", "metro", "ferry dock"],
    coreMoves: ["buy_ticket", "ask_destination_match", "ask_departure_time", "ask_stop", "ask_to_stop_here"],
    contrastHook: true,
    contrastFocus:
      "Yes/no questions formed by particle, word order, or intonation alone; motion verbs that split by direction or by vehicle; how 'does this go to X?' is phrased when the subject is the vehicle rather than the traveler.",
    roleplaySeed:
      "You are a bus driver at a chaotic terminal. Answer in short bursts over engine noise. Once, say the bus goes somewhere that sounds similar but is not the learner's destination, and make them check.",
    pronunciationTargets: ["question_phrase", "polite_close_phrase"]
  },
  {
    id: "sleeping",
    title: "Sleeping",
    titleEs: "Alojamiento",
    competency:
      "Check in, ask what is included, and report a problem with the room clearly enough that someone fixes it.",
    situations: ["hotel desk", "guesthouse", "hostel", "homestay"],
    coreMoves: ["state_reservation", "ask_availability", "ask_price_per_night", "report_problem", "ask_checkout_time"],
    contrastHook: true,
    contrastFocus:
      "Reporting a fault without an agent ('the shower is not working' vs 'the shower does not want to work' vs a stative construction); politeness level expected when complaining; dates and nights as counted units.",
    roleplaySeed:
      "You are a guesthouse owner at the front desk. Be welcoming. When the learner reports a problem, first suggest it is fine, then take it seriously when they insist — let them practise insisting politely.",
    pronunciationTargets: ["request_phrase", "polite_close_phrase"]
  },
  {
    id: "trouble",
    title: "Trouble",
    titleEs: "Problemas",
    competency:
      "Get help fast: say what happened, say what you need, and be understood when you are frightened and your accent is at its worst.",
    situations: ["street", "police station", "hotel desk", "embassy phone call"],
    coreMoves: ["call_for_help", "state_emergency", "say_what_was_lost", "ask_for_police", "give_location", "ask_call_someone"],
    contrastHook: true,
    contrastFocus:
      "The one-word shout for help and whether it differs from the polite request; passive or agentless phrasing for theft ('my bag was taken', 'my bag got lost from me'); tense choices for something that just happened.",
    roleplaySeed:
      "You are a calm police officer taking a report of a stolen bag. Ask short factual questions — when, where, what colour — and keep the learner producing details rather than one long rehearsed sentence.",
    pronunciationTargets: ["help_phrase", "question_phrase"]
  },
  {
    id: "health",
    title: "Health",
    titleEs: "Salud",
    competency:
      "Describe a symptom, point at where it hurts, and buy the right thing at a pharmacy without a shared language for anatomy.",
    situations: ["pharmacy", "clinic", "hotel room phone", "street"],
    coreMoves: ["state_symptom", "locate_pain", "state_duration", "state_allergy", "ask_for_medicine", "ask_for_doctor"],
    contrastHook: true,
    contrastFocus:
      "Whether pain is possessed ('I have pain'), experienced dative ('to-me it hurts'), or predicated of the body part ('my head hurts me'); body-part vocabulary that takes possessive marking; how duration ('for three days') attaches.",
    roleplaySeed:
      "You are a pharmacist. The customer is unwell. Ask where it hurts and how long, offer one option, and ask about allergies before you sell anything.",
    pronunciationTargets: ["request_phrase", "question_phrase"]
  },
  {
    id: "connection",
    title: "Connection",
    titleEs: "Conexión",
    competency:
      "Get online, get a phone working, and — the reason this app exists — walk up to a stranger and ask if you can have a conversation with them.",
    // Named for Tom's Taiwan mission in the 1980s: kids walking up to a
    // foreigner and asking exactly that question is the product's origin
    // insight, so the social ask lives in the same module as the wifi password
    // rather than being demoted to a "someday" lesson.
    situations: ["café", "phone shop", "hotel lobby", "park bench", "campus"],
    coreMoves: [
      "ask_wifi",
      "ask_password",
      "ask_sim_card",
      "ask_for_conversation",
      "offer_language_exchange",
      "exchange_contact",
      "close_warmly"
    ],
    contrastHook: true,
    contrastFocus:
      "How you address a stranger you have no relationship with (honorifics, age-based address, whether an opener needs an apology first); borrowed tech words that keep or lose their English shape; how an invitation is softened so it is not a demand.",
    roleplaySeed:
      "You are a friendly local student sitting in a café. A traveler approaches and asks whether they can practise your language with you. Be pleased but a little shy: ask why they are learning, and keep your turns short so they do the talking.",
    pronunciationTargets: ["question_phrase", "greet_phrase"]
  },
  {
    id: "time-plans",
    title: "Time & plans",
    titleEs: "Tiempo y planes",
    competency:
      "Say when, agree a place, and confirm a plan that both people will actually turn up to.",
    situations: ["making plans", "tour desk", "restaurant booking", "meeting a friend"],
    coreMoves: ["ask_time", "say_clock_time", "say_day", "propose_meeting", "agree", "confirm_plan"],
    contrastHook: true,
    contrastFocus:
      "Clock time told by halves and quarters relative to the NEXT hour; 24-hour vs 12-hour speech; future expressed by tense, by an auxiliary, or by the present plus a time word; the word order of 'tomorrow at six'.",
    roleplaySeed:
      "You are a new acquaintance arranging to meet tomorrow. Propose a time that does not suit, so the learner has to counter-propose, then confirm the final plan back to them.",
    pronunciationTargets: ["number_phrase", "question_phrase"]
  },
  {
    id: "reactions",
    title: "Reactions",
    titleEs: "Reacciones",
    competency:
      "React like a person and not a phrasebook: delicious, beautiful, I love it, that's too much, thank you so much.",
    situations: ["at a meal", "sightseeing", "receiving a gift", "any warm moment"],
    coreMoves: ["compliment_food", "compliment_place", "express_delight", "express_surprise", "thank_warmly", "decline_gracefully"],
    contrastHook: true,
    contrastFocus:
      "Adjectives that must agree with the thing praised; whether a compliment obliges a ritual deflection in reply; fixed exclamations with no literal translation, and the register that makes them sound warm rather than theatrical.",
    roleplaySeed:
      "You are a host who has just cooked for the learner. Fish for compliments gently, offer a second helping, and react to how they say it — let them practise both praising and declining more food.",
    pronunciationTargets: ["polite_close_phrase", "thank_phrase"]
  }
] as const satisfies readonly TutorModule[];

/** Every module the tutor knows — a typo in a module id is a compile error. */
export type TutorModuleId = (typeof MODULES)[number]["id"];

export const TUTOR_MODULES: readonly TutorModule[] = MODULES;

/** Picker order = curriculum order. The list is short enough to be the menu. */
export const TUTOR_MODULE_IDS: readonly TutorModuleId[] = MODULES.map((m) => m.id);

const BY_ID: ReadonlyMap<string, TutorModule> = new Map(MODULES.map((m) => [m.id, m]));

export function isTutorModuleId(value: unknown): value is TutorModuleId {
  return typeof value === "string" && BY_ID.has(value);
}

export function getTutorModule(id: string): TutorModule | undefined {
  return BY_ID.get(id);
}

/** 1-based position, the way the plan and the picker number them. */
export function tutorModuleNumber(id: string): number {
  return TUTOR_MODULE_IDS.indexOf(id as TutorModuleId) + 1;
}
