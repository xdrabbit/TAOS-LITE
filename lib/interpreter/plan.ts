// What one Interpreter-mode session IS, per engine: how many legs, which
// direction and voice each has, and whether it carries the briefing. Pure and
// isomorphic — the mint route builds a plan and turns each leg into a provider
// session; the tests read the same plan.

import {
  buildInterpreterBriefing,
  buildLegBriefing,
  type InterpreterDirection,
  type InterpreterPair
} from "./briefing";
import {
  engineTakesBriefing,
  interpreterLegCount,
  interpreterModel,
  interpreterVoice,
  pairDirections,
  type InterpreterEngine
} from "./engine";

export interface LegPlan {
  /**
   * The direction this leg interprets. `null` = one session both ways
   * (TAOS_INTERPRETER_LEGS=1): it hears both people and answers each in the
   * other's language, and its captions have no side.
   */
  direction: InterpreterDirection | null;
  /** The stock voice it speaks in. Null where the engine takes none. */
  voice: string | null;
  /** The briefing it is given. Null where the engine takes none. */
  instructions: string | null;
}

export interface InterpreterPlan {
  engine: InterpreterEngine;
  model: string;
  pair: InterpreterPair;
  legs: LegPlan[];
  /** Did the provider session get the briefing at all? */
  briefed: boolean;
}

export function buildInterpreterPlan(opts: {
  engine: InterpreterEngine;
  pair: InterpreterPair;
  /** The founders' context block, already loaded. "" = none. */
  context: string;
  env?: Record<string, string | undefined>;
}): InterpreterPlan {
  const env = opts.env ?? process.env;
  const { engine, pair, context } = opts;
  const model = interpreterModel(engine, env);
  const briefed = engineTakesBriefing(engine);
  const liveModel = engine === "openai-live";
  const directions = pairDirections(pair);

  if (interpreterLegCount(engine, env.TAOS_INTERPRETER_LEGS) === 1) {
    return {
      engine,
      model,
      pair,
      briefed,
      legs: [
        {
          direction: null,
          // One session has one voice: voice 1's.
          voice: interpreterVoice(engine, directions[0], env),
          instructions: buildInterpreterBriefing({ pair, context, liveModel })
        }
      ]
    };
  }

  return {
    engine,
    model,
    pair,
    briefed,
    legs: directions.map((direction) => ({
      direction,
      voice: engine === "openai-translate" ? null : interpreterVoice(engine, direction, env),
      instructions: briefed ? buildLegBriefing({ direction, context, liveModel }) : null
    }))
  };
}
