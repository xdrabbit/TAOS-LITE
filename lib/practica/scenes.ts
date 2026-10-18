export type PracticaLanguage = "en" | "es";

export interface LocalizedText {
  learner: string;
  target: string;
}

export interface PracticaScene {
  id: string;
  title: LocalizedText;
  setup: readonly [string, string, ...string[]];
  npc: {
    role: string;
    wants: string;
  };
  targetPhrases: readonly [string, string, string, ...string[]];
  doneCondition: string;
  debrief: string;
  backgroundUrl: string | null;
  gradient: string;
}

export interface PracticaTrip {
  id: string;
  title: LocalizedText;
  learnerLanguage: PracticaLanguage;
  targetLanguage: PracticaLanguage;
  scenes: readonly PracticaScene[];
}

export const ARRIVAL_IN_UTAH: PracticaTrip = {
  id: "llegada-a-utah",
  title: { learner: "Llegada a Utah", target: "Arrival in Utah" },
  learnerLanguage: "es",
  targetLanguage: "en",
  scenes: [
    {
      id: "salt-lake-airport",
      title: { learner: "Aeropuerto de Salt Lake", target: "Salt Lake City Airport" },
      setup: [
        "Acabas de aterrizar en Salt Lake City y estás buscando tu equipaje.",
        "Liz te prepara para una pregunta breve de aduanas y luego te deja hablar con el agente."
      ],
      npc: {
        role: "Customs and baggage officer",
        wants: "Confirm why the traveler is visiting, how long they will stay, and which carousel has their bag."
      },
      targetPhrases: [
        "I'm here on vacation.",
        "I'm staying for five days.",
        "Where is baggage claim?",
        "My bag didn't arrive."
      ],
      doneCondition:
        "The learner answers the purpose and length-of-stay questions and asks where to collect the bag.",
      debrief:
        "Muy bien. Repasa si dijiste vacation con claridad y si usaste I'm staying for para hablar de la duración. En el aeropuerto, una frase corta y directa funciona mejor que traducir cada palabra. Practica una vez más: I'm here on vacation. I'm staying for five days. Where is baggage claim? Si tu maleta falta, My bag didn't arrive es suficiente para empezar. Respira, mira al agente y habla un poco más despacio de lo normal.",
      backgroundUrl: null,
      gradient: "from-sky-950 via-slate-800 to-amber-950"
    },
    {
      id: "rental-car",
      title: { learner: "Renta de carro", target: "Rental Car Counter" },
      setup: [
        "Llegas al mostrador con una reservación y tu licencia en la mano.",
        "Liz te ayuda a confirmar el carro, entender el seguro y preguntar dónde devolverlo."
      ],
      npc: {
        role: "Rental car clerk",
        wants: "Find the reservation, offer insurance, and explain the fuel and return terms."
      },
      targetPhrases: [
        "I have a reservation.",
        "Is insurance included?",
        "Do I return it with a full tank?",
        "Where do I drop off the car?"
      ],
      doneCondition:
        "The learner confirms the reservation and gets clear answers about insurance, fuel, and return.",
      debrief:
        "Buen trabajo. En un mostrador de renta, las preguntas cerradas te protegen de sorpresas: Is insurance included? y Do I return it with a full tank? Escucha included y full tank; son las palabras que cambian el costo. Para cerrar, pregunta Where do I drop off the car? No necesitas una frase larga. Si no entiendes, di Could you say that again, please? Tu meta no es sonar perfecto: es salir con las condiciones claras.",
      backgroundUrl: null,
      gradient: "from-zinc-950 via-blue-950 to-orange-950"
    },
    {
      id: "gas-station",
      title: { learner: "Gasolinera", target: "Gas Station" },
      setup: [
        "La tarjeta no funciona en la bomba porque pide un código postal de Estados Unidos.",
        "Entras a la tienda y Liz te deja resolverlo con la persona de la caja."
      ],
      npc: {
        role: "Gas station cashier",
        wants: "Learn the pump number, take a prepayment, and explain how unused money is refunded."
      },
      targetPhrases: [
        "The pump won't accept my card.",
        "I'm at pump six.",
        "Can I prepay forty dollars?",
        "Do I get a refund if I use less?"
      ],
      doneCondition:
        "The learner identifies the pump, prepays an amount, and confirms what happens to unused money.",
      debrief:
        "Lo resolviste. Pump six identifica la bomba, y prepay significa pagar antes de cargar. La frase más útil aquí es The pump won't accept my card; explica el problema sin culpar a nadie. Después puedes decir Can I prepay forty dollars? Si cargas menos, confirma Do I get a refund if I use less? En Estados Unidos, estas conversaciones suelen ser rápidas. Di primero el número de la bomba y luego la cantidad.",
      backgroundUrl: null,
      gradient: "from-indigo-950 via-violet-950 to-rose-950"
    },
    {
      id: "zion-entrance",
      title: { learner: "Entrada al parque Zion", target: "Zion Park Entrance" },
      setup: [
        "Llegas a la entrada de Zion y no sabes qué pase te conviene.",
        "Liz te presenta al ranger para que compres la entrada y preguntes por el transporte del parque."
      ],
      npc: {
        role: "National Park ranger",
        wants: "Sell the right pass, explain its validity, and direct the visitor to the shuttle."
      },
      targetPhrases: [
        "I'd like a park pass.",
        "How long is it valid?",
        "Does this pass cover everyone in the car?",
        "Where do we catch the shuttle?"
      ],
      doneCondition:
        "The learner chooses a pass and understands its validity, coverage, and the shuttle location.",
      debrief:
        "Excelente. I'd like suena amable y natural al pedir algo. Las dos preguntas que evitan confusión son How long is it valid? y Does this pass cover everyone in the car? Cover aquí significa incluir, no tapar. Antes de avanzar, pregunta Where do we catch the shuttle? En un parque, repite el lugar o la hora que escuchaste para confirmar. Si el ranger habla rápido, Could you show me on the map? es una salida muy útil.",
      backgroundUrl: null,
      gradient: "from-red-950 via-orange-900 to-sky-950"
    },
    {
      id: "diner",
      title: { learner: "Un diner", target: "A Diner" },
      setup: [
        "Terminas el día en un diner y quieres pedir algo sencillo sin sentir prisa.",
        "Liz te ayuda con una modificación del plato y luego deja que la persona mesera tome tu orden."
      ],
      npc: {
        role: "Diner server",
        wants: "Take a drink and meal order, clarify the side dish, and check whether anything else is needed."
      },
      targetPhrases: [
        "Could I have some water, please?",
        "I'd like the burger.",
        "Can I get a salad instead of fries?",
        "That's all, thank you.",
        "Could we have the check, please?"
      ],
      doneCondition:
        "The learner orders a drink and meal, requests one substitution, and asks for the check.",
      debrief:
        "Muy bien. Could I have y I'd like son fórmulas seguras y amables para ordenar. Para cambiar una guarnición, usa instead of: Can I get a salad instead of fries? Cuando termines de pedir, That's all, thank you cierra el turno con claridad. Al final, Could we have the check, please? pide la cuenta; bill también se entiende, pero check es muy común aquí. Hoy ya atravesaste cinco escenas reales: prioriza que te entiendan y deja la perfección para la segunda vuelta.",
      backgroundUrl: null,
      gradient: "from-stone-950 via-amber-950 to-red-950"
    }
  ]
};

export const PRACTICA_TRIPS: readonly PracticaTrip[] = [ARRIVAL_IN_UTAH];

export function practicaTrip(id: string): PracticaTrip | null {
  return PRACTICA_TRIPS.find((trip) => trip.id === id) ?? null;
}

export function practicaScene(tripId: string, sceneIndex: number): PracticaScene | null {
  const trip = practicaTrip(tripId);
  return trip?.scenes[sceneIndex] ?? null;
}
